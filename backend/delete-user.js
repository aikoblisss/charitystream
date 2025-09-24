#!/usr/bin/env node

// Script to delete a specific user by email for testing purposes
const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

async function deleteUserByEmail(email) {
  console.log(`🗑️ Deleting user with email: ${email}`);
  console.log('🔧 Initializing database connection...');
  
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

    // First, get user info
    console.log('🔍 Looking for user...');
    const userResult = await pool.query('SELECT id, username, email FROM users WHERE email = $1', [email]);
    
    if (userResult.rows.length === 0) {
      console.log('❌ User not found with email:', email);
      return;
    }
    
    const user = userResult.rows[0];
    console.log(`📋 Found user: ID=${user.id}, Username=${user.username}, Email=${user.email}`);

    // Delete related data first (foreign key constraints) - in correct order
    console.log('🗑️ Deleting ad tracking...');
    await pool.query('DELETE FROM ad_tracking WHERE user_id = $1', [user.id]);
    
    console.log('🗑️ Deleting watch sessions...');
    await pool.query('DELETE FROM watch_sessions WHERE user_id = $1', [user.id]);
    
    console.log('🗑️ Deleting daily stats...');
    await pool.query('DELETE FROM daily_stats WHERE user_id = $1', [user.id]);
    
    // Finally delete the user
    console.log('🗑️ Deleting user...');
    const deleteResult = await pool.query('DELETE FROM users WHERE id = $1 RETURNING *', [user.id]);
    
    if (deleteResult.rows.length > 0) {
      console.log('✅ User deleted successfully!');
      console.log(`📊 Deleted user: ${deleteResult.rows[0].username} (${deleteResult.rows[0].email})`);
    } else {
      console.log('❌ Failed to delete user');
    }
    
  } catch (error) {
    console.error('❌ Error deleting user:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Get email from command line arguments
const email = process.argv[2];

if (!email) {
  console.log('Usage: node delete-user.js <email>');
  console.log('Example: node delete-user.js test@example.com');
  process.exit(1);
}

// Run the deletion
deleteUserByEmail(email);
