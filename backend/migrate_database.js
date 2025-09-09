// Simple database migration script to add enhanced tracking tables
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, 'letswatchads.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
    process.exit(1);
  } else {
    console.log('Connected to database for migration');
  }
});

function runMigration() {
  console.log('🔧 Running database migration...');

  // Add new columns to existing watch_sessions table
  db.run(`ALTER TABLE watch_sessions ADD COLUMN abandoned BOOLEAN DEFAULT 0`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding abandoned column:', err.message);
    }
  });

  db.run(`ALTER TABLE watch_sessions ADD COLUMN abandon_time_seconds INTEGER`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding abandon_time_seconds column:', err.message);
    }
  });

  db.run(`ALTER TABLE watch_sessions ADD COLUMN location_country TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding location_country column:', err.message);
    }
  });

  db.run(`ALTER TABLE watch_sessions ADD COLUMN location_city TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding location_city column:', err.message);
    }
  });

  db.run(`ALTER TABLE watch_sessions ADD COLUMN device_type TEXT`, (err) => {
    if (err && !err.message.includes('duplicate column name')) {
      console.error('Error adding device_type column:', err.message);
    }
  });

  // Create event tracking table
  db.run(`
    CREATE TABLE IF NOT EXISTS event_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      session_id INTEGER,
      event_type TEXT NOT NULL,
      video_name TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      video_position_seconds INTEGER,
      quality TEXT,
      metadata TEXT,
      FOREIGN KEY (user_id) REFERENCES users (id),
      FOREIGN KEY (session_id) REFERENCES watch_sessions (id)
    )
  `, (err) => {
    if (err) {
      console.error('Error creating event_tracking table:', err.message);
    } else {
      console.log('✅ Event tracking table ready');
    }
  });

  // Create daily analytics table
  db.run(`
    CREATE TABLE IF NOT EXISTS daily_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  `, (err) => {
    if (err) {
      console.error('Error creating daily_analytics table:', err.message);
    } else {
      console.log('✅ Daily analytics table ready');
    }
  });

  console.log('🎉 Migration completed!');
  
  // Close database connection
  db.close((err) => {
    if (err) {
      console.error('Error closing database:', err.message);
    } else {
      console.log('Database connection closed.');
    }
  });
}

runMigration();