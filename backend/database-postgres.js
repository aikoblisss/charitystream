// PostgreSQL database for Vercel with Neon
const { Pool } = require('pg');

// Database connection
let pool = null;

async function initializeDatabase() {
  console.log('🔧 Initializing PostgreSQL database...');
  
  // Create connection pool with timeout settings
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
      require: true
    },
    connectionTimeoutMillis: 10000, // 10 seconds
    idleTimeoutMillis: 30000, // 30 seconds
    max: 20, // Maximum number of clients in the pool
    min: 2   // Minimum number of clients in the pool
  });

  try {
    // Test connection
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL database');
    console.log('📅 Database time:', result.rows[0].now);

    // Create tables if they don't exist
    await createTables();
    console.log('🎉 PostgreSQL database initialization complete!');
  } catch (error) {
    console.error('❌ Database initialization failed:', error.message);
  }
}

async function createTables() {
  const createUsersTable = `
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE,
      username VARCHAR(255),
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255),
      profile_picture VARCHAR(255) DEFAULT 'default.png',
      verified BOOLEAN DEFAULT FALSE,
      verification_token VARCHAR(255),
      token_expires_at TIMESTAMP,
      reset_password_token VARCHAR(255),
      reset_password_expires TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      total_minutes_watched INTEGER DEFAULT 0,
      current_month_minutes INTEGER DEFAULT 0,
      total_seconds_watched INTEGER DEFAULT 0,
      current_month_seconds INTEGER DEFAULT 0,
      subscription_tier VARCHAR(50) DEFAULT 'free',
      auth_provider VARCHAR(50) DEFAULT 'google'
    )
  `;

  const createSessionsTable = `
    CREATE TABLE IF NOT EXISTS watch_sessions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      video_name VARCHAR(255) NOT NULL,
      quality VARCHAR(50) NOT NULL,
      start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      end_time TIMESTAMP,
      duration_seconds INTEGER,
      completed BOOLEAN DEFAULT FALSE,
      paused_count INTEGER DEFAULT 0,
      user_ip VARCHAR(45),
      user_agent TEXT
    )
  `;

  const createAdTrackingTable = `
    CREATE TABLE IF NOT EXISTS ad_tracking (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      session_id INTEGER REFERENCES watch_sessions(id),
      ad_start_time TIMESTAMP NOT NULL,
      ad_end_time TIMESTAMP,
      duration_seconds INTEGER DEFAULT 0,
      completed BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;

  const createDailyStatsTable = `
    CREATE TABLE IF NOT EXISTS daily_stats (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      ads_watched INTEGER DEFAULT 0,
      total_watch_time_seconds INTEGER DEFAULT 0,
      streak_days INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, date)
    )
  `;

  try {
    await pool.query(createUsersTable);
    console.log('✅ Users table ready');
    await pool.query(createSessionsTable);
    console.log('✅ Watch sessions table ready');
    await pool.query(createAdTrackingTable);
    console.log('✅ Ad tracking table ready');
    await pool.query(createDailyStatsTable);
    console.log('✅ Daily stats table ready');
    
    // Add missing columns if they don't exist
    await addMissingColumns();
  } catch (error) {
    console.error('❌ Error creating tables:', error);
  }
  
  // Always try to add missing columns
  await addMissingColumns();
}

// Add missing columns to existing tables
async function addMissingColumns() {
  try {
    // Add seconds columns to users table if they don't exist
    await pool.query(`
      ALTER TABLE users 
      ADD COLUMN IF NOT EXISTS total_seconds_watched INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS current_month_seconds INTEGER DEFAULT 0
    `);
    console.log('✅ Added missing seconds columns to users table');
  } catch (error) {
    console.error('❌ Error adding missing columns:', error);
  }
}

// Ensure tables exist before any operation
async function ensureTablesExist() {
  if (!pool) {
    throw new Error('Database not initialized');
  }
  
  try {
    // Check if users table exists
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `);
    
    if (!result.rows[0].exists) {
      console.log('🔧 Creating database tables...');
      await createTables();
      console.log('✅ Database tables created successfully');
    }
  } catch (error) {
    console.error('❌ Error ensuring tables exist:', error);
    throw error;
  }
}

