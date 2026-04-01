#!/usr/bin/env node
/**
 * Finalize Weekly Donations Job
 *
 * Monday 02:00 AM PT cron — closes out the previous week's donations.
 * Vercel cron schedule: "0 10 * * 1" (Monday 10:00 UTC = 02:00 AM PST).
 * During PDT this fires at 03:00 AM PT; that is acceptable — week boundary
 * is determined by date computation, not the exact fire time.
 *
 * Writes weekly_charity_allocation, transfer_intents, and stamps finalized_at
 * on weekly_donation_pool. Does not send emails, process Stripe, touch
 * donation_ledger, or select a winner.
 *
 * Usage: node backend/scripts/finalize-weekly-donations.js
 *    or: GET /api/system/finalize-weekly-donations (Vercel cron)
 *
 * Tables: weekly_donation_pool, charity_week_winner, weekly_charity_allocation, transfer_intents.
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

/**
 * Monday 00:00 America/Los_Angeles for a given date (replicated from server.js getBillingWeekStart).
 * Returns a Date (UTC) representing that moment.
 */
function getBillingWeekStart(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  });

  const parts = formatter.formatToParts(date);
  const laValues = {};
  parts.forEach(part => {
    if (part.type !== 'literal') {
      laValues[part.type] = part.value;
    }
  });

  const year = parseInt(laValues.year, 10);
  const month = parseInt(laValues.month, 10);
  const day = parseInt(laValues.day, 10);

  const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[laValues.weekday] ?? 1;

  const daysToMonday = weekday === 0 ? 6 : weekday - 1;

  const mondayDate = new Date(year, month - 1, day - daysToMonday);

  const mondayYear = mondayDate.getFullYear();
  const mondayMonth = mondayDate.getMonth() + 1;
  const mondayDay = mondayDate.getDate();

  const isDST = mondayMonth >= 3 && mondayMonth <= 11;
  const offsetHours = isDST ? 7 : 8;

  return new Date(Date.UTC(mondayYear, mondayMonth - 1, mondayDay, offsetHours, 0, 0, 0));
}

/**
 * Format a Date as YYYY-MM-DD for week_start (DATE).
 */
