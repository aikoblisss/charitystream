#!/usr/bin/env node
/**
 * Sponsor Rejection Processing Script
 *
 * Processes campaigns where sponsor_campaigns.status = 'rejected'
 * AND sponsor_campaigns.rejection_processed = FALSE.
 *
 * For each:
 * - Non-recurring (card-on-file): detach saved payment method, set sponsor_billing.status = 'canceled'
 * - Recurring (stripe_subscription_id): cancel subscription, set sponsor_billing.status = 'canceled'
 * - Then set rejection_processed = TRUE and send rejection email.
 *
 * Idempotency: Only marks processed after successful Stripe action. On Stripe failure, does not
 * mark processed and does not send email, so the next run can retry.
 *
 * Does NOT modify sponsor_donations or any leaderboard/billing-creation logic.
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

function parseCliSponsorId() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--id' && args[i + 1]) return args[i + 1].trim();
    const match = args[i].match(/^--id=(.+)$/);
    if (match) return match[1].trim();
  }
  return null;
}

const onlyId = parseCliSponsorId();
if (!onlyId) {
  console.error('❌ --id is required. Usage: node process-sponsor-rejections.js --id <sponsor_campaign_id>');
  process.exit(1);
}

async function run() {
  if (!stripe) {
    console.error('❌ STRIPE_SECRET_KEY required');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  try {
    await pool.query(
      `UPDATE sponsor_campaigns SET status = 'rejected' WHERE id = $1::uuid AND status = 'pending_approval'`,
      [onlyId]
    );

    const { rows } = await pool.query(
      `SELECT sc.id AS campaign_id,
              sc.status AS campaign_status,
              sa.contact_email,
              sa.organization_legal_name,
              sb.id AS billing_id,
              sb.stripe_payment_intent_id,
              sb.stripe_subscription_id,
              sb.status AS billing_status
       FROM sponsor_campaigns sc
       JOIN sponsor_billing sb ON sb.sponsor_campaign_id = sc.id
       JOIN sponsor_accounts sa ON sa.id = sc.sponsor_account_id
       WHERE LOWER(TRIM(sc.status)) = 'rejected'
         AND (sc.rejection_processed IS NULL OR sc.rejection_processed = FALSE)
         AND sc.id = $1::uuid
       ORDER BY sc.id`,
      [onlyId]
    );

    if (rows.length === 0) {
      console.log('ℹ️ No matching sponsor campaign to process for this --id (not pending→rejected, or already processed, or not found). Nothing to do.');
      return;
    }

    console.log(`📋 Found ${rows.length} rejected campaign(s) to process.`);

    for (const row of rows) {
      const {
        campaign_id,
        contact_email,
        organization_legal_name,
        billing_id,
        stripe_payment_intent_id,
        stripe_subscription_id,
        billing_status
      } = row;

      const orgName = organization_legal_name || 'Sponsorship';

      try {
        const isRecurring = Boolean(stripe_subscription_id);

        if (isRecurring) {
          if (billing_status === 'canceled') {
            console.log(`ℹ️ Campaign ${campaign_id} billing already canceled, marking processed.`);
          } else {
            await stripe.subscriptions.cancel(stripe_subscription_id);
            console.log(`✅ Canceled subscription ${stripe_subscription_id} for campaign ${campaign_id}`);
            await pool.query(
              `UPDATE sponsor_billing SET status = 'canceled' WHERE id = $1`,
              [billing_id]
            );
          }
        } else {
          // Non-recurring (card-on-file): detach saved card, set billing canceled
          if (billing_status === 'canceled') {
            console.log(`ℹ️ Campaign ${campaign_id} billing already canceled, marking processed.`);
          } else {
            const saRow = await pool.query(
              `SELECT stripe_customer_id FROM sponsor_accounts WHERE id = (SELECT sponsor_account_id FROM sponsor_campaigns WHERE id = $1)`,
              [campaign_id]
            );
            const stripeCustomerId = saRow.rows[0]?.stripe_customer_id;
            if (stripeCustomerId) {
              const pmList = await stripe.paymentMethods.list({
                customer: stripeCustomerId,
                type: 'card',
                limit: 1
              });
              if (pmList.data.length > 0) {
                await stripe.paymentMethods.detach(pmList.data[0].id);
                console.log(`✅ Detached payment method for customer ${stripeCustomerId} (campaign ${campaign_id})`);
              }
            }
            await pool.query(
              `UPDATE sponsor_billing SET status = 'canceled' WHERE id = $1`,
              [billing_id]
            );
            console.log(`✅ Set sponsor_billing to canceled for campaign ${campaign_id}`);
          }
        }

        await pool.query(
          `UPDATE sponsor_campaigns SET rejection_processed = TRUE WHERE id = $1`,
          [campaign_id]
        );
        console.log(`✅ Marked campaign ${campaign_id} rejection_processed = TRUE`);

        if (contact_email && emailService && emailService.isEmailConfigured()) {
          const emailResult = await emailService.sendSponsorRejectionEmail(contact_email, orgName);
          if (emailResult.success) {
            console.log(`✅ Rejection email sent to ${contact_email}`);
          } else {
            console.error(`❌ Rejection email failed for ${contact_email}:`, emailResult.error);
          }
        } else if (!contact_email) {
          console.warn(`⚠️ No contact_email for campaign ${campaign_id}, skip email.`);
        } else {
          console.warn(`⚠️ Email not configured, skip rejection email.`);
        }
      } catch (err) {
        console.error(`❌ Failed to process campaign ${campaign_id}:`, err.message);
        console.error('   Not marking rejection_processed – will retry on next run.');
      }
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
