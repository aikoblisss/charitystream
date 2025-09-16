const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const path = require('path');
const session = require('express-session');
const passport = require('passport');

const { initializeDatabase, dbHelpers } = require('./database-postgres');
// Google OAuth - Enabled for production
const passportConfig = require('./config/google-oauth');

// Email service - handle missing config gracefully
let emailService = null;
try {
  emailService = require('./services/emailService');
} catch (error) {
  console.log('⚠️ Email service not available (config file missing)');
}

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Trust proxy for Railway deployment
app.set('trust proxy', 1);

// Initialize database
initializeDatabase().catch(error => {
  console.error('❌ Database initialization failed:', error);
});

// Session configuration - Enabled for production
app.use(session({
  secret: JWT_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' } // Secure cookies in production
}));

// Initialize Passport - Enabled for production
app.use(passport.initialize());
app.use(passport.session());

// Security middleware with relaxed CSP for development
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'", 
        "'unsafe-inline'", // Allow inline scripts
        "'unsafe-hashes'", // Allow inline event handlers
        "https://vjs.zencdn.net", // Allow Video.js CDN
        "https://cdnjs.cloudflare.com" // Allow other CDNs if needed
      ],
      scriptSrcAttr: ["'unsafe-inline'"], // Specifically allow onclick handlers
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", // Allow inline styles
        "https://vjs.zencdn.net", // Allow Video.js CSS
        "https://fonts.googleapis.com", // Allow Google Fonts
        "https://fonts.gstatic.com" // Allow Google Fonts
      ],
      fontSrc: [
        "'self'",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "data:" // Allow data URLs for Video.js fonts
      ],
      mediaSrc: ["'self'", "data:", "blob:"], // Allow video files
      connectSrc: ["'self'"] // Allow API calls to same origin
    }
  }
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// CORS configuration
app.use(cors({
  origin: ['http://localhost:3000', 'http://localhost:8000', 'http://127.0.0.1:5500', 'https://*.vercel.app'],
  credentials: true
}));

app.use(bodyParser.json());

// Serve static files from public directory
app.use(express.static(path.join(__dirname, '../public')));

// Authentication middleware
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }
    req.user = user;
    next();
  });
};

// ===== USER AUTHENTICATION ROUTES =====

