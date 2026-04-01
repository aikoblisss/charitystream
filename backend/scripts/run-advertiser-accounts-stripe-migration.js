#!/usr/bin/env node
/**
 * Migration: Add stripe_customer_id to advertiser_accounts
 * Run: node backend/scripts/run-advertiser-accounts-stripe-migration.js
 * Requires: DATABASE_URL in env
 */
const { initializeDatabase, getPool } = require('../database-postgres');

async function run() {
  await initializeDatabase();
  const pool = getPool();
  if (!pool) {
    console.error('Database pool not available. Set DATABASE_URL.');
    process.exit(1);
  }
  try {
    await pool.query(`
      ALTER TABLE advertiser_accounts
      ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);
    `);
    console.log('✅ Added stripe_customer_id column to advertiser_accounts');

    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_advertiser_accounts_stripe_customer_id
      ON advertiser_accounts(stripe_customer_id)
      WHERE stripe_customer_id IS NOT NULL;
    `);
    console.log('✅ Created index on stripe_customer_id');

    console.log('🎉 Migration completed.');
    process.exit(0);
  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  }
}

run();
