#!/usr/bin/env node

// Migration script to add email verification columns
require('dotenv').config();
const { Pool } = require('pg');

async function migrateDatabase() {
  console.log('🔧 Starting database migration for email verification...');
  
  // Check if DATABASE_URL is set
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is not set!');
    console.error('Please set your Neon database URL as DATABASE_URL');
    process.exit(1);
  }
  
  console.log('🔍 Database URL found:', databaseUrl.substring(0, 20) + '...');
  
  // Create connection pool
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: {
      rejectUnauthorized: false,
      require: true
    }
  });

  try {
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL database');

    // Check if verification columns already exist
    const checkColumns = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND column_name IN ('verified', 'verification_token', 'token_expires_at')
    `);

    const existingColumns = checkColumns.rows.map(row => row.column_name);
    console.log('📋 Existing verification columns:', existingColumns);

    // Add missing columns
    if (!existingColumns.includes('verified')) {
      console.log('➕ Adding verified column...');
      await pool.query('ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT FALSE');
      console.log('✅ verified column added');
    }

    if (!existingColumns.includes('verification_token')) {
      console.log('➕ Adding verification_token column...');
      await pool.query('ALTER TABLE users ADD COLUMN verification_token VARCHAR(255)');
      console.log('✅ verification_token column added');
    }

    if (!existingColumns.includes('token_expires_at')) {
      console.log('➕ Adding token_expires_at column...');
      await pool.query('ALTER TABLE users ADD COLUMN token_expires_at TIMESTAMP');
      console.log('✅ token_expires_at column added');
    }

    // Update existing users to be verified (since they were created before verification was required)
    console.log('🔄 Updating existing users to verified status...');
    const updateResult = await pool.query('UPDATE users SET verified = TRUE WHERE verified IS NULL');
    console.log(`✅ Updated ${updateResult.rowCount} existing users to verified`);

    console.log('🎉 Database migration complete!');
  } catch (error) {
    console.error('❌ Error during migration:', error);
  } finally {
    await pool.end();
    console.log('🔌 Database connection closed.');
  }
}

migrateDatabase();