// Register new user
app.post('/api/auth/register', async (req, res) => {
  try {
    console.log('📝 Registration attempt:', { username: req.body.username, email: req.body.email });
    const { username, email, password } = req.body;

    // Basic validation
    if (!username || !email || !password) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ error: 'Username, email, and password are required' });
    }

    if (password.length < 6) {
      console.log('❌ Password too short');
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    console.log('🔍 Checking if user exists...');
    const [err, existingUser] = await dbHelpers.getUserByLogin(username);
    if (err) {
      console.error('❌ Database error during registration:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (existingUser) {
      console.log('❌ User already exists');
      return res.status(409).json({ error: 'Username or email already exists' });
    }

    // Hash password
    console.log('🔐 Hashing password...');
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Create user
    console.log('👤 Creating user...');
    const userData = { username, email, password_hash };
    const [createErr, newUser] = await dbHelpers.createUser(userData);
    if (createErr) {
      console.error('❌ Registration error:', createErr);
      return res.status(500).json({ error: 'Failed to create user' });
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: newUser.id, username: username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ New user registered: ${username}`);
    res.status(201).json({
      message: 'User created successfully',
      token: token,
      user: {
        id: newUser.id,
        username: username,
        email: email
      }
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Login user
app.post('/api/auth/login', async (req, res) => {
  try {
    console.log('🔑 Login attempt:', { login: req.body.login });
    const { login, password } = req.body; // login can be username or email

    if (!login || !password) {
      console.log('❌ Missing login credentials');
      return res.status(400).json({ error: 'Username/email and password are required' });
    }

    // Find user
    console.log('🔍 Looking up user...');
    const [err, user] = await dbHelpers.getUserByLogin(login);
    if (err) {
      console.error('❌ Database error during login:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.log('❌ User not found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Check password
    console.log('🔐 Checking password...');
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      console.log('❌ Password mismatch');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login time
    const [updateErr] = await dbHelpers.updateLastLogin(user.id);
    if (updateErr) {
      console.error('Error updating last login:', updateErr);
    }

    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    console.log(`✅ User logged in: ${user.username}`);
    res.json({
      message: 'Login successful',
      token: token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.subscription_tier
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user info
app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    console.log('👤 Getting user info for ID:', req.user.userId);
    const [err, user] = await dbHelpers.getUserById(req.user.userId);
    if (err || !user) {
      console.log('❌ User not found:', err);
      return res.status(404).json({ error: 'User not found' });
    }

    console.log('👤 User data from DB:', { id: user.id, username: user.username, email: user.email });
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.subscription_tier,
        profilePicture: user.profile_picture,
        emailVerified: user.email_verified,
        authProvider: user.auth_provider
      }
    });
  } catch (error) {
    console.error('Error fetching user info:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update username for Google OAuth users
app.post('/api/auth/update-username', authenticateToken, async (req, res) => {
  try {
    const { username } = req.body;
    const userId = req.user.userId;

    if (!username || username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters long' });
    }

    // Check if username is already taken
    const [err, existingUser] = await dbHelpers.getUserByLogin(username);
    if (err) {
      return res.status(500).json({ error: 'Database error' });
    }

    if (existingUser && existingUser.id !== userId) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Update username
    const [updateErr, updatedUser] = await dbHelpers.updateUsername(userId, username);
    if (updateErr) {
      console.error('Error updating username:', updateErr);
      return res.status(500).json({ error: 'Failed to update username' });
    }

    console.log(`✅ Username updated for user ${userId}: ${username}`);
    res.json({ message: 'Username updated successfully', username: username });
  } catch (error) {
    console.error('Update username error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== GOOGLE OAUTH ROUTES =====
// Enabled for production

// Test endpoint to verify database connectivity
app.get('/api/test/db', async (req, res) => {
  console.log('🧪 Testing database connectivity...');
  try {
    const [err, user] = await dbHelpers.getUserById(1);
    if (err) {
      console.error('❌ Database test failed:', err);
      return res.status(500).json({ error: 'Database connection failed', details: err.message });
    }
    console.log('✅ Database test successful');
    res.json({ message: 'Database connected successfully', user: user || 'No user with ID 1' });
  } catch (error) {
    console.error('❌ Database test error:', error);
    res.status(500).json({ error: 'Database test failed', details: error.message });
  }
});

// Google OAuth login
app.get('/api/auth/google', (req, res, next) => {
  console.log('🔐 Google OAuth login requested');
  console.log('Environment check:');
  console.log('- GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'Set' : 'Missing');
  console.log('- GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? 'Set' : 'Missing');
  console.log('- GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL || 'Using default');
  console.log('- Request URL:', req.url);
  console.log('- Request headers:', req.headers);
  
  passport.authenticate('google', {
    scope: ['profile', 'email']
  })(req, res, next);
});

// Google OAuth callback
app.get('/api/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: `${process.env.FRONTEND_URL || 'https://stream.charity'}/auth.html?error=oauth_failed` }),
  async (req, res) => {
    try {
      console.log('🔄 Google OAuth callback received');
      console.log('User object:', req.user ? 'Present' : 'Missing');
      
      if (!req.user) {
        console.error('❌ No user object in request');
        return res.redirect('/auth.html?error=no_user');
      }

      const user = req.user;
      console.log('👤 User details:', {
        id: user.id,
        email: user.email,
        username: user.username,
        googleId: user.google_id
      });
      
      // Generate verification token if email not verified and email service is available
      if (!user.email_verified && emailService) {
        console.log('📧 Generating verification token for:', user.email);
        const verificationToken = emailService.generateVerificationToken();
        
        // Update user with verification token
        const updateQuery = `UPDATE users SET email_verification_token = ? WHERE id = ?`;
        dbHelpers.db.run(updateQuery, [verificationToken, user.id], async (err) => {
          if (err) {
            console.error('Error setting verification token:', err);
          } else {
            // Send verification email
            await emailService.sendVerificationEmail(user.email, user.username, verificationToken);
          }
        });
      }

      // Generate JWT token
      console.log('🔑 Generating JWT token for user:', user.id);
      const token = jwt.sign(
        { userId: user.id, username: user.username, email: user.email },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      // Update last login
      try {
        await dbHelpers.updateLastLogin(user.id);
      } catch (err) {
        console.error('Error updating last login:', err);
      }

      console.log(`✅ Google OAuth login successful: ${user.email}`);
      console.log('🔗 Redirecting to auth.html with token');
      
      // Redirect to frontend with token
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      res.redirect(`${frontendUrl}/auth.html?token=${token}&email_verified=${user.email_verified}`);
    } catch (error) {
      console.error('❌ Google OAuth callback error:', error);
      console.error('Error stack:', error.stack);
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      res.redirect(`${frontendUrl}/auth.html?error=oauth_callback_failed`);
    }
  }
);

// Email verification endpoint
app.get('/api/auth/verify-email/:token', (req, res) => {
  const token = req.params.token;
  
  dbHelpers.getUserByVerificationToken(token, (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    // Verify the email
    dbHelpers.verifyEmail(user.id, async (err) => {
      if (err) {
        console.error('Error verifying email:', err);
        return res.status(500).json({ error: 'Failed to verify email' });
      }

      console.log(`✅ Email verified for user: ${user.email}`);
      
      // Send welcome email
      await sendWelcomeEmail(user.email, user.username);

      res.json({
        message: 'Email verified successfully!',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          emailVerified: true
        }
      });
    });
  });
});

// Resend verification email
app.post('/api/auth/resend-verification', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    dbHelpers.getUserById(userId, async (err, user) => {
      if (err || !user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.email_verified) {
        return res.status(400).json({ error: 'Email already verified' });
      }

      // Generate new verification token
      const verificationToken = generateVerificationToken();
      
      // Update user with new verification token
      const updateQuery = `UPDATE users SET email_verification_token = ? WHERE id = ?`;
      dbHelpers.db.run(updateQuery, [verificationToken, userId], async (err) => {
        if (err) {
          console.error('Error setting verification token:', err);
          return res.status(500).json({ error: 'Failed to generate verification token' });
        }

        // Send verification email
        const emailResult = await sendVerificationEmail(user.email, user.username, verificationToken);
        
        if (emailResult.success) {
          res.json({ message: 'Verification email sent successfully' });
        } else {
          res.status(500).json({ error: 'Failed to send verification email' });
        }
      });
    });
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== TRACKING ROUTES (Ready for your video player) =====

// Start watching session
app.post('/api/tracking/start-session', authenticateToken, (req, res) => {
  const { videoName, quality } = req.body;
  const userIP = req.ip || req.connection.remoteAddress;
  const userAgent = req.get('User-Agent');

  const sessionData = {
    userId: req.user.userId,
    videoName: videoName,
    quality: quality,
    userIP: userIP,
    userAgent: userAgent
  };

  dbHelpers.createWatchSession(sessionData, function(err) {
    if (err) {
      console.error('Error creating watch session:', err);
      return res.status(500).json({ error: 'Failed to start session' });
    }

    console.log(`📺 Session started: ${req.user.username} watching ${videoName} (${quality})`);
    res.json({
      sessionId: this.lastID,
      message: 'Session started'
    });
  });
});

// Complete watching session
app.post('/api/tracking/complete-session', authenticateToken, (req, res) => {
  const { sessionId, durationSeconds, completed, pausedCount } = req.body;
  const minutesWatched = Math.floor(durationSeconds / 60);

  // Complete the session
  dbHelpers.completeWatchSession(sessionId, durationSeconds, completed, pausedCount || 0, (err) => {
    if (err) {
      console.error('Error completing session:', err);
      return res.status(500).json({ error: 'Failed to complete session' });
    }

    // Update user's total watch time if completed
    if (completed && minutesWatched > 0) {
      dbHelpers.updateWatchTime(req.user.userId, minutesWatched, (err) => {
        if (err) {
          console.error('Error updating watch time:', err);
        } else {
          console.log(`⏱️ ${req.user.username} watched ${minutesWatched} minutes`);
        }
      });
    }

    res.json({
      message: 'Session completed',
      minutesWatched: minutesWatched
    });
  });
});

// ===== LEADERBOARD ROUTES =====

// Get leaderboard
app.get('/api/leaderboard', (req, res) => {
  const limit = req.query.limit || 10;
  
  dbHelpers.getLeaderboard(limit, (err, users) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get leaderboard' });
    }

    res.json({
      leaderboard: users.map((user, index) => ({
        rank: index + 1,
        username: user.username,
        minutesWatched: user.current_month_minutes,
        profilePicture: user.profile_picture
      }))
    });
  });
});

// Get user's rank
app.get('/api/leaderboard/my-rank', authenticateToken, (req, res) => {
  dbHelpers.getUserRank(req.user.userId, (err, rank) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get rank' });
    }

    res.json({
      rank: rank,
      username: req.user.username
    });
  });
});

// ===== ENHANCED ADMIN ROUTES =====

// Get comprehensive platform analytics
app.get('/api/admin/analytics', authenticateToken, (req, res) => {
  console.log('📊 Admin analytics requested by:', req.user.username);
  
  dbHelpers.getPlatformAnalytics(null, null, (err, analytics) => {
    if (err) {
      console.error('Analytics error:', err);
      return res.status(500).json({ error: 'Failed to get analytics' });
    }
    
    console.log('Analytics data:', analytics);
    res.json({ analytics });
  });
});

// Get event analytics breakdown
app.get('/api/admin/analytics/events', authenticateToken, (req, res) => {
  dbHelpers.getEventAnalytics(null, null, (err, events) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get event analytics' });
    }
    res.json({ events });
  });
});

// Get top watchers with completion rates
app.get('/api/admin/top-watchers', authenticateToken, (req, res) => {
  const limit = req.query.limit || 10;
  
  dbHelpers.getTopWatchers(limit, (err, topWatchers) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get top watchers' });
    }
    res.json({ topWatchers });
  });
});

// Get user-specific analytics
app.get('/api/admin/users/:userId/analytics', authenticateToken, (req, res) => {
  const userId = req.params.userId;
  
  dbHelpers.getUserAnalytics(userId, (err, userAnalytics) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get user analytics' });
    }
    res.json({ userAnalytics });
  });
});

// Get all users (admin only)
app.get('/api/admin/users', authenticateToken, (req, res) => {
  const limit = req.query.limit || 50;
  const offset = req.query.offset || 0;
  
  const query = `
    SELECT 
      id, username, email, created_at, last_login,
      total_minutes_watched, current_month_minutes, 
      subscription_tier, is_active
    FROM users 
    ORDER BY created_at DESC 
    LIMIT ? OFFSET ?
  `;
  
  dbHelpers.db.all(query, [limit, offset], (err, users) => {
    if (err) {
      return res.status(500).json({ error: 'Failed to get users' });
    }

    // Get total count
    dbHelpers.db.get('SELECT COUNT(*) as total FROM users', (err, countResult) => {
      res.json({
        users: users,
        total: countResult ? countResult.total : 0,
        limit: parseInt(limit),
        offset: parseInt(offset)
      });
    });
  });
});

// Get user details by ID (admin only)
app.get('/api/admin/users/:userId', authenticateToken, (req, res) => {
  const userId = req.params.userId;
  
  // Get user info
  dbHelpers.getUserById(userId, (err, user) => {
    if (err || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get user's watch sessions
    const sessionQuery = `
      SELECT video_name, quality, start_time, duration_seconds, completed
      FROM watch_sessions 
      WHERE user_id = ? 
      ORDER BY start_time DESC 
      LIMIT 20
    `;
    
    dbHelpers.db.all(sessionQuery, [userId], (err, sessions) => {
      res.json({
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          created_at: user.created_at,
          last_login: user.last_login,
          total_minutes_watched: user.total_minutes_watched,
          current_month_minutes: user.current_month_minutes,
          subscription_tier: user.subscription_tier,
          is_active: user.is_active
        },
        recentSessions: sessions || []
      });
    });
  });
});

// ===== SERVER STARTUP =====

// Handle frontend routing - serve index.html for any non-API routes
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    res.sendFile(path.join(__dirname, '../frontend/index.html'));
  }
});

app.listen(PORT, () => {
  console.log('🚀 LetsWatchAds Server Started!');
  console.log(`📡 Server running on http://localhost:${PORT}`);
  console.log(`🎬 Frontend served at http://localhost:${PORT}`);
  console.log(`🔐 API endpoints available at http://localhost:${PORT}/api/`);
  console.log('\n📋 Available endpoints:');
  console.log('   POST /api/auth/register');
  console.log('   POST /api/auth/login');
  console.log('   GET  /api/auth/me');
  console.log('   POST /api/tracking/start-session');
  console.log('   POST /api/tracking/complete-session');
  console.log('   GET  /api/leaderboard');
  console.log('   GET  /api/leaderboard/my-rank');
  console.log('   GET  /api/admin/analytics');
});