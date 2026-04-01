#!/usr/bin/env node
/**
 * Manual Winner Selection Script
 *
 * Designates a charity as the weekly winner for a given week.
 * Usage: node backend/scripts/select-winner.js --charity-id=<uuid> --week-start=YYYY-MM-DD
 *    or: npm run select-winner -- --charity-id=<uuid> --week-start=YYYY-MM-DD
 *
 * Tables: charity_week_winner, charity_applications. Run migration add-charity-week-winner.sql if needed.
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

function parseArgs() {
  const args = process.argv.slice(2);
  let charityId = null;
  let weekStart = null;
  for (const a of args) {
    if (a.startsWith('--charity-id=')) {
      charityId = a.slice('--charity-id='.length).trim();
    } else if (a.startsWith('--week-start=')) {
      weekStart = a.slice('--week-start='.length).trim();
    }
  }
  return { charityId, weekStart };
}

function isValidMonday(dateStr) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!match) return false;
  const y = parseInt(match[1], 10);
  const m = parseInt(match[2], 10) - 1;
  const d = parseInt(match[3], 10);
  const date = new Date(Date.UTC(y, m, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m || date.getUTCDate() !== d) {
    return false;
  }
  return date.getUTCDay() === 1;
}

function formatWeekEnd(weekStartStr) {
  const [y, m, d] = weekStartStr.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const yy = end.getUTCFullYear();
  const mm = String(end.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(end.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

async function main() {
  const { charityId, weekStart } = parseArgs();

  // Step 1 — Validate inputs
  if (!charityId || !weekStart) {
    console.error('Error: Both --charity-id=<uuid> and --week-start=YYYY-MM-DD are required.');
    process.exit(1);
  }
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(charityId)) {
    console.error('Error: --charity-id must be a valid UUID.');
    process.exit(1);
  }
  if (!isValidMonday(weekStart)) {
    console.error('Error: --week-start must be a valid date in YYYY-MM-DD format and must be a Monday.');
    process.exit(1);
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  try {
    // Step 2 — Safety check
    const existing = await pool.query(
      'SELECT 1 FROM charity_week_winner WHERE week_start = $1::date LIMIT 1',
      [weekStart]
    );
    if (existing.rows.length > 0) {
      console.log(`Winner already exists for week ${weekStart}. Exiting.`);
      await pool.end();
      process.exit(0);
    }

    // Step 3 — Verify charity exists and is approved
    const charityResult = await pool.query(
      `SELECT id, charity_name, contact_email
       FROM charity_applications
       WHERE id = $1::uuid AND status = 'approved'`,
      [charityId]
    );
    if (charityResult.rows.length === 0) {
      console.error('Error: No approved charity application found with the given charity-id.');
      await pool.end();
      process.exit(1);
    }
    const charity = charityResult.rows[0];
    const { charity_name: charityName, contact_email: contactEmail } = charity;

    // Step 4 — Insert the winner
    await pool.query(
      `INSERT INTO charity_week_winner (
        charity_application_id,
        week_start,
        selection_method,
        notification_sent_at
      ) VALUES (
        $1::uuid,
        $2::date,
        'manual',
        NOW()
      )`,
      [charityId, weekStart]
    );

    // Step 5 — Send winner notification email
    const weekEnd = formatWeekEnd(weekStart);
    let notificationSent = false;
    if (contactEmail && emailService && emailService.isEmailConfigured()) {
      const emailResult = await emailService.sendCharityWeekWinnerEmail(
        contactEmail,
        charityName,
        weekStart,
        weekEnd
      );
      notificationSent = emailResult.success;
      if (!emailResult.success) {
        console.error('❌ Winner notification email failed:', emailResult.error);
        console.warn('⚠️ Winner was recorded in the database, but the notification may not have been sent.');
      }
    } else {
      console.warn('⚠️ Email not configured or no contact email; winner notification was not sent.');
    }

    // Step 6 — Success output
    console.log(`Winner selected: ${charityName} for week of ${weekStart}. Notification sent to ${contactEmail}.`);
    if (!notificationSent && contactEmail) {
      console.warn('⚠️ The notification may not have been sent. Please verify or resend manually.');
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error('❌ Error:', err.message);
    await pool.end();
    process.exit(1);
  }
}

main();