function toWeekStartString(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Run the finalize job. Uses the provided pool (e.g. from server) or creates one if not provided.
 * @param {import('@neondatabase/serverless').Pool} [externalPool] - Optional pool from server
 * @returns {{ success: boolean, skipped?: boolean, reason?: string, error?: string, weeksAccumulated?: number, sponsorTotal?: number, advertiserTotal?: number, totalAmount?: number, charityApplicationId?: string }}
 */
async function runFinalizeWeeklyDonations(externalPool) {
  const ownPool = !externalPool;
  const pool = externalPool || new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  const now = new Date();
  const currentMonday = getBillingWeekStart(now);
  const previousMonday = new Date(currentMonday);
  previousMonday.setUTCDate(previousMonday.getUTCDate() - 7);
  const previous_week_start = toWeekStartString(previousMonday);

  try {
    // 1. Idempotency — pool row for previous week
    const poolRow = await pool.query(
      'SELECT week_start, finalized_at FROM weekly_donation_pool WHERE week_start = $1::date LIMIT 1',
      [previous_week_start]
    );

    if (poolRow.rows.length === 0) {
      console.log(`[FINALIZE] No donation pool row found for week ${previous_week_start}, exiting.`);
      return { success: true, skipped: true, reason: 'no_pool_row' };
    }

    if (poolRow.rows[0].finalized_at != null) {
      console.log(`[FINALIZE] Week ${previous_week_start} already finalized, exiting.`);
      return { success: true, skipped: true, reason: 'already_finalized' };
    }

    // 2. Winner for previous week
    const winnerResult = await pool.query(
      'SELECT charity_application_id FROM charity_week_winner WHERE week_start = $1::date LIMIT 1',
      [previous_week_start]
    );

    if (winnerResult.rows.length === 0) {
      console.log(`[FINALIZE] No winner selected for week ${previous_week_start}, money will accumulate.`);
      return { success: true, skipped: true, reason: 'no_winner' };
    }

    const charityApplicationId = winnerResult.rows[0].charity_application_id;

    // 3. Single transaction: aggregate unfinalized → allocation → transfer_intent → stamp finalized_at
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // a. Sum all unfinalized weeks
      const sumResult = await client.query(`
        SELECT
          COALESCE(SUM(sponsor_total), 0)::numeric AS sponsor_total,
          COALESCE(SUM(advertiser_total), 0)::numeric AS advertiser_total,
          COALESCE(SUM(viewer_total), 0)::numeric AS viewer_total,
          COUNT(*)::integer AS weeks_count
        FROM weekly_donation_pool
        WHERE finalized_at IS NULL
      `);

      const row = sumResult.rows[0];
      const sponsorTotal = parseFloat(row.sponsor_total) || 0;
      const advertiserTotal = parseFloat(row.advertiser_total) || 0;
      const viewerTotal = parseFloat(row.viewer_total || 0);
      const totalAmount = sponsorTotal + advertiserTotal + viewerTotal;
      const weeksCount = parseInt(row.weeks_count, 10) || 0;

      // b. Insert weekly_charity_allocation (idempotency: ON CONFLICT DO NOTHING)
      await client.query(
        `INSERT INTO weekly_charity_allocation (
          week_start,
          charity_application_id,
          sponsor_amount,
          advertiser_amount,
          viewer_amount,
          total_amount,
          weeks_accumulated
        ) VALUES ($1::date, $2::uuid, $3, $4, $5, $6, $7)
        ON CONFLICT (week_start) DO NOTHING`,
        [previous_week_start, charityApplicationId, sponsorTotal, advertiserTotal, viewerTotal, totalAmount, weeksCount]
      );

      // c. Insert transfer_intent only if total_amount > 0
      if (totalAmount > 0) {
        await client.query(
          `INSERT INTO transfer_intents (week_start, recipient_type, amount, status)
           VALUES ($1::date, 'fiscal_sponsor', $2, 'pending')`,
          [previous_week_start, totalAmount]
        );
      }

      // d. Backfill charity_week_winner for all accumulated no-winner weeks so
      //    the donation_ledger → charity_week_winner JOIN resolves correctly for
      //    advertiser campaigns whose contributions landed in those weeks.
      await client.query(`
        INSERT INTO charity_week_winner (charity_application_id, week_start, selection_method)
        SELECT $1::uuid, wdp.week_start, 'accumulated'
        FROM weekly_donation_pool wdp
        LEFT JOIN charity_week_winner cww ON cww.week_start = wdp.week_start
        WHERE wdp.finalized_at IS NULL
          AND cww.week_start IS NULL
        ON CONFLICT DO NOTHING
      `, [charityApplicationId]);

      // e. Stamp all unfinalized rows
      await client.query(
        'UPDATE weekly_donation_pool SET finalized_at = NOW() WHERE finalized_at IS NULL'
      );

      await client.query('COMMIT');

      console.log('[FINALIZE] Finalized successfully:', {
        week: previous_week_start,
        weeksAccumulated: weeksCount,
        sponsorTotal: sponsorTotal.toFixed(2),
        advertiserTotal: advertiserTotal.toFixed(2),
        viewerTotal: viewerTotal.toFixed(2),
        totalAmount: totalAmount.toFixed(2),
        charityApplicationId
      });

      return {
        success: true,
        skipped: false,
        weeksAccumulated: weeksCount,
        sponsorTotal,
        advertiserTotal,
        viewerTotal,
        totalAmount,
        charityApplicationId
      };
    } catch (txErr) {
      await client.query('ROLLBACK');
      console.error('[FINALIZE] Transaction failed:', txErr.message);
      console.error('[FINALIZE] Full error:', txErr);
      throw txErr;
    } finally {
      client.release();
    }
  } finally {
    if (ownPool) {
      await pool.end();
    }
  }
}

// Run when executed directly
async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  try {
    const result = await runFinalizeWeeklyDonations(pool);
    if (result.success && !result.skipped) {
      console.log(
        `[FINALIZE] Done. ${result.weeksAccumulated} week(s) accumulated; ` +
        `sponsor_total=$${result.sponsorTotal?.toFixed(2)}, advertiser_total=$${result.advertiserTotal?.toFixed(2)}, viewer_total=$${result.viewerTotal?.toFixed(2)}, ` +
        `total=$${result.totalAmount?.toFixed(2)}; allocation to charity_application_id=${result.charityApplicationId}.`
      );

      // Send finalization email to winning charity
      if (result.charityApplicationId) {
        let emailService = null;
        try { emailService = require('../services/emailService'); } catch (e) {
          console.warn('[FINALIZE] Email service not available:', e.message);
        }
        if (emailService && emailService.isEmailConfigured()) {
          try {
            const charityRow = await pool.query(
              'SELECT contact_email, charity_name FROM charity_applications WHERE id = $1',
              [result.charityApplicationId]
            );
            if (charityRow.rows.length > 0 && charityRow.rows[0].contact_email) {
              const { contact_email, charity_name } = charityRow.rows[0];
              const emailResult = await emailService.sendCharityFinalizationEmail(contact_email, charity_name);
              if (emailResult.success) {
                console.log(`[FINALIZE] Finalization email sent to ${contact_email}`);
              } else {
                console.error('[FINALIZE] Finalization email failed:', emailResult.error);
              }
            }
          } catch (emailErr) {
            console.error('[FINALIZE] Finalization email error:', emailErr.message);
          }
        } else {
          console.warn('[FINALIZE] Email not configured, skipping finalization email.');
        }
      }
    }
    process.exit(0);
  } catch (err) {
    console.error('❌ [FINALIZE] Error:', err.message);
    console.error('❌ [FINALIZE] Stack:', err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { runFinalizeWeeklyDonations, getBillingWeekStart, toWeekStartString };
}
