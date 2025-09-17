#!/usr/bin/env node

// Database reset script for PostgreSQL (Neon)
const { Pool } = require('pg');

async function resetDatabase() {
  console.log('🚨 WARNING: This will delete ALL user data!');
  console.log('🔧 Initializing database connection...');
  
  // Check if DATABASE_URL is set
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('❌ DATABASE_URL environment variable is not set!');
    console.error('Please set your Neon database URL as DATABASE_URL');
    console.error('Example: DATABASE_URL=postgresql://username:password@host:port/database');
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

    // Delete all data from tables (in correct order due to foreign keys)
    console.log('🗑️ Clearing watch_sessions table...');
    await pool.query('DELETE FROM watch_sessions');
    
    console.log('🗑️ Clearing users table...');
    await pool.query('DELETE FROM users');
    
    // Reset auto-increment sequences
    console.log('🔄 Resetting sequences...');
    await pool.query('ALTER SEQUENCE IF EXISTS users_id_seq RESTART WITH 1');
    await pool.query('ALTER SEQUENCE IF EXISTS watch_sessions_id_seq RESTART WITH 1');
    
    console.log('✅ Database reset complete!');
    console.log('📊 All user accounts and data have been removed.');
    
  } catch (error) {
    console.error('❌ Error resetting database:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the reset
resetDatabase();
