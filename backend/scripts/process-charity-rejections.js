#!/usr/bin/env node
/**
 * Charity Rejection Processing Script
 *
 * Usage: node process-charity-rejections.js --id=<charity_applications.id>
 *
 * For the given application:
 * 1. Set status = 'rejected'
 * 2. Refund entry_payment_intent_id via Stripe (if present)
 * 3. Set reviewed_at = NOW()
 * 4. Send rejection email
 *
 * Idempotent: Only processes rows with reviewed_at IS NULL.
 * If Stripe refund fails, reviewed_at is not set so the script can be retried.
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

async function run() {
  if (!stripe) {
    console.error('❌ STRIPE_SECRET_KEY required');
    process.exit(1);
  }

  const idArg = process.argv.find(a => a.startsWith('--id='));
  if (!idArg) {
    console.error('❌ --id=<charity_applications.id> is required');
    console.error('   Usage: node process-charity-rejections.js --id=<uuid>');
    process.exit(1);
  }
  const targetId = idArg.split('=')[1].trim();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  try {
    const { rows } = await pool.query(
      `SELECT id, charity_name, contact_email, entry_payment_intent_id
       FROM charity_applications
       WHERE id = $1
         AND reviewed_at IS NULL`,
      [targetId]
    );

    if (rows.length === 0) {
      console.error(`❌ No unprocessed application found with id=${targetId}. It may not exist or has already been processed.`);
      process.exit(1);
    }

    const { id, charity_name, contact_email, entry_payment_intent_id } = rows[0];

    await pool.query(
      `UPDATE charity_applications SET status = 'rejected' WHERE id = $1`,
      [id]
    );
    console.log(`✅ Set status=rejected for application ${id}`);

    if (entry_payment_intent_id && entry_payment_intent_id.trim() !== '') {
      await stripe.refunds.create({ payment_intent: entry_payment_intent_id });
      console.log(`✅ Refunded payment_intent ${entry_payment_intent_id} for application ${id}`);
    } else {
      console.log(`ℹ️ Application ${id} has no entry_payment_intent_id, skipping refund.`);
    }

    await pool.query(
      `UPDATE charity_applications SET reviewed_at = NOW() WHERE id = $1`,
      [id]
    );
    console.log(`✅ Set reviewed_at for application ${id}`);

    if (contact_email && emailService && emailService.isEmailConfigured()) {
      const emailResult = await emailService.sendCharityRejectionEmail(contact_email, charity_name);
      if (emailResult.success) {
        console.log(`✅ Rejection email sent to ${contact_email}`);
      } else {
        console.error(`❌ Rejection email failed for ${contact_email}:`, emailResult.error);
      }
    } else if (!contact_email) {
      console.warn(`⚠️ No contact_email for application ${id}, skip email.`);
    } else {
      console.warn(`⚠️ Email not configured, skip rejection email.`);
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
