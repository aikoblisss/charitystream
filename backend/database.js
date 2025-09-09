const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// Create database connection
const dbPath = path.join(__dirname, 'letswatchads.db');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('✅ Connected to SQLite database');
  }
});

// Initialize database tables
function initializeDatabase() {
  console.log('🔧 Initializing database tables...');
  
  // Users table - Updated for Google OAuth
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      google_id TEXT UNIQUE,
      username TEXT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT,
      profile_picture TEXT DEFAULT 'default.png',
      email_verified BOOLEAN DEFAULT 0,
      email_verification_token TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME,
      is_active BOOLEAN DEFAULT 1,
      total_minutes_watched INTEGER DEFAULT 0,
      current_month_minutes INTEGER DEFAULT 0,
      subscription_tier TEXT DEFAULT 'free',
      auth_provider TEXT DEFAULT 'google'
    )
  `, (err) => {
    if (err) {
      console.error('Error creating users table:', err.message);
    } else {
      console.log('✅ Users table ready (Google OAuth enabled)');
    }
  });

  // Watch sessions table - for detailed tracking
  db.run(`
    CREATE TABLE IF NOT EXISTS watch_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      video_name TEXT NOT NULL,
      quality TEXT NOT NULL,
      start_time DATETIME DEFAULT CURRENT_TIMESTAMP,
      end_time DATETIME,
      duration_seconds INTEGER,
      completed BOOLEAN DEFAULT 0,
      paused_count INTEGER DEFAULT 0,
      user_ip TEXT,
      user_agent TEXT,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `, (err) => {
    if (err) {
      console.error('Error creating watch_sessions table:', err.message);
    } else {
      console.log('✅ Watch sessions table ready');
    }
  });

  // Platform analytics table - for admin dashboard
  db.run(`
    CREATE TABLE IF NOT EXISTS platform_analytics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date DATE UNIQUE NOT NULL,
      total_users INTEGER DEFAULT 0,
      total_sessions INTEGER DEFAULT 0,
      total_minutes_watched INTEGER DEFAULT 0,
      total_videos_completed INTEGER DEFAULT 0,
      new_registrations INTEGER DEFAULT 0
    )
  `, (err) => {
    if (err) {
      console.error('Error creating analytics table:', err.message);
    } else {
      console.log('✅ Analytics table ready');
    }
  });

  // Payment transactions table - ready for future Stripe integration
  db.run(`
    CREATE TABLE IF NOT EXISTS payment_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      stripe_payment_id TEXT,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'usd',
      subscription_tier TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME,
      FOREIGN KEY (user_id) REFERENCES users (id)
    )
  `, (err) => {
    if (err) {
      console.error('Error creating payments table:', err.message);
    } else {
      console.log('✅ Payment transactions table ready');
    }
  });

  console.log('🎉 Database initialization complete!');
}

// Helper functions for database operations
const dbHelpers = {
  // Get user by username or email
  getUserByLogin: (login, callback) => {
    const query = `SELECT * FROM users WHERE username = ? OR email = ?`;
    db.get(query, [login, login], callback);
  },

  // Create new user (traditional)
  createUser: (userData, callback) => {
    const query = `
      INSERT INTO users (username, email, password_hash) 
      VALUES (?, ?, ?)
    `;
    db.run(query, [userData.username, userData.email, userData.password_hash], callback);
  },

  // Create new Google OAuth user
  createGoogleUser: (userData, callback) => {
    const query = `
      INSERT INTO users (google_id, username, email, profile_picture, email_verified, auth_provider) 
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    db.run(query, [
      userData.googleId, 
      userData.username, 
      userData.email, 
      userData.profilePicture || 'default.png',
      userData.emailVerified || 0,
      'google'
    ], callback);
  },

  // Get user by Google ID
  getUserByGoogleId: (googleId, callback) => {
    const query = `SELECT * FROM users WHERE google_id = ?`;
    db.get(query, [googleId], callback);
  },

  // Update email verification status
  verifyEmail: (userId, callback) => {
    const query = `UPDATE users SET email_verified = 1, email_verification_token = NULL WHERE id = ?`;
    db.run(query, [userId], callback);
  },

  // Get user by email verification token
  getUserByVerificationToken: (token, callback) => {
    const query = `SELECT * FROM users WHERE email_verification_token = ?`;
    db.get(query, [token], callback);
  },

  // Get user by ID
  getUserById: (id, callback) => {
    const query = `SELECT * FROM users WHERE id = ?`;
    db.get(query, [id], callback);
  },

  // Update user's watch time with decimal precision
  updateWatchTime: (userId, minutesWatched, callback) => {
    const query = `
      UPDATE users 
      SET total_minutes_watched = ROUND(total_minutes_watched + ?, 2),
          current_month_minutes = ROUND(current_month_minutes + ?, 2)
      WHERE id = ?
    `;
    db.run(query, [minutesWatched, minutesWatched, userId], callback);
  },

  // Create watch session
  createWatchSession: (sessionData, callback) => {
    const query = `
      INSERT INTO watch_sessions (user_id, video_name, quality, user_ip, user_agent)
      VALUES (?, ?, ?, ?, ?)
    `;
    db.run(query, [
      sessionData.userId, 
      sessionData.videoName, 
      sessionData.quality,
      sessionData.userIP,
      sessionData.userAgent
    ], callback);
  },

  // Complete watch session
  completeWatchSession: (sessionId, durationSeconds, completed, pausedCount, callback) => {
    const query = `
      UPDATE watch_sessions 
      SET end_time = CURRENT_TIMESTAMP, 
          duration_seconds = ?, 
          completed = ?,
          paused_count = ?
      WHERE id = ?
    `;
    db.run(query, [durationSeconds, completed, pausedCount, sessionId], callback);
  },

  // Get leaderboard data
  getLeaderboard: (limit = 10, callback) => {
    const query = `
      SELECT username, current_month_minutes, profile_picture
      FROM users 
      WHERE is_active = 1
      ORDER BY current_month_minutes DESC 
      LIMIT ?
    `;
    db.all(query, [limit], callback);
  },

  // Get user rank
  getUserRank: (userId, callback) => {
    const query = `
      SELECT COUNT(*) as rank 
      FROM users 
      WHERE current_month_minutes > (
        SELECT current_month_minutes 
        FROM users 
        WHERE id = ?
      ) AND is_active = 1
    `;
    db.get(query, [userId], (err, result) => {
      if (err) {
        callback(err, null);
      } else {
        callback(null, result.rank + 1); // +1 because rank starts at 1, not 0
      }
    });
  },

  // Update user's last login time
  updateLastLogin: (userId, callback) => {
    const query = `UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?`;
    db.run(query, [userId], callback);
  },

  // === ENHANCED TRACKING FUNCTIONS ===

  // Create detailed watch session with location/device data
  createDetailedWatchSession: (sessionData, callback) => {
    const query = `
      INSERT INTO watch_sessions 
      (user_id, video_name, quality, user_ip, user_agent, location_country, location_city, device_type)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    db.run(query, [
      sessionData.userId, 
      sessionData.videoName, 
      sessionData.quality,
      sessionData.userIP,
      sessionData.userAgent,
      sessionData.locationCountry || null,
      sessionData.locationCity || null,
      sessionData.deviceType || 'unknown'
    ], callback);
  },

  // Complete watch session with detailed tracking
  completeDetailedWatchSession: (sessionId, completionData, callback) => {
    const query = `
      UPDATE watch_sessions 
      SET end_time = CURRENT_TIMESTAMP, 
          duration_seconds = ?, 
          completed = ?,
          paused_count = ?,
          abandoned = ?,
          abandon_time_seconds = ?
      WHERE id = ?
    `;
    db.run(query, [
      completionData.durationSeconds,
      completionData.completed, 
      completionData.pausedCount,
      completionData.abandoned || 0,
      completionData.abandonTimeSeconds || null,
      sessionId
    ], callback);
  },

  // Track individual events (ad start, pause, complete, etc.)
  trackEvent: (eventData, callback) => {
    const query = `
      INSERT INTO event_tracking 
      (user_id, session_id, event_type, video_name, video_position_seconds, quality, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `;
    db.run(query, [
      eventData.userId,
      eventData.sessionId,
      eventData.eventType,
      eventData.videoName,
      eventData.videoPositionSeconds || 0,
      eventData.quality,
      eventData.metadata ? JSON.stringify(eventData.metadata) : null
    ], callback);
  },

  // === ANALYTICS QUERIES ===

  // Get comprehensive platform analytics
  getPlatformAnalytics: (dateFrom, dateTo, callback) => {
    const queries = {
      // Total platform users
      totalUsers: `SELECT COUNT(*) as count FROM users WHERE is_active = 1`,
      
      // Total ads watched (completed sessions)
      totalAdsWatched: `SELECT COUNT(*) as count FROM watch_sessions WHERE completed = 1`,
      
      // Total ads started
      totalAdsStarted: `SELECT COUNT(*) as count FROM watch_sessions`,
      
      // Total ads abandoned
      totalAdsAbandoned: `SELECT COUNT(*) as count FROM watch_sessions WHERE abandoned = 1`,
      
      // Total watch time in minutes
      totalMinutesWatched: `SELECT COALESCE(SUM(duration_seconds)/60, 0) as total FROM watch_sessions WHERE completed = 1`,
      
      // Completion rate
      completionRate: `
        SELECT 
          CASE 
            WHEN COUNT(*) > 0 THEN ROUND((SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) * 100.0) / COUNT(*), 2)
            ELSE 0 
          END as rate
        FROM watch_sessions
      `,
      
      // Active users (watched in last 7 days)
      activeUsers: `
        SELECT COUNT(DISTINCT user_id) as count 
        FROM watch_sessions 
        WHERE start_time >= datetime('now', '-7 days')
      `,
      
      // Recent registrations (last 30 days)
      recentRegistrations: `
        SELECT COUNT(*) as count 
        FROM users 
        WHERE created_at >= datetime('now', '-30 days')
      `
    };

    let analytics = {};
    let completed = 0;
    const totalQueries = Object.keys(queries).length;

    Object.keys(queries).forEach(key => {
      db.get(queries[key], (err, result) => {
        if (!err && result) {
          analytics[key] = result.count || result.total || result.rate || 0;
        } else {
          analytics[key] = 0;
        }
        
        completed++;
        if (completed === totalQueries) {
          callback(null, analytics);
        }
      });
    });
  },

  // Get user-specific analytics
  getUserAnalytics: (userId, callback) => {
    const userQueries = {
      totalAdsWatched: `SELECT COUNT(*) as count FROM watch_sessions WHERE user_id = ? AND completed = 1`,
      totalAdsStarted: `SELECT COUNT(*) as count FROM watch_sessions WHERE user_id = ?`,
      totalMinutesWatched: `SELECT COALESCE(SUM(duration_seconds)/60, 0) as total FROM watch_sessions WHERE user_id = ? AND completed = 1`,
      completionRate: `
        SELECT 
          CASE 
            WHEN COUNT(*) > 0 THEN ROUND((SUM(CASE WHEN completed = 1 THEN 1 ELSE 0 END) * 100.0) / COUNT(*), 2)
            ELSE 0 
          END as rate
        FROM watch_sessions WHERE user_id = ?
      `,
      averageWatchTime: `
        SELECT COALESCE(AVG(duration_seconds)/60, 0) as avg 
        FROM watch_sessions 
        WHERE user_id = ? AND completed = 1
      `
    };

    let userAnalytics = {};
    let completed = 0;
    const totalQueries = Object.keys(userQueries).length;

    Object.keys(userQueries).forEach(key => {
      db.get(userQueries[key], [userId], (err, result) => {
        if (!err && result) {
          userAnalytics[key] = result.count || result.total || result.rate || result.avg || 0;
        } else {
          userAnalytics[key] = 0;
        }
        
        completed++;
        if (completed === totalQueries) {
          callback(null, userAnalytics);
        }
      });
    });
  },

  // Get event analytics
  getEventAnalytics: (dateFrom, dateTo, callback) => {
    const query = `
      SELECT 
        event_type,
        COUNT(*) as count,
        COUNT(DISTINCT user_id) as unique_users
      FROM event_tracking 
      WHERE timestamp >= datetime('now', '-30 days')
      GROUP BY event_type
      ORDER BY count DESC
    `;
    
    db.all(query, (err, events) => {
      callback(err, events || []);
    });
  },

  // Get top users by watch time
  getTopWatchers: (limit = 10, callback) => {
    const query = `
      SELECT 
        u.username,
        u.current_month_minutes,
        COUNT(ws.id) as total_sessions,
        SUM(CASE WHEN ws.completed = 1 THEN 1 ELSE 0 END) as completed_sessions,
        ROUND(
          CASE 
            WHEN COUNT(ws.id) > 0 THEN (SUM(CASE WHEN ws.completed = 1 THEN 1 ELSE 0 END) * 100.0) / COUNT(ws.id)
            ELSE 0 
          END, 2
        ) as completion_rate
      FROM users u
      LEFT JOIN watch_sessions ws ON u.id = ws.user_id
      WHERE u.is_active = 1
      GROUP BY u.id, u.username, u.current_month_minutes
      ORDER BY u.current_month_minutes DESC
      LIMIT ?
    `;
    
    db.all(query, [limit], callback);
  }
};

module.exports = {
  db,
  initializeDatabase,
  dbHelpers
};