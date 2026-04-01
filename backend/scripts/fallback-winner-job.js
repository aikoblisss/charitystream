#!/usr/bin/env node
/**
 * Saturday Fallback Winner Selection Job
 *
 * Runs every Saturday 8:00 PM UTC (12:00 PM PST / 1:00 PM PDT) to ensure
 * the upcoming week has a winner. If no manual winner was set, auto-selects
 * one from the pool.
 *
 * Usage: node backend/scripts/fallback-winner-job.js
 *    or: npm run fallback-winner-job
 *    or: GET /api/system/fallback-winner-selection (Vercel cron)
 *
 * Tables: charity_week_winner, charity_week_pool, charity_applications.
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

/**
 * Next Monday from "today" in America/Los_Angeles, as YYYY-MM-DD.
 */
function getNextMondayYYYYMMDD() {
  const ptDateStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const [y, m, d] = ptDateStr.split('-').map(Number);
  const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  const day = utcNoon.getUTCDay();
  const add = day === 0 ? 1 : day === 1 ? 7 : 8 - day;
  const nextMonday = new Date(utcNoon);
  nextMonday.setUTCDate(nextMonday.getUTCDate() + add);
  const yy = nextMonday.getUTCFullYear();
  const mm = String(nextMonday.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(nextMonday.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
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

/**
 * Select a fallback winner for the upcoming week if one hasn't been chosen yet.
 * Does DB work only — caller is responsible for sending the notification email
 * and stamping notification_sent_at on success.
 *
 * @param {import('@neondatabase/serverless').Pool} [externalPool]
 * @returns {{ success: boolean, skipped?: boolean, reason?: string, charityApplicationId?: string, charityName?: string, contactEmail?: string, weekStart?: string, weekEnd?: string }}
 */
async function runFallbackWinnerSelection(externalPool) {
  const ownPool = !externalPool;
  const pool = externalPool || new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  try {
    const nextMonday = getNextMondayYYYYMMDD();

    // Step 1 — Check if winner already exists for upcoming week
    const existing = await pool.query(
      'SELECT id FROM charity_week_winner WHERE week_start = $1::date LIMIT 1',
      [nextMonday]
    );
    if (existing.rows.length > 0) {
      console.log(`[FALLBACK-WINNER] Winner already exists for week of ${nextMonday}. Skipping.`);
      return { success: true, skipped: true, reason: 'winner_exists' };
    }

    // Step 2 — Try selecting from this week's pool (pool entries for next Monday)
    let charity = null;
    const thisWeekResult = await pool.query(
      `SELECT cwp.charity_application_id, ca.charity_name, ca.contact_email
       FROM charity_week_pool cwp
       JOIN charity_applications ca ON ca.id = cwp.charity_application_id
       WHERE cwp.week_start = $1::date
       ORDER BY random()
       LIMIT 1`,
      [nextMonday]
    );
    if (thisWeekResult.rows.length > 0) {
      charity = thisWeekResult.rows[0];
    }

    // Step 3 — If no result, try any past pool entries
    if (!charity) {
      const pastResult = await pool.query(
        `SELECT cwp.charity_application_id, ca.charity_name, ca.contact_email
         FROM charity_week_pool cwp
         JOIN charity_applications ca ON ca.id = cwp.charity_application_id
         WHERE cwp.week_start < $1::date
         ORDER BY random()
         LIMIT 1`,
        [nextMonday]
      );
      if (pastResult.rows.length > 0) {
        charity = pastResult.rows[0];
      }
    }

    if (!charity) {
      console.log('[FALLBACK-WINNER] No charities found in system. Donations will accumulate until a charity is selected.');
      return { success: true, skipped: true, reason: 'no_charities' };
    }

    const { charity_application_id: charityApplicationId, charity_name: charityName, contact_email: contactEmail } = charity;
    const weekEnd = formatWeekEnd(nextMonday);

    // Step 4 — Insert winner (notification_sent_at intentionally omitted; caller stamps it only on email success)
    await pool.query(
      `INSERT INTO charity_week_winner (
        charity_application_id,
        week_start,
        selection_method
      ) VALUES ($1::uuid, $2::date, 'automatic')`,
      [charityApplicationId, nextMonday]
    );

    console.log(`[FALLBACK-WINNER] Winner selected: ${charityName} for week of ${nextMonday}`);

    return {
      success: true,
      skipped: false,
      charityApplicationId,
      charityName,
      contactEmail,
      weekStart: nextMonday,
      weekEnd
    };

  } finally {
    if (ownPool) await pool.end();
  }
}

// Run when executed directly
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  try {
    const result = await runFallbackWinnerSelection(pool);

    if (result.success && !result.skipped) {
      // Send winner notification email and stamp notification_sent_at only on success
      if (result.contactEmail && emailService && emailService.isEmailConfigured()) {
        const emailResult = await emailService.sendCharityWeekWinnerEmail(
          result.contactEmail,
          result.charityName,
          result.weekStart,
          result.weekEnd,
          { automatic: true }
        );
        if (emailResult.success) {
          await pool.query(
            'UPDATE charity_week_winner SET notification_sent_at = NOW() WHERE week_start = $1::date',
            [result.weekStart]
          );
          console.log(`[FALLBACK-WINNER] Notification sent to ${result.contactEmail}`);
        } else {
          console.error('❌ Winner notification email failed:', emailResult.error);
          console.warn('⚠️ Winner was recorded in the database, but the notification was not sent.');
        }
      } else {
        console.warn('⚠️ Email not configured or no contact email; winner notification was not sent.');
      }
      console.log(`[FALLBACK-WINNER] Done. ${result.charityName} selected for week of ${result.weekStart}.`);
    } else if (result.skipped) {
      console.log(`[FALLBACK-WINNER] Skipped: ${result.reason}`);
    }

    process.exit(0);
  } catch (err) {
    console.error('❌ [FALLBACK-WINNER] Error:', err.message);
    console.error('❌ [FALLBACK-WINNER] Stack:', err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { runFallbackWinnerSelection };
}
