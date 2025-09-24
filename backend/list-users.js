#!/usr/bin/env node

// Script to list all users in the database
const { Pool } = require('pg');
require('dotenv').config({ path: '../.env' });

async function listUsers() {
  console.log('📋 Listing all users in the database...');
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

    // Get all users
    console.log('🔍 Fetching users...');
    const result = await pool.query(`
      SELECT 
        id, 
        username, 
        email, 
        email_verified,
        auth_provider,
        created_at,
        last_login,
        is_active,
        total_seconds_watched,
        current_month_seconds
      FROM users 
      ORDER BY created_at DESC
    `);
    
    if (result.rows.length === 0) {
      console.log('📭 No users found in the database');
      return;
    }
    
    console.log(`📊 Found ${result.rows.length} user(s):`);
    console.log('─'.repeat(120));
    console.log('ID | Username | Email | Verified | Provider | Created | Last Login | Active | Watch Time');
    console.log('─'.repeat(120));
    
    result.rows.forEach(user => {
      const created = user.created_at ? new Date(user.created_at).toLocaleDateString() : 'N/A';
      const lastLogin = user.last_login ? new Date(user.last_login).toLocaleDateString() : 'Never';
      const watchTime = user.total_seconds_watched ? `${Math.floor(user.total_seconds_watched / 60)}m` : '0m';
      
      console.log(
        `${user.id.toString().padEnd(2)} | ` +
        `${(user.username || 'N/A').padEnd(8)} | ` +
        `${user.email.padEnd(25)} | ` +
        `${user.email_verified ? 'Yes' : 'No'}`.padEnd(8) + ' | ' +
        `${(user.auth_provider || 'N/A').padEnd(8)} | ` +
        `${created}`.padEnd(8) + ' | ' +
        `${lastLogin}`.padEnd(10) + ' | ' +
        `${user.is_active ? 'Yes' : 'No'}`.padEnd(6) + ' | ' +
        `${watchTime}`
      );
    });
    
    console.log('─'.repeat(120));
    console.log('\n💡 To delete a user, run: node delete-user.js <email>');
    
  } catch (error) {
    console.error('❌ Error listing users:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Run the listing
listUsers();