// Helper functions for database operations
const dbHelpers = {
  // Get user by username or email
  getUserByLogin: async (login) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'SELECT * FROM users WHERE username = $1 OR email = $1',
        [login]
      );
      const user = result.rows[0] || null;
      if (user) {
        console.log('🔍 Database user data:', {
          id: user.id,
          username: user.username,
          email: user.email,
          password_hash_type: typeof user.password_hash,
          password_hash_length: user.password_hash ? user.password_hash.length : 'null'
        });
      }
      return [null, user];
    } catch (error) {
      return [error, null];
    }
  },

  // Create new user (traditional)
  createUser: async (userData) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        `INSERT INTO users (username, email, password_hash, auth_provider) 
         VALUES ($1, $2, $3, 'traditional') 
         RETURNING id`,
        [userData.username, userData.email, userData.password_hash]
      );
      return [null, result.rows[0].id];
    } catch (error) {
      return [error, null];
    }
  },

  // Create new Google OAuth user
  createGoogleUser: async (userData) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        `INSERT INTO users (google_id, username, email, profile_picture, verified, auth_provider) 
         VALUES ($1, $2, $3, $4, $5, 'google') 
         RETURNING id`,
        [
          userData.googleId,
          userData.username,
          userData.email,
          userData.profilePicture || 'default.png',
          true // Google users are always verified by Google
        ]
      );
      return [null, result.rows[0].id];
    } catch (error) {
      return [error, null];
    }
  },

  // Get user by Google ID
  getUserByGoogleId: async (googleId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'SELECT * FROM users WHERE google_id = $1',
        [googleId]
      );
      return [null, result.rows[0] || null];
    } catch (error) {
      return [error, null];
    }
  },

  // Get user by ID
  getUserById: async (id) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'SELECT * FROM users WHERE id = $1',
        [id]
      );
      return [null, result.rows[0] || null];
    } catch (error) {
      return [error, null];
    }
  },

  // Update user's watch time (in seconds)
  updateWatchSeconds: async (userId, secondsWatched) => {
    try {
      const result = await pool.query(
        `UPDATE users 
         SET total_seconds_watched = total_seconds_watched + $2,
             current_month_seconds = current_month_seconds + $2,
             total_minutes_watched = (total_seconds_watched + $2) / 60,
             current_month_minutes = (current_month_seconds + $2) / 60
         WHERE id = $1 
         RETURNING total_seconds_watched, current_month_seconds`,
        [userId, secondsWatched]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Update user's watch time (legacy - kept for compatibility)
  updateWatchTime: async (userId, minutesWatched) => {
    try {
      const result = await pool.query(
        `UPDATE users 
         SET total_minutes_watched = total_minutes_watched + $2,
             current_month_minutes = current_month_minutes + $2
         WHERE id = $1 
         RETURNING *`,
        [userId, minutesWatched]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Update last login
  updateLastLogin: async (userId) => {
    try {
      const result = await pool.query(
        'UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = $1 RETURNING *',
        [userId]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Get all users (for admin)
  getAllUsers: async (limit = 50, offset = 0) => {
    try {
      const result = await pool.query(
        'SELECT * FROM users ORDER BY created_at DESC LIMIT $1 OFFSET $2',
        [limit, offset]
      );
      return [null, result.rows];
    } catch (error) {
      return [error, null];
    }
  },

  // Update username
  updateUsername: async (userId, username) => {
    try {
      const result = await pool.query(
        'UPDATE users SET username = $2 WHERE id = $1 RETURNING *',
        [userId, username]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Create watch session
  createWatchSession: async (sessionData) => {
    try {
      const result = await pool.query(
        `INSERT INTO watch_sessions (user_id, video_name, quality, user_ip, user_agent) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING id`,
        [
          sessionData.userId,
          sessionData.videoName,
          sessionData.quality,
          sessionData.userIP,
          sessionData.userAgent
        ]
      );
      return [null, result.rows[0].id];
    } catch (error) {
      return [error, null];
    }
  },

  // Update watch session
  updateWatchSession: async (sessionId, updateData) => {
    try {
      const setClause = Object.keys(updateData)
        .map((key, index) => `${key} = $${index + 2}`)
        .join(', ');
      
      const values = [sessionId, ...Object.values(updateData)];
      
      const result = await pool.query(
        `UPDATE watch_sessions SET ${setClause} WHERE id = $1 RETURNING *`,
        values
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Get user rank
  getUserRank: async (userId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(`
        SELECT 
          u.id,
          u.username,
          u.email,
          u.total_watch_time,
          ROW_NUMBER() OVER (ORDER BY u.total_watch_time DESC) as rank
        FROM users u
        WHERE u.id = $1
      `, [userId]);
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Email verification functions
  getUserByVerificationToken: async (plainToken) => {
    try {
      await ensureTablesExist();
      // Get all users with non-expired verification tokens
      const result = await pool.query(
        'SELECT * FROM users WHERE verification_token IS NOT NULL AND token_expires_at > NOW()'
      );
      
      // We need to check each user's hashed token against the plain token
      // This is because we store hashed tokens but receive plain tokens
      for (const user of result.rows) {
        // Import bcrypt for token comparison
        const bcrypt = require('bcryptjs');
        const isValid = await bcrypt.compare(plainToken, user.verification_token);
        if (isValid) {
          return [null, user];
        }
      }
      
      return [null, null]; // No matching token found
    } catch (error) {
      return [error, null];
    }
  },

  verifyUserEmail: async (userId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'UPDATE users SET verified = true, verification_token = NULL, token_expires_at = NULL WHERE id = $1 RETURNING *',
        [userId]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  updateVerificationToken: async (userId, token, expiresAt) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'UPDATE users SET verification_token = $2, token_expires_at = $3 WHERE id = $1 RETURNING *',
        [userId, token, expiresAt]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  createUserWithVerification: async (userData) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        `INSERT INTO users (email, password_hash, auth_provider, verification_token, token_expires_at) 
         VALUES ($1, $2, $3, $4, $5) 
         RETURNING id`,
        [userData.email, userData.password_hash, userData.auth_provider, userData.verification_token, userData.token_expires_at]
      );
      return [null, result.rows[0].id];
    } catch (error) {
      return [error, null];
    }
  },

  getUserByEmail: async (email) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'SELECT * FROM users WHERE email = $1',
        [email]
      );
      return [null, result.rows[0] || null];
    } catch (error) {
      return [error, null];
    }
  },

  // Link Google account to existing user
  linkGoogleAccount: async (userId, googleId, profilePicture) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'UPDATE users SET google_id = $2, profile_picture = COALESCE($3, profile_picture), verified = true, auth_provider = CASE WHEN auth_provider = \'email\' THEN \'email_google\' ELSE \'google\' END WHERE id = $1 RETURNING *',
        [userId, googleId, profilePicture]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Set up password for Google users
  setupPassword: async (userId, passwordHash) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'UPDATE users SET password_hash = $2, auth_provider = CASE WHEN auth_provider = \'google\' THEN \'email_google\' ELSE auth_provider END WHERE id = $1 RETURNING *',
        [userId, passwordHash]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Password reset functions
  setPasswordResetToken: async (userId, hashedToken, expiresAt) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'UPDATE users SET reset_password_token = $2, reset_password_expires = $3 WHERE id = $1 RETURNING *',
        [userId, hashedToken, expiresAt]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  getUserByResetToken: async (plainToken) => {
    try {
      await ensureTablesExist();
      // Get all users with non-expired reset tokens
      const result = await pool.query(
        'SELECT * FROM users WHERE reset_password_token IS NOT NULL AND reset_password_expires > NOW()'
      );
      
      // Check each user's token against the plain token
      for (const user of result.rows) {
        // First try direct comparison (for plain tokens)
        if (user.reset_password_token === plainToken) {
          return [null, user];
        }
        
        // Then try bcrypt comparison (for hashed tokens)
        try {
          const bcrypt = require('bcryptjs');
          const isValid = await bcrypt.compare(plainToken, user.reset_password_token);
          if (isValid) {
            return [null, user];
          }
        } catch (bcryptError) {
          // If bcrypt comparison fails, continue to next user
          continue;
        }
      }
      
      return [null, null]; // No matching token found
    } catch (error) {
      return [error, null];
    }
  },

  resetUserPassword: async (userId, newPasswordHash) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'UPDATE users SET password_hash = $2, reset_password_token = NULL, reset_password_expires = NULL WHERE id = $1 RETURNING *',
        [userId, newPasswordHash]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Check username availability
  checkUsernameAvailability: async (username) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'SELECT id FROM users WHERE username = $1',
        [username]
      );
      return [null, result.rows.length === 0]; // true if available
    } catch (error) {
      return [error, false];
    }
  },

  // Delete incomplete Google user (for cancelled registrations)
  deleteIncompleteGoogleUser: async (userId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'DELETE FROM users WHERE id = $1 AND auth_provider = $2 AND username = (SELECT split_part(email, \'@\', 1) FROM users WHERE id = $1) RETURNING *',
        [userId, 'google']
      );
      
      if (result.rows.length === 0) {
        return [new Error('User not found or not eligible for deletion'), null];
      }
      
      console.log(`✅ Deleted incomplete Google user: ${result.rows[0].email}`);
      return [null, result.rows[0]];
    } catch (error) {
      console.error('Error deleting incomplete Google user:', error);
      return [error, null];
    }
  },

  // ===== AD TRACKING FUNCTIONS =====

  // Start tracking an ad
  startAdTracking: async (userId, sessionId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'INSERT INTO ad_tracking (user_id, session_id, ad_start_time) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING id',
        [userId, sessionId]
      );
      return [null, result.rows[0].id];
    } catch (error) {
      return [error, null];
    }
  },

  // Complete ad tracking
  completeAdTracking: async (adTrackingId, durationSeconds, completed = true) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'UPDATE ad_tracking SET ad_end_time = CURRENT_TIMESTAMP, duration_seconds = $2, completed = $3 WHERE id = $1 RETURNING *',
        [adTrackingId, durationSeconds, completed]
      );
      return [null, result.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Update daily stats for a user
  updateDailyStats: async (userId, adsWatched = 1, watchTimeSeconds = 0) => {
    try {
      await ensureTablesExist();
      const today = new Date().toISOString().split('T')[0];
      
      // Try to update existing record
      const updateResult = await pool.query(
        `UPDATE daily_stats 
         SET ads_watched = ads_watched + $3, 
             total_watch_time_seconds = total_watch_time_seconds + $4,
             updated_at = CURRENT_TIMESTAMP
         WHERE user_id = $1 AND date = $2
         RETURNING *`,
        [userId, today, adsWatched, watchTimeSeconds]
      );

      if (updateResult.rows.length > 0) {
        return [null, updateResult.rows[0]];
      }

      // If no existing record, create new one
      const insertResult = await pool.query(
        `INSERT INTO daily_stats (user_id, date, ads_watched, total_watch_time_seconds, streak_days)
         VALUES ($1, $2, $3, $4, 1)
         RETURNING *`,
        [userId, today, adsWatched, watchTimeSeconds]
      );

      return [null, insertResult.rows[0]];
    } catch (error) {
      return [error, null];
    }
  },

  // Get user's daily stats
  getUserDailyStats: async (userId, date = null) => {
    try {
      await ensureTablesExist();
      const targetDate = date || new Date().toISOString().split('T')[0];
      
      const result = await pool.query(
        'SELECT * FROM daily_stats WHERE user_id = $1 AND date = $2',
        [userId, targetDate]
      );
      
      return [null, result.rows[0] || null];
    } catch (error) {
      return [error, null];
    }
  },

  // Get user's ads watched today
  getAdsWatchedToday: async (userId) => {
    try {
      await ensureTablesExist();
      const today = new Date().toISOString().split('T')[0];
      
      const result = await pool.query(
        'SELECT ads_watched FROM daily_stats WHERE user_id = $1 AND date = $2',
        [userId, today]
      );
      
      return [null, result.rows[0]?.ads_watched || 0];
    } catch (error) {
      return [error, 0];
    }
  },

  // Get user's total ads watched
  getTotalAdsWatched: async (userId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'SELECT SUM(ads_watched) as total FROM daily_stats WHERE user_id = $1',
        [userId]
      );
      
      return [null, parseInt(result.rows[0]?.total || 0)];
    } catch (error) {
      return [error, 0];
    }
  },

  // Calculate user's streak
  calculateUserStreak: async (userId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        `WITH RECURSIVE streak_calc AS (
          SELECT date, ads_watched, 1 as streak_length
          FROM daily_stats 
          WHERE user_id = $1 AND ads_watched > 0
          ORDER BY date DESC
          LIMIT 1
          
          UNION ALL
          
          SELECT ds.date, ds.ads_watched, sc.streak_length + 1
          FROM daily_stats ds
          JOIN streak_calc sc ON ds.date = sc.date - INTERVAL '1 day'
          WHERE ds.user_id = $1 AND ds.ads_watched > 0
        )
        SELECT MAX(streak_length) as streak_days FROM streak_calc`,
        [userId]
      );
      
      return [null, parseInt(result.rows[0]?.streak_days || 0)];
    } catch (error) {
      return [error, 0];
    }
  },

  // ===== LEADERBOARD FUNCTIONS =====

  // Get monthly leaderboard (top 5 users by current month minutes)
  getMonthlyLeaderboard: async (limit = 5) => {
    try {
      await ensureTablesExist();
      console.log('🔍 Getting monthly leaderboard with limit:', limit);
      const result = await pool.query(
        `SELECT 
          u.id,
          u.username,
          FLOOR(u.current_month_seconds::numeric / 60) AS current_month_minutes,
          u.current_month_seconds,
          u.profile_picture,
          u.created_at,
          COALESCE(ds.ads_watched, 0) as ads_watched_today,
          0 as streak_days
        FROM users u
        LEFT JOIN daily_stats ds ON u.id = ds.user_id AND ds.date = CURRENT_DATE
        WHERE u.is_active = true
        ORDER BY u.current_month_seconds DESC
        LIMIT $1`,
        [limit]
      );
      
      console.log('✅ Monthly leaderboard query result:', result.rows.length, 'users');
      return [null, result.rows];
    } catch (error) {
      console.error('❌ Error in getMonthlyLeaderboard:', error);
      return [error, null];
    }
  },

  // Get user's rank in monthly leaderboard
  getUserMonthlyRank: async (userId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        `SELECT COUNT(*) + 1 as rank
         FROM users 
         WHERE current_month_seconds > (
           SELECT current_month_seconds 
           FROM users 
           WHERE id = $1
         ) AND is_active = true`,
        [userId]
      );
      
      return [null, parseInt(result.rows[0]?.rank || 1)];
    } catch (error) {
      return [error, 1];
    }
  },

  // Get user's overall rank (all time)
  getUserOverallRank: async (userId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        `SELECT COUNT(*) + 1 as rank
         FROM users 
         WHERE total_minutes_watched > (
           SELECT total_minutes_watched 
           FROM users 
           WHERE id = $1
         ) AND is_active = true`,
        [userId]
      );
      
      return [null, parseInt(result.rows[0]?.rank || 1)];
    } catch (error) {
      return [error, 1];
    }
  },

  // Get total number of active users
  getTotalActiveUsers: async () => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'SELECT COUNT(*) as total FROM users WHERE is_active = true'
      );
      
      return [null, parseInt(result.rows[0]?.total || 0)];
    } catch (error) {
      return [error, 0];
    }
  },

  // Get user's account age in days
  getUserAccountAge: async (userId) => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'SELECT EXTRACT(DAYS FROM (CURRENT_DATE - created_at::date)) as account_age_days FROM users WHERE id = $1',
        [userId]
      );
      
      return [null, parseInt(result.rows[0]?.account_age_days || 0)];
    } catch (error) {
      return [error, 0];
    }
  },

  // Reset monthly leaderboard (call this monthly)
  resetMonthlyLeaderboard: async () => {
    try {
      await ensureTablesExist();
      const result = await pool.query(
        'UPDATE users SET current_month_minutes = 0, current_month_seconds = 0'
      );
      
      console.log(`✅ Reset monthly leaderboard for ${result.rowCount} users`);
      return [null, result.rowCount];
    } catch (error) {
      return [error, null];
    }
  }
};

module.exports = { initializeDatabase, dbHelpers };
