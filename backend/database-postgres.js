// PostgreSQL database for Vercel with Neon
const { Pool } = require('pg');

// Database connection
let pool = null;

async function initializeDatabase() {
  console.log('🔧 Initializing PostgreSQL database...');
  
  // Create connection pool
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
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
      email_verified BOOLEAN DEFAULT FALSE,
      email_verification_token VARCHAR(255),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_login TIMESTAMP,
      is_active BOOLEAN DEFAULT TRUE,
      total_minutes_watched INTEGER DEFAULT 0,
      current_month_minutes INTEGER DEFAULT 0,
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

  try {
    await pool.query(createUsersTable);
    console.log('✅ Users table ready');
    await pool.query(createSessionsTable);
    console.log('✅ Watch sessions table ready');
  } catch (error) {
    console.error('❌ Error creating tables:', error);
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
      return [null, result.rows[0] || null];
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
        `INSERT INTO users (google_id, username, email, profile_picture, email_verified, auth_provider) 
         VALUES ($1, $2, $3, $4, $5, 'google') 
         RETURNING id`,
        [
          userData.googleId,
          userData.username,
          userData.email,
          userData.profilePicture || 'default.png',
          userData.emailVerified || false
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

  // Update user's watch time
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
  }
};

module.exports = { initializeDatabase, dbHelpers };
