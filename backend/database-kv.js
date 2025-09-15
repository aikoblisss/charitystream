const { kv } = require('@vercel/kv');

// Initialize database tables (create initial data structure)
function initializeDatabase() {
  console.log('🔧 Initializing KV database...');
  
  // Initialize counters if they don't exist
  kv.get('user_counter').then(counter => {
    if (counter === null) {
      kv.set('user_counter', 0);
      console.log('✅ User counter initialized');
    }
  });

  kv.get('session_counter').then(counter => {
    if (counter === null) {
      kv.set('session_counter', 0);
      console.log('✅ Session counter initialized');
    }
  });

  console.log('🎉 KV database initialization complete!');
}

// Helper functions for database operations
const dbHelpers = {
  // Get user by username or email
  getUserByLogin: async (login) => {
    try {
      const users = await kv.get('users') || {};
      
      // Search through all users
      for (const [userId, user] of Object.entries(users)) {
        if (user.username === login || user.email === login) {
          return [null, user];
        }
      }
      
      return [null, null];
    } catch (error) {
      return [error, null];
    }
  },

  // Create new user (traditional)
  createUser: async (userData) => {
    try {
      const userId = await kv.incr('user_counter');
      const user = {
        id: userId,
        username: userData.username,
        email: userData.email,
        password_hash: userData.password_hash,
        profile_picture: 'default.png',
        email_verified: false,
        email_verification_token: null,
        created_at: new Date().toISOString(),
        last_login: null,
        is_active: true,
        total_minutes_watched: 0,
        current_month_minutes: 0,
        subscription_tier: 'free',
        auth_provider: 'traditional'
      };

      await kv.hset('users', userId, user);
      return [null, userId];
    } catch (error) {
      return [error, null];
    }
  },

  // Create new Google OAuth user
  createGoogleUser: async (userData) => {
    try {
      const userId = await kv.incr('user_counter');
      const user = {
        id: userId,
        google_id: userData.googleId,
        username: userData.username,
        email: userData.email,
        profile_picture: userData.profilePicture || 'default.png',
        email_verified: userData.emailVerified || false,
        email_verification_token: null,
        created_at: new Date().toISOString(),
        last_login: null,
        is_active: true,
        total_minutes_watched: 0,
        current_month_minutes: 0,
        subscription_tier: 'free',
        auth_provider: 'google'
      };

      await kv.hset('users', userId, user);
      return [null, userId];
    } catch (error) {
      return [error, null];
    }
  },

  // Get user by Google ID
  getUserByGoogleId: async (googleId) => {
    try {
      const users = await kv.get('users') || {};
      
      // Search through all users
      for (const [userId, user] of Object.entries(users)) {
        if (user.google_id === googleId) {
          return [null, user];
        }
      }
      
      return [null, null];
    } catch (error) {
      return [error, null];
    }
  },

  // Get user by ID
  getUserById: async (id) => {
    try {
      const user = await kv.hget('users', id);
      return [null, user];
    } catch (error) {
      return [error, null];
    }
  },

  // Update user's watch time
  updateWatchTime: async (userId, minutesWatched) => {
    try {
      const user = await kv.hget('users', userId);
      if (!user) {
        return [new Error('User not found'), null];
      }

      user.total_minutes_watched = (user.total_minutes_watched || 0) + minutesWatched;
      user.current_month_minutes = (user.current_month_minutes || 0) + minutesWatched;

      await kv.hset('users', userId, user);
      return [null, user];
    } catch (error) {
      return [error, null];
    }
  },

  // Update last login
  updateLastLogin: async (userId) => {
    try {
      const user = await kv.hget('users', userId);
      if (!user) {
        return [new Error('User not found'), null];
      }

      user.last_login = new Date().toISOString();
      await kv.hset('users', userId, user);
      return [null, user];
    } catch (error) {
      return [error, null];
    }
  },

  // Get all users (for admin)
  getAllUsers: async (limit = 50, offset = 0) => {
    try {
      const users = await kv.get('users') || {};
      const userArray = Object.values(users);
      
      // Sort by created_at descending
      userArray.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      
      // Apply pagination
      const paginatedUsers = userArray.slice(offset, offset + limit);
      
      return [null, paginatedUsers];
    } catch (error) {
      return [error, null];
    }
  },

  // Update username
  updateUsername: async (userId, username) => {
    try {
      const user = await kv.hget('users', userId);
      if (!user) {
        return [new Error('User not found'), null];
      }

      user.username = username;
      await kv.hset('users', userId, user);
      return [null, user];
    } catch (error) {
      return [error, null];
    }
  },

  // Create watch session
  createWatchSession: async (sessionData) => {
    try {
      const sessionId = await kv.incr('session_counter');
      const session = {
        id: sessionId,
        user_id: sessionData.userId,
        video_name: sessionData.videoName,
        quality: sessionData.quality,
        start_time: new Date().toISOString(),
        end_time: null,
        duration_seconds: null,
        completed: false,
        paused_count: 0,
        user_ip: sessionData.userIP,
        user_agent: sessionData.userAgent
      };

      await kv.hset('watch_sessions', sessionId, session);
      return [null, sessionId];
    } catch (error) {
      return [error, null];
    }
  },

  // Update watch session
  updateWatchSession: async (sessionId, updateData) => {
    try {
      const session = await kv.hget('watch_sessions', sessionId);
      if (!session) {
        return [new Error('Session not found'), null];
      }

      Object.assign(session, updateData);
      await kv.hset('watch_sessions', sessionId, session);
      return [null, session];
    } catch (error) {
      return [error, null];
    }
  }
};

module.exports = { initializeDatabase, dbHelpers };
