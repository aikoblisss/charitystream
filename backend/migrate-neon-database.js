// Migration script to add missing columns to Neon PostgreSQL database
const { Pool } = require('pg');

async function migrateDatabase() {
  console.log('🔧 Starting Neon database migration...');
  
  // Create connection pool
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
      require: true
    }
  });

  try {
    // Test connection
    await pool.query('SELECT NOW()');
    console.log('✅ Connected to Neon database');

    // Check if users table exists and get its structure
    const tableCheck = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND table_schema = 'public'
    `);
    
    const existingColumns = tableCheck.rows.map(row => row.column_name);
    console.log('📋 Existing columns:', existingColumns);

    // Add missing columns if they don't exist
    const columnsToAdd = [
      { name: 'reset_password_token', type: 'VARCHAR(255)' },
      { name: 'reset_password_expires', type: 'TIMESTAMP' },
      { name: 'verification_token', type: 'VARCHAR(255)' },
      { name: 'token_expires_at', type: 'TIMESTAMP' },
      { name: 'verified', type: 'BOOLEAN DEFAULT FALSE' },
      { name: 'profile_picture', type: 'VARCHAR(255) DEFAULT \'default.png\'' },
      { name: 'created_at', type: 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP' },
      { name: 'last_login', type: 'TIMESTAMP' },
      { name: 'is_active', type: 'BOOLEAN DEFAULT TRUE' },
      { name: 'total_minutes_watched', type: 'INTEGER DEFAULT 0' },
      { name: 'current_month_minutes', type: 'INTEGER DEFAULT 0' },
      { name: 'subscription_tier', type: 'VARCHAR(50) DEFAULT \'free\'' },
      { name: 'auth_provider', type: 'VARCHAR(50) DEFAULT \'google\'' }
    ];

    for (const column of columnsToAdd) {
      if (!existingColumns.includes(column.name)) {
        try {
          await pool.query(`ALTER TABLE users ADD COLUMN ${column.name} ${column.type}`);
          console.log(`✅ Added column: ${column.name}`);
        } catch (error) {
          if (error.code === '42701') {
            console.log(`⚠️ Column ${column.name} already exists`);
          } else {
            console.error(`❌ Error adding column ${column.name}:`, error.message);
          }
        }
      } else {
        console.log(`✅ Column ${column.name} already exists`);
      }
    }

    // Create other tables if they don't exist
    await createOtherTables(pool);

    console.log('🎉 Database migration completed successfully!');
    
  } catch (error) {
    console.error('❌ Migration failed:', error);
  } finally {
    await pool.end();
  }
}

async function createOtherTables(pool) {
  console.log('🔧 Creating other tables...');
  
  // Create watch_sessions table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS watch_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      video_name VARCHAR(255) NOT NULL,
      quality VARCHAR(50) NOT NULL,
      start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      end_time TIMESTAMP,
      duration_seconds INTEGER DEFAULT 0,
      completed BOOLEAN DEFAULT FALSE,
      abandoned BOOLEAN DEFAULT FALSE,
      abandon_time_seconds INTEGER,
      location_country TEXT,
      location_city TEXT,
      device_type TEXT
    )
  `);
  console.log('✅ watch_sessions table ready');

  // Create event_tracking table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS event_tracking (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      session_id INTEGER REFERENCES watch_sessions(id),
      event_type TEXT NOT NULL,
      video_name TEXT NOT NULL,
      timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      video_position_seconds INTEGER,
      quality TEXT,
      metadata TEXT
    )
  `);
  console.log('✅ event_tracking table ready');

  // Create daily_analytics table
  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_analytics (
      id SERIAL PRIMARY KEY,
      date DATE UNIQUE NOT NULL,
      total_users INTEGER DEFAULT 0,
      active_users INTEGER DEFAULT 0,
      total_sessions INTEGER DEFAULT 0,
      total_minutes_watched INTEGER DEFAULT 0,
      total_ads_started INTEGER DEFAULT 0,
      total_ads_completed INTEGER DEFAULT 0,
      total_ads_abandoned INTEGER DEFAULT 0,
      completion_rate DECIMAL(5,2) DEFAULT 0,
      new_registrations INTEGER DEFAULT 0
    )
  `);
  console.log('✅ daily_analytics table ready');
}

// Run migration if called directly
if (require.main === module) {
  migrateDatabase().catch(console.error);
}

module.exports = { migrateDatabase };
