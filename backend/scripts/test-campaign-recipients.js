#!/usr/bin/env node
/**
 * Test script: verify campaign recipients query
 *
 * Runs the same batch query used by the dashboard API and prints results
 * for all campaigns belonging to a given advertiser email.
 *
 * Usage:
 *   node backend/scripts/test-campaign-recipients.js --email=you@example.com
 *
 * Optional flags:
 *   --seed    Insert minimal test rows to cover all three UI states, then query
 *   --clean   Remove only the test rows inserted by --seed
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

const SEED_MARKER = '__recipient_test__';

async function run() {
  const emailArg = process.argv.find(a => a.startsWith('--email='));
  if (!emailArg) {
    console.error('❌ --email=<advertiser email> is required');
    process.exit(1);
  }
  const email = emailArg.split('=')[1].trim();
  const doSeed  = process.argv.includes('--seed');
  const doClean = process.argv.includes('--clean');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: true });

  try {
    // ── 1. Fetch campaigns for this email ──────────────────────────────────
    const campaignResult = await pool.query(
      `SELECT id, campaign_name FROM advertisers
       WHERE email = $1 AND payment_completed = TRUE
       ORDER BY created_at DESC`,
      [email]
    );

    if (campaignResult.rows.length === 0) {
      console.error(`❌ No payment_completed campaigns found for ${email}`);
      process.exit(1);
    }

    console.log(`\n📋 Campaigns for ${email}:`);
    campaignResult.rows.forEach(r =>
      console.log(`   id=${r.id}  name="${r.campaign_name || 'Untitled'}"`)
    );

    const campaignIds = campaignResult.rows.map(r => String(r.id));

    // ── 2. --clean: remove seed rows ──────────────────────────────────────
    if (doClean) {
      console.log('\n🧹 Cleaning seed data...');

      // Remove seed charity_week_winner rows (joined via seed charity_applications)
      await pool.query(
        `DELETE FROM charity_week_winner
         WHERE charity_application_id IN (
           SELECT id FROM charity_applications WHERE charity_name LIKE $1
         )`,
        [`%${SEED_MARKER}%`]
      );

      // Remove seed donation_ledger rows
      await pool.query(
        `DELETE FROM donation_ledger
         WHERE source_type = 'advertiser'
           AND billing_record_id LIKE $1`,
        [`%${SEED_MARKER}%`]
      );

      // Remove seed charity_applications rows
      await pool.query(
        `DELETE FROM charity_applications WHERE charity_name LIKE $1`,
        [`%${SEED_MARKER}%`]
      );

      console.log('✅ Seed data removed.');
    }

    // ── 3. --seed: insert test rows ───────────────────────────────────────
    if (doSeed) {
      console.log('\n🌱 Seeding test data...');

      const ids = campaignIds;
      if (ids.length < 3) {
        console.warn(`⚠️  Fewer than 3 campaigns found — seed covers as many states as campaigns allow.`);
      }

      // Campaign 0 → TBA (no donation_ledger entry at all — nothing to insert)
      console.log(`   Campaign ${ids[0]}: will show TBA (no ledger entry inserted)`);

      // Campaign 1 (if exists) → one charity
      if (ids[1]) {
        const week1 = '2025-01-06'; // a past Monday

        const ca1 = await pool.query(
          `INSERT INTO charity_applications (charity_name, federal_ein, contact_email, status)
           VALUES ($1, '00-0000001', 'seed1@test.com', 'approved')
           RETURNING id`,
          [`Seed Charity One ${SEED_MARKER}`]
        );
        const caId1 = ca1.rows[0].id;

        await pool.query(
          `INSERT INTO charity_week_winner (charity_application_id, week_start, selection_method)
           VALUES ($1, $2::date, 'seed')
           ON CONFLICT DO NOTHING`,
          [caId1, week1]
        );

        await pool.query(
          `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
           VALUES ('advertiser', $1, $2, 10.00, $3::date)
           ON CONFLICT (source_id, week_start) DO NOTHING`,
          [ids[1], `seed-1-${SEED_MARKER}`, week1]
        );

        console.log(`   Campaign ${ids[1]}: will show one charity ("Seed Charity One")`);
      }

      // Campaign 2 (if exists) → multiple charities
      if (ids[2]) {
        const week2a = '2025-01-13';
        const week2b = '2025-01-20';

        const ca2a = await pool.query(
          `INSERT INTO charity_applications (charity_name, federal_ein, contact_email, status)
           VALUES ($1, '00-0000002', 'seed2a@test.com', 'approved')
           RETURNING id`,
          [`Seed Charity Two ${SEED_MARKER}`]
        );
        const ca2b = await pool.query(
          `INSERT INTO charity_applications (charity_name, federal_ein, contact_email, status)
           VALUES ($1, '00-0000003', 'seed2b@test.com', 'approved')
           RETURNING id`,
          [`Seed Charity Three ${SEED_MARKER}`]
        );
        const caId2a = ca2a.rows[0].id;
        const caId2b = ca2b.rows[0].id;

        await pool.query(
          `INSERT INTO charity_week_winner (charity_application_id, week_start, selection_method)
           VALUES ($1, $2::date, 'seed'), ($3, $4::date, 'seed')
           ON CONFLICT DO NOTHING`,
          [caId2a, week2a, caId2b, week2b]
        );

        await pool.query(
          `INSERT INTO donation_ledger (source_type, source_id, billing_record_id, amount, week_start)
           VALUES
             ('advertiser', $1, $2, 15.00, $3::date),
             ('advertiser', $1, $4, 20.00, $5::date)
           ON CONFLICT (source_id, week_start) DO NOTHING`,
          [ids[2], `seed-2a-${SEED_MARKER}`, week2a, `seed-2b-${SEED_MARKER}`, week2b]
        );

        console.log(`   Campaign ${ids[2]}: will show two charities ("Seed Charity Two" + "Seed Charity Three")`);
      }

      console.log('✅ Seed complete.\n');
    }

    // ── 4. Run the batch recipients query (same as dashboard API) ─────────
    console.log('\n🔍 Running recipients batch query...\n');

    const recipientsResult = await pool.query(
      `SELECT dl.source_id AS campaign_id, ca.charity_name, cww.week_start
       FROM donation_ledger dl
       JOIN charity_week_winner cww ON cww.week_start = dl.week_start
       JOIN charity_applications ca ON ca.id = cww.charity_application_id
       WHERE dl.source_type = 'advertiser'
         AND dl.source_id = ANY($1::text[])
       ORDER BY dl.source_id, cww.week_start DESC`,
      [campaignIds]
    );

    // Group same as server
    const recipientsByCampaignId = {};
    recipientsResult.rows.forEach(row => {
      const id = row.campaign_id;
      if (!recipientsByCampaignId[id]) recipientsByCampaignId[id] = [];
      if (!recipientsByCampaignId[id].includes(row.charity_name)) {
        recipientsByCampaignId[id].push(row.charity_name);
      }
    });

    // Print results per campaign
    campaignResult.rows.forEach(camp => {
      const recipients = recipientsByCampaignId[camp.id] || [];
      const display =
        recipients.length === 0
          ? '→ TBA'
          : recipients.length === 1
          ? `→ "${recipients[0]}"`
          : `→ "${recipients[0]}" (+${recipients.length - 1} more: ${recipients.slice(1).map(r => `"${r}"`).join(', ')})`;

      console.log(`  Campaign ${camp.id} "${camp.campaign_name || 'Untitled'}":  ${display}`);
    });

    console.log(`\n📊 Raw query rows returned: ${recipientsResult.rows.length}`);
    if (recipientsResult.rows.length > 0) {
      console.table(recipientsResult.rows);
    }

  } finally {
    await pool.end();
  }
}

run().catch(err => {
  console.error('❌ Script failed:', err.message);
  process.exit(1);
});
