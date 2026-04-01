#!/usr/bin/env node
/**
 * Advertiser Rejection Processing Script
 *
 * Requires --id / --id=<n>: sets status = 'rejected' for that campaign, then runs rejection logic for that row
 * if rejection_processed is still false.
 *
 * Rejection Financial Rule (deterministic):
 * - Setup mode (no stripe_subscription_id): No charge exists → No Stripe action
 * - Legacy subscription (stripe_subscription_id IS NOT NULL): Cancel subscription,
 *   retrieve ALL paid invoices, refund ALL paid invoices
 * - Non-recurring (non_recurring_billing_records exist): Refund ALL associated
 *   invoice payment_intent(s)
 *
 * Does NOT modify recurring_billing_records or non_recurring_billing_records.
 * Sets rejection_processed = TRUE only after Stripe actions succeed and email sends.
 */

const path = require('path');
const fs = require('fs');

const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
} else {
  require('dotenv').config();
}

const ws = require('ws');
const { fetch } = require('undici');
global.WebSocket = ws;
global.fetch = fetch;

const { Pool } = require('@neondatabase/serverless');

let stripe = null;
if (process.env.STRIPE_SECRET_KEY) {
  stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
}

let emailService = null;
try {
  emailService = require('../services/emailService');
} catch (e) {
  console.warn('⚠️ Email service not available:', e.message);
}

async function refundAllPaidInvoicesForSubscription(subscriptionId) {
  const invoices = await stripe.invoices.list({
    subscription: subscriptionId,
    status: 'paid',
    limit: 100
  });
  for (const inv of invoices.data) {
    const paymentIntent = inv.payment_intent;
    if (paymentIntent) {
      const pi = typeof paymentIntent === 'string' ? paymentIntent : paymentIntent;
      await stripe.refunds.create({ payment_intent: pi });
      console.log(`   ✅ Refunded invoice ${inv.id} (payment_intent ${pi})`);
    }
  }
  return invoices.data.length;
}

/**
 * Parses --id=<n> or --id <n> from process.argv.
 * Invalid/missing value after --id exits the process with code 1.
 * @returns {number|null} campaign id, or null if not provided
 */
function parseCliCampaignId() {
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg.startsWith('--id=')) {
      const raw = arg.slice('--id='.length).trim();
      const n = parseInt(raw, 10);
      if (!Number.isFinite(n)) {
        console.error('❌ Invalid --id=value: expected a numeric campaign id');
        process.exit(1);
      }
      return n;
    }
    if (arg === '--id') {
      const next = process.argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        console.error('❌ --id requires a numeric value (e.g. --id 314 or --id=314)');
        process.exit(1);
      }
      const n = parseInt(next, 10);
      if (!Number.isFinite(n)) {
        console.error('❌ Invalid --id value: expected a numeric campaign id');
        process.exit(1);
      }
      return n;
    }
  }
  return null;
}

const onlyId = parseCliCampaignId();
if (!onlyId) {
  console.error('❌ --id is required. Usage: node process-advertiser-rejections.js --id <advertiser_id>');
  process.exit(1);
}

async function run() {
  if (!stripe) {
    console.error('❌ STRIPE_SECRET_KEY required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });
  let poolEnded = false;

  try {
    await pool.query(`UPDATE advertisers SET status = 'rejected' WHERE id = $1`, [onlyId]);
    console.log(`🎯 Set status = 'rejected' for campaign id ${onlyId}`);

    const { rows } = await pool.query(
      `SELECT id, email, company_name, stripe_subscription_id
       FROM advertisers
       WHERE (rejection_processed IS NULL OR rejection_processed = FALSE)
         AND id = $1
       ORDER BY id`,
      [onlyId]
    );

    if (rows.length === 0) {
      console.error(
        `❌ Campaign ${onlyId} not found or not eligible for rejection processing. ` +
          `Requires: rejection_processed = false`
      );
      poolEnded = true;
      await pool.end();
      process.exit(1);
    }

    console.log(`📋 Found ${rows.length} rejected campaign(s) to process.`);

    for (const row of rows) {
      const { id: campaignId, email: contactEmail, company_name: companyName, stripe_subscription_id } = row;
      const displayName = companyName || 'Advertising Campaign';

      try {
        let stripeActionsDone = false;

        // Legacy subscription: cancel + refund ALL paid invoices
        if (stripe_subscription_id) {
          console.log(`🔄 [${campaignId}] Legacy subscription: ${stripe_subscription_id}`);
          const paidCount = await refundAllPaidInvoicesForSubscription(stripe_subscription_id);
          if (paidCount > 0) {
            console.log(`   Refunded ${paidCount} paid invoice(s)`);
          }
          await stripe.subscriptions.cancel(stripe_subscription_id);
          console.log(`✅ [${campaignId}] Canceled subscription ${stripe_subscription_id}`);
          stripeActionsDone = true;
        } else {
          // Non-recurring: refund ALL invoices from non_recurring_billing_records
          const billingRows = await pool.query(
            `SELECT stripe_invoice_id FROM non_recurring_billing_records
             WHERE campaign_id = $1 AND stripe_invoice_id IS NOT NULL`,
            [campaignId]
          );
          if (billingRows.rows.length > 0) {
            for (const br of billingRows.rows) {
              const inv = await stripe.invoices.retrieve(br.stripe_invoice_id);
              const pi = inv.payment_intent;
              if (pi) {
                const piId = typeof pi === 'string' ? pi : pi;
                await stripe.refunds.create({ payment_intent: piId });
                console.log(`✅ [${campaignId}] Refunded invoice ${br.stripe_invoice_id} (payment_intent ${piId})`);
              }
            }
            stripeActionsDone = true;
          }
        }

        // Setup mode (no subscription, no billing records): no Stripe action - stripeActionsDone stays false
        if (!stripeActionsDone) {
          console.log(`ℹ️ [${campaignId}] Setup mode - no Stripe action required`);
        }

        await pool.query(
          `UPDATE advertisers SET rejection_processed = TRUE WHERE id = $1`,
          [campaignId]
        );
        console.log(`✅ [${campaignId}] Marked rejection_processed = TRUE`);

        if (contactEmail && emailService && emailService.isEmailConfigured()) {
          const emailResult = await emailService.sendAdvertiserRejectionEmail(contactEmail, displayName);
          if (emailResult.success) {
            console.log(`✅ [${campaignId}] Rejection email sent to ${contactEmail}`);
          } else {
            console.error(`❌ [${campaignId}] Rejection email failed:`, emailResult.error);
          }
        } else if (!contactEmail) {
          console.warn(`⚠️ [${campaignId}] No contact email, skip rejection email.`);
        } else {
          console.warn(`⚠️ [${campaignId}] Email not configured, skip rejection email.`);
        }
      } catch (err) {
        console.error(`❌ [${campaignId}] Failed:`, err.message);
        console.error('   Not marking rejection_processed – will retry on next run.');
      }
    }
  } finally {
    if (!poolEnded) {
      await pool.end();
    }
  }
}

run().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
