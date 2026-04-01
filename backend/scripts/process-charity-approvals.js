#!/usr/bin/env node
/**
 * Charity Approval Processing Script
 *
 * Usage: node process-charity-approvals.js --id=<charity_applications.id>
 *
 * For the given application:
 * 1. Set status = 'approved'
 * 2. Set reviewed_at = NOW()
 * 3. Insert into charity_week_pool (charity_application_id, week_start)
 *    where week_start = next Monday from created_at in America/Los_Angeles
 * 4. Send approval email
 *
 * Idempotent: Only processes rows with reviewed_at IS NULL.
 * Schema: charity_applications (id UUID), charity_week_pool (charity_application_id UUID, week_start DATE).
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

let emailService = null;
try {
  emailService = require('../services/emailService');
} catch (e) {
  console.warn('⚠️ Email service not available:', e.message);
}

function getNextMondayDate(createdAt) {
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
  const laDateStr = created.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const [y, m, d] = laDateStr.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const day = utcNoon.getUTCDay();
  const add = day === 0 ? 1 : 8 - day;
  const nextMonday = new Date(utcNoon);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + add);
  const yy = nextMonday.getUTCFullYear();
  const mm = String(nextMonday.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(nextMonday.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function run() {
  const idArg = process.argv.find(a => a.startsWith('--id='));
  if (!idArg) {
    console.error('❌ --id=<charity_applications.id> is required');
    console.error('   Usage: node process-charity-approvals.js --id=<uuid>');
    process.exit(1);
  }
  const targetId = idArg.split('=')[1].trim();

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  try {
    const { rows } = await pool.query(
      `SELECT id, charity_name, contact_email, created_at
       FROM charity_applications
       WHERE id = $1
         AND reviewed_at IS NULL`,
      [targetId]
    );

    if (rows.length === 0) {
      console.error(`❌ No unprocessed application found with id=${targetId}. It may not exist or has already been processed.`);
      process.exit(1);
    }

    const { id, charity_name, contact_email, created_at } = rows[0];

    await pool.query(
      `UPDATE charity_applications SET status = 'approved', reviewed_at = NOW() WHERE id = $1`,
      [id]
    );
    console.log(`✅ Set status=approved and reviewed_at for application ${id}`);

    const weekStart = getNextMondayDate(created_at);
    const weekStartLabel = emailService
      ? emailService.getNextMondayLabel(created_at)
      : weekStart;

    await pool.query(
      `INSERT INTO charity_week_pool (charity_application_id, week_start)
       VALUES ($1, $2::date)
       ON CONFLICT (charity_application_id, week_start) DO NOTHING`,
      [id, weekStart]
    );
    console.log(`✅ Inserted charity_week_pool entry for application ${id}, week_start ${weekStart}`);

    if (contact_email && emailService && emailService.isEmailConfigured()) {
      const emailResult = await emailService.sendCharityApprovalEmail(
        contact_email,
        charity_name,
        weekStartLabel
      );
      if (emailResult.success) {
        console.log(`✅ Approval email sent to ${contact_email}`);
      } else {
        console.error(`❌ Approval email failed for ${contact_email}:`, emailResult.error);
      }
    } else if (!contact_email) {
      console.warn(`⚠️ No contact_email for application ${id}, skip email.`);
    } else {
      console.warn(`⚠️ Email not configured, skip approval email.`);
    }
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  console.error('❌ Script failed:', err);
  process.exit(1);
});
