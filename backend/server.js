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

// Load environment variables from parent directory
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { initializeDatabase, dbHelpers } = require('./database-postgres');
// Google OAuth - Enabled for production
const passportConfig = require('./config/google-oauth');

// Email service - handle missing config gracefully
let emailService = null;
let tokenService = null;

try {
  emailService = require('./services/emailService');
  console.log('✅ Email service loaded');
} catch (error) {
  console.log('⚠️ Email service not available:', error.message);
}

try {
  tokenService = require('./services/tokenService');
  console.log('✅ Token service loaded');
} catch (error) {
  console.log('❌ Token service failed to load:', error.message);
  console.log('❌ This will cause registration to fail!');
}

// Fallback token generation if tokenService fails to load
const crypto = require('crypto');
const generateFallbackToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

const getTokenExpiry = () => {
  const now = new Date();
  return new Date(now.getTime() + (30 * 60 * 1000)); // 30 minutes
};

const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production';

// Trust proxy for Railway deployment
app.set('trust proxy', 1);

// Initialize database
initializeDatabase().catch(error => {
  console.error('❌ Database initialization failed:', error);
  console.log('⚠️ Server will continue running without database');
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
        "https://cdnjs.cloudflare.com", // Allow other CDNs if needed
        "https://js.stripe.com" // Allow Stripe.js
      ],
      scriptSrcAttr: ["'unsafe-inline'"], // Specifically allow onclick handlers
      styleSrc: [
        "'self'", 
        "'unsafe-inline'", // Allow inline styles
        "https://vjs.zencdn.net", // Allow Video.js CSS
        "https://fonts.googleapis.com", // Allow Google Fonts
        "https://fonts.gstatic.com", // Allow Google Fonts
        "https://js.stripe.com" // Allow Stripe styles
      ],
      fontSrc: [
        "'self'",
        "https://fonts.googleapis.com",
        "https://fonts.gstatic.com",
        "data:" // Allow data URLs for Video.js fonts
      ],
      mediaSrc: ["'self'", "data:", "blob:"], // Allow video files
      connectSrc: [
        "'self'", // Allow API calls to same origin
        "https://api.stripe.com" // Allow Stripe API calls
      ],
      frameSrc: [
        "'self'",
        "https://js.stripe.com" // Allow Stripe frames
      ]
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
  origin: [
    'http://localhost:8081',    // Electron app
    'http://localhost:8082',    // Electron fallback
    'http://localhost:3001',    // Your existing ports
    'https://charitystream.vercel.app',  // Vercel production
    'https://charitystream.com',         // Custom domain (if configured)
    'https://www.charitystream.com'      // Custom domain www (if configured)
  ],
  credentials: true
}));

app.use(bodyParser.json());

// Middleware to inject authentication context into HTML files
app.use((req, res, next) => {
  // Only process HTML files
  if (req.path.endsWith('.html')) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    // Store auth context for template processing
    req.authContext = {
      hasToken: !!token,
      token: token
    };
  }
  next();
});

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
    console.log('📝 Registration attempt:', { email: req.body.email });
    const { email, password, confirmPassword } = req.body;

    // Basic validation
    if (!email || !password || !confirmPassword) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ error: 'Email, password, and password confirmation are required' });
    }

    if (password !== confirmPassword) {
      console.log('❌ Passwords do not match');
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 6) {
      console.log('❌ Password too short');
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if user already exists
    console.log('🔍 Checking if user exists...');
    const [err, existingUser] = await dbHelpers.getUserByEmail(email);
    if (err) {
      console.error('❌ Database error during registration:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (existingUser) {
      console.log('❌ User already exists');
      return res.status(409).json({ error: 'Email already exists' });
    }

    // Hash password
    console.log('🔐 Hashing password...');
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Generate verification token package
    console.log('🔐 Generating verification token...');
    let tokenPackage;
    
    if (!tokenService) {
      console.log('⚠️ Using fallback token generation');
      const token = generateFallbackToken();
      const expiresAt = getTokenExpiry();
      tokenPackage = {
        token: token,
        hashedToken: token, // Store plain token for now (less secure but functional)
        expiresAt: expiresAt
      };
    } else {
      tokenPackage = await tokenService.generateVerificationPackage();
    }

    // Create user with verification token (no username yet - will be set later)
    console.log('👤 Creating user...');
    const userData = { 
      email, 
      password_hash, 
      auth_provider: 'email',
      verification_token: tokenPackage.hashedToken,
      token_expires_at: tokenPackage.expiresAt
    };
    const [createErr, newUserId] = await dbHelpers.createUserWithVerification(userData);
    if (createErr) {
      console.error('❌ Registration error:', createErr);
      return res.status(500).json({ error: 'Failed to create user' });
    }

    // Send verification email
    console.log('📧 Sending verification email...');
    const emailResult = await emailService.sendVerificationEmail(email, null, tokenPackage.token);
    if (!emailResult.success) {
      console.error('❌ Failed to send verification email:', emailResult.error);
      // Don't fail registration if email fails, but log it
    }

    console.log(`✅ New user registered: ${email}`);
    res.status(201).json({
      message: 'User created successfully. Please check your email to verify your account.',
      requiresVerification: true,
      user: {
        id: newUserId,
        email: email,
        verified: false
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
    const { login, password, rememberMe } = req.body; // login can be username or email

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

    // Check if email is verified (skip for Google users)
    if (!user.verified && user.auth_provider !== 'google' && user.auth_provider !== 'email_google') {
      console.log('❌ Email not verified');
      return res.status(401).json({ 
        error: 'Please verify your email before logging in. Check your inbox for a verification link.',
        requiresVerification: true,
        email: user.email
      });
    }

    // Check if user has a password (Google users might not have one)
    console.log('🔐 Checking password...');
    console.log('🔍 Password hash type:', typeof user.password_hash);
    console.log('🔍 Password hash value:', user.password_hash);
    console.log('🔍 Auth provider:', user.auth_provider);
    
    if (!user.password_hash || typeof user.password_hash !== 'string') {
      // User doesn't have a password - check if they're a Google user
      if (user.auth_provider === 'google' || user.auth_provider === 'email_google') {
        console.log('🔑 Google user without password - redirecting to password setup');
        return res.status(401).json({ 
          error: 'Please set up a password for your account to enable manual login.',
          requiresPasswordSetup: true,
          email: user.email,
          username: user.username
        });
      } else {
        console.log('❌ Invalid password hash in database');
        return res.status(401).json({ error: 'Invalid credentials' });
      }
    }
    
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

    // Generate JWT token with extended expiry for remember me
    const tokenExpiry = rememberMe ? '30d' : '7d'; // 30 days if remember me, 7 days otherwise
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: tokenExpiry }
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
        authProvider: user.auth_provider,
        isPremium: user.is_premium || false,
        premiumSince: user.premium_since,
        stripeSubscriptionId: user.stripe_subscription_id
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

    // Send welcome email after username is set
    if (emailService && emailService.isEmailConfigured()) {
      console.log('📧 Sending welcome email...');
      const emailResult = await emailService.sendWelcomeEmail(updatedUser.email, username);
      if (emailResult.success) {
        console.log('✅ Welcome email sent successfully');
      } else {
        console.error('❌ Failed to send welcome email:', emailResult.error);
        // Don't fail the username update if email fails
      }
    } else {
      console.log('⚠️ Email service not configured, skipping welcome email');
    }

    res.json({ message: 'Username updated successfully', username: username });
  } catch (error) {
    console.error('Update username error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Cancel incomplete Google registration
app.post('/api/auth/cancel-google-registration', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    console.log(`🗑️ Cancelling incomplete Google registration for user: ${userId}`);
    
    // Delete the incomplete Google user
    const [err, deletedUser] = await dbHelpers.deleteIncompleteGoogleUser(userId);
    if (err) {
      console.error('❌ Error deleting incomplete Google user:', err);
      return res.status(500).json({ error: 'Failed to cancel registration' });
    }
    
    console.log(`✅ Successfully cancelled Google registration for: ${deletedUser.email}`);
    res.json({ 
      message: 'Registration cancelled successfully',
      email: deletedUser.email 
    });
  } catch (error) {
    console.error('❌ Cancel Google registration error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Set up password for Google users
app.post('/api/auth/setup-password', async (req, res) => {
  try {
    const { email, password, confirmPassword } = req.body;

    // Basic validation
    if (!email || !password || !confirmPassword) {
      return res.status(400).json({ error: 'Email, password, and password confirmation are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Find user by email
    const [err, user] = await dbHelpers.getUserByEmail(email);
    if (err) {
      console.error('❌ Database error during password setup:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check if user is a Google user
    if (user.auth_provider !== 'google' && user.auth_provider !== 'email_google') {
      return res.status(400).json({ error: 'This account is not eligible for password setup' });
    }

    // Check if user already has a password
    if (user.password_hash) {
      return res.status(400).json({ error: 'Password already set for this account' });
    }

    // Hash password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    // Update user with password
    const [updateErr, updatedUser] = await dbHelpers.setupPassword(user.id, password_hash);
    if (updateErr) {
      console.error('❌ Error setting up password:', updateErr);
      return res.status(500).json({ error: 'Failed to set up password' });
    }

    console.log(`✅ Password set up for Google user: ${user.email}`);

    // Generate JWT token for immediate login
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      message: 'Password set up successfully! You are now logged in.',
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
    console.error('Setup password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== GOOGLE OAUTH ROUTES =====
// Enabled for production


// Google OAuth login
app.get('/api/auth/google', (req, res, next) => {
  const mode = req.query.mode || 'signin'; // Default to signin
  const { redirect_uri, app_type, source } = req.query;
  
  console.log('🔐 Google OAuth requested with mode:', mode);
  console.log('📱 App type:', app_type, 'Source:', source);
  console.log('Environment check:');
  console.log('- GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'Set' : 'Missing');
  console.log('- GOOGLE_CLIENT_SECRET:', process.env.GOOGLE_CLIENT_SECRET ? 'Set' : 'Missing');
  console.log('- GOOGLE_CALLBACK_URL:', process.env.GOOGLE_CALLBACK_URL || 'Using default');
  console.log('- Request URL:', req.url);
  console.log('- Request headers:', req.headers);

  // Check if this is from the Electron app
  if (app_type === 'electron' && source === 'desktop_app') {
    console.log('📱 Electron app OAuth detected');
    
    // Validate required environment variables
    if (!process.env.GOOGLE_CLIENT_ID) {
      console.error('❌ GOOGLE_CLIENT_ID environment variable is missing!');
      return res.status(500).json({ 
        error: 'Server configuration error: Google OAuth not properly configured',
        details: 'GOOGLE_CLIENT_ID environment variable is required'
      });
    }
    
    console.log('🔍 Google OAuth Configuration Check:');
    console.log('  - Client ID:', process.env.GOOGLE_CLIENT_ID);
    console.log('  - Make sure these redirect URIs are registered in Google Cloud Console:');
    console.log('    http://localhost:3001/auth/google/callback (local dev)');
    console.log('    http://localhost:8081/auth/google/callback (Electron app)');
    console.log('    https://charitystream.vercel.app/auth/google/callback (production)');
    
    // Debug: Log all input parameters
    console.log('🔍 Debug - Input parameters:');
    console.log('  - redirect_uri:', redirect_uri);
    console.log('  - mode:', mode);
    console.log('  - app_type:', app_type);
    console.log('  - source:', source);
    console.log('  - GOOGLE_CLIENT_ID:', process.env.GOOGLE_CLIENT_ID ? 'Set' : 'Missing');
    
    // Prepare state object
    const stateObject = { 
      app_type: 'electron', 
      source: 'desktop_app',
      mode: mode 
    };
    const encodedState = encodeURIComponent(JSON.stringify(stateObject));
    
    // Prepare redirect URI with fallback and validation
    // Use environment variable for production, fallback to localhost for development
    const isProduction = process.env.NODE_ENV === 'production';
    const defaultRedirectUri = isProduction 
      ? 'https://charitystream.vercel.app/auth/google/callback'
      : 'http://localhost:8081/auth/google/callback';
    const finalRedirectUri = redirect_uri || defaultRedirectUri;
    
    // Validate redirect URI format
    try {
      new URL(finalRedirectUri);
    } catch (error) {
      console.error('❌ Invalid redirect_uri format:', finalRedirectUri);
      return res.status(400).json({ 
        error: 'Invalid redirect_uri format' 
      });
    }
    
    // Debug: Log individual URL components
    console.log('🔍 Debug - URL Components:');
    console.log('  - client_id:', process.env.GOOGLE_CLIENT_ID);
    console.log('  - redirect_uri:', finalRedirectUri);
    console.log('  - encoded_redirect_uri:', encodeURIComponent(finalRedirectUri));
    console.log('  - response_type: code');
    console.log('  - scope: email profile openid');
    console.log('  - state_object:', JSON.stringify(stateObject));
    console.log('  - encoded_state:', encodedState);
    
    // For Electron app, redirect to Google OAuth with the app's callback URL
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(finalRedirectUri)}&` +
      `response_type=code&` +
      `scope=openid%20email%20profile&` +
      `access_type=offline&` +
      `prompt=consent&` +
      `state=${encodedState}`;
    
    console.log('🔍 Debug - Final Google OAuth URL:');
    console.log(googleAuthUrl);
    
    // Verify all required parameters are present
    const requiredParams = ['client_id', 'redirect_uri', 'response_type', 'scope', 'access_type', 'prompt', 'state'];
    const urlParams = new URLSearchParams(googleAuthUrl.split('?')[1]);
    console.log('🔍 Debug - Parameter verification:');
    requiredParams.forEach(param => {
      const value = urlParams.get(param);
      console.log(`  - ${param}: ${value ? '✅ Present' : '❌ Missing'} (${value || 'undefined'})`);
    });
    
    console.log('🔗 Redirecting to Google OAuth for Electron app');
    console.log('🔍 Final redirect URL length:', googleAuthUrl.length);
    console.log('🔍 URL preview (first 200 chars):', googleAuthUrl.substring(0, 200) + '...');
    
    // Additional validation before redirect
    if (googleAuthUrl.length > 2048) {
      console.error('❌ URL too long for redirect (', googleAuthUrl.length, 'chars)');
      return res.status(400).json({ error: 'OAuth URL too long' });
    }
    
    return res.redirect(googleAuthUrl);
  } else {
    console.log('🌐 Web OAuth flow');
    // Store the mode in session for the callback
    req.session.googleAuthMode = mode;

    passport.authenticate('google', {
      scope: ['profile', 'email', 'openid'],
      prompt: 'select_account' // Always show account chooser
    })(req, res, next);
  }
});

// Electron OAuth callback handler (separate from web OAuth)
app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    console.log('📱 Electron OAuth callback received');
    
    // Determine redirect URI based on environment
    const isProduction = process.env.NODE_ENV === 'production';
    const defaultRedirectUri = isProduction 
      ? 'https://charitystream.vercel.app/auth/google/callback'
      : 'http://localhost:8081/auth/google/callback';
    
    if (!code) {
      console.error('❌ No authorization code received');
      return res.redirect(`${defaultRedirectUri}?error=${encodeURIComponent('No authorization code')}`);
    }
    
    // Parse the state to check if it's from Electron app
    let stateData = {};
    if (state) {
      try {
        stateData = JSON.parse(decodeURIComponent(state));
      } catch (error) {
        console.error('❌ Error parsing state:', error);
      }
    }
    
    console.log('📊 State data:', stateData);
    
    if (stateData.app_type === 'electron') {
      console.log('📱 Processing Electron OAuth callback');
      
      // Exchange code for token with Google
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: finalRedirectUri
        })
      });
      
      const tokenData = await tokenResponse.json();
      
      if (!tokenData.access_token) {
        console.error('❌ No access token received from Google');
        return res.redirect(`${defaultRedirectUri}?error=${encodeURIComponent('Failed to get access token')}`);
      }
      
      // Get user info from Google
      const userResponse = await fetch(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokenData.access_token}`);
      const googleUser = await userResponse.json();
      
      console.log('👤 Google user data:', { email: googleUser.email, name: googleUser.name });
      
      // Find or create user in your database using existing helper
      const [err, user] = await dbHelpers.getUserByEmail(googleUser.email);
      
      if (err) {
        console.error('❌ Database error:', err);
        return res.redirect(`${defaultRedirectUri}?error=${encodeURIComponent('Database error')}`);
      }
      
      if (!user) {
        console.error('❌ User not found in database:', googleUser.email);
        return res.redirect(`${defaultRedirectUri}?error=${encodeURIComponent('User not found. Please create an account first.')}`);
      }
      
      // Update last login
      await dbHelpers.updateLastLogin(user.id);
      
      // Generate JWT token
      const token = jwt.sign(
        { userId: user.id, username: user.username, email: user.email },
        JWT_SECRET,
        { expiresIn: '30d' }
      );
      
      console.log(`✅ Electron OAuth successful for: ${user.email}`);
      
      // Redirect back to Electron app with token and user data
      const redirectUrl = `${defaultRedirectUri}?` +
        `token=${token}&` +
        `user=${encodeURIComponent(JSON.stringify({
          id: user.id,
          username: user.username,
          email: user.email,
          isPremium: user.is_premium || false,
          totalMinutesWatched: user.total_minutes_watched,
          currentMonthMinutes: user.current_month_minutes,
          subscriptionTier: user.subscription_tier,
          profilePicture: user.profile_picture,
          emailVerified: user.email_verified,
          authProvider: user.auth_provider,
          premiumSince: user.premium_since,
          stripeSubscriptionId: user.stripe_subscription_id
        }))}`;
      
      console.log('🔗 Redirecting to Electron app with user data');
      res.redirect(redirectUrl);
    } else {
      console.log('🌐 Web OAuth callback, redirecting to web flow');
      // Fall through to the regular web OAuth flow
      return res.redirect('/api/auth/google/callback?' + new URLSearchParams(req.query).toString());
    }
  } catch (error) {
    console.error('❌ Electron OAuth callback error:', error);
    console.error('Error stack:', error.stack);
    
    // Determine redirect URI based on environment for error handling
    const isProduction = process.env.NODE_ENV === 'production';
    const defaultRedirectUri = isProduction 
      ? 'https://charitystream.vercel.app/auth/google/callback'
      : 'http://localhost:8081/auth/google/callback';
    
    res.redirect(`${defaultRedirectUri}?error=${encodeURIComponent('Authentication failed')}`);
  }
});

// Google OAuth callback (for web)
app.get('/api/auth/google/callback', 
  passport.authenticate('google', { 
    failureRedirect: `${process.env.FRONTEND_URL || (process.env.NODE_ENV === 'production' ? 'https://charitystream.vercel.app' : 'http://localhost:3001')}/auth.html?error=oauth_failed`,
    session: false // We'll use JWT instead of sessions
  }),
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
        googleId: user.google_id,
        verified: user.verified,
        auth_provider: user.auth_provider
      });
      
      // Google OAuth callback - NO verification emails should be sent
      // All users coming through this callback are Google users and already verified by Google
      console.log('✅ Google OAuth callback - skipping email verification for:', user.email);

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
      
      // Check if this was a signup attempt (from state parameter)
      const authMode = req.query.state || 'signin';
      console.log('🔍 Auth mode:', authMode);
      
      // For passwordless Google auth, always check if username needs setup
      const emailPrefix = user.email.split('@')[0];
      const needsUsernameSetup = user.username === emailPrefix;
      
      console.log('📝 Needs username setup:', needsUsernameSetup);
      console.log('👤 User auth provider:', user.auth_provider || 'google');
      
      // Redirect to frontend with token and setup flag
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      res.redirect(`${frontendUrl}/auth.html?token=${token}&email_verified=${user.verified}&setup_username=${needsUsernameSetup}&auth_provider=google`);
    } catch (error) {
      console.error('❌ Google OAuth callback error:', error);
      console.error('Error stack:', error.stack);
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      res.redirect(`${frontendUrl}/auth.html?error=oauth_callback_failed`);
    }
  }
);

// Email verification endpoint
app.get('/api/auth/verify-email/:token', async (req, res) => {
  try {
    const token = req.params.token;
    console.log('📧 Email verification attempt for token:', token.substring(0, 10) + '...');
    
    // Validate token format
    if (!tokenService) {
      console.log('⚠️ Using fallback token validation');
      // Basic format check for fallback tokens
      if (!token || typeof token !== 'string' || token.length !== 64) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    } else {
      if (!tokenService.isValidTokenFormat(token)) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    }

    // Find user by verification token (database handles expiry check)
    const [err, user] = await dbHelpers.getUserByVerificationToken(token);
    if (err) {
      console.error('❌ Database error during email verification:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.log('❌ Invalid or expired verification token');
      return res.status(400).json({ error: 'Invalid or expired verification token' });
    }

    console.log('✅ Token verified successfully for user:', user.email);

    // Update user as verified and clear token
    const [updateErr] = await dbHelpers.verifyUserEmail(user.id);
    if (updateErr) {
      console.error('❌ Error updating user verification status:', updateErr);
      return res.status(500).json({ error: 'Failed to verify email' });
    }

    console.log(`✅ Email verified for user: ${user.email}`);

    // Generate JWT token for immediate login
    const jwtToken = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    // Check if user needs to set username (manual signup users)
    const emailPrefix = user.email.split('@')[0];
    const needsUsernameSetup = !user.username || user.username === emailPrefix;
    
    res.json({
      message: 'Email verified successfully!',
      token: jwtToken,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        verified: true,
        totalMinutesWatched: user.total_minutes_watched,
        currentMonthMinutes: user.current_month_minutes,
        subscriptionTier: user.subscription_tier
      },
      needsUsernameSetup: needsUsernameSetup
    });
  } catch (error) {
    console.error('❌ Email verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Resend verification email endpoint (with rate limiting)
const resendVerificationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3, // Maximum 3 requests per hour per IP
  message: { error: 'Too many verification email requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Forgot password rate limiting
const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Maximum 5 requests per hour per IP
  message: { error: 'Too many password reset requests. Please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post('/api/auth/resend-verification', resendVerificationLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('📧 Resend verification request for:', email);

    // Find user by email
    const [err, user] = await dbHelpers.getUserByEmail(email);
    if (err) {
      console.error('❌ Database error during resend verification:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.verified) {
      return res.status(400).json({ error: 'Email already verified' });
    }

    // Don't allow Google users to resend verification emails
    if (user.auth_provider === 'google' || user.auth_provider === 'email_google') {
      return res.status(400).json({ error: 'Google users do not need email verification' });
    }

    // Generate new verification token package
    let tokenPackage;
    
    if (!tokenService) {
      console.log('⚠️ Using fallback token generation for resend');
      const token = generateFallbackToken();
      const expiresAt = getTokenExpiry();
      tokenPackage = {
        token: token,
        hashedToken: token, // Store plain token for now (less secure but functional)
        expiresAt: expiresAt
      };
    } else {
      tokenPackage = await tokenService.generateVerificationPackage();
    }
    
    // Update user with new token
    const [updateErr] = await dbHelpers.updateVerificationToken(
      user.id, 
      tokenPackage.hashedToken, 
      tokenPackage.expiresAt
    );
    if (updateErr) {
      console.error('❌ Error updating verification token:', updateErr);
      return res.status(500).json({ error: 'Failed to generate verification token' });
    }

    // Send verification email
    const emailResult = await emailService.sendVerificationEmail(
      user.email, 
      user.username, 
      tokenPackage.token
    );
    if (!emailResult.success) {
      console.error('❌ Failed to send verification email:', emailResult.error);
      return res.status(500).json({ error: 'Failed to send verification email' });
    }

    console.log('✅ Verification email resent to:', user.email);
    res.json({ message: 'Verification email sent successfully' });

  } catch (error) {
    console.error('❌ Resend verification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Forgot password endpoint
app.post('/api/auth/forgot-password', forgotPasswordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    console.log('🔐 Password reset request for:', email);

    // Find user by email
    const [err, user] = await dbHelpers.getUserByEmail(email);
    if (err) {
      console.error('❌ Database error during forgot password:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    // Always return success message for security (don't reveal if email exists)
    const successMessage = 'If an account exists for this email, a reset link has been sent.';

    if (!user) {
      console.log('📧 Email not found, but returning success message for security');
      return res.json({ success: true, message: successMessage });
    }

    // Allow Google users to set their first password via forgot password flow
    if (user.auth_provider === 'google' || user.auth_provider === 'email_google') {
      console.log('📧 Google user setting up password for manual login');
    }

    // Generate reset token package
    let tokenPackage;
    
    if (!tokenService) {
      console.log('⚠️ Using fallback token generation for password reset');
      const token = generateFallbackToken();
      const expiresAt = new Date(Date.now() + (30 * 60 * 1000)); // 30 minutes
      tokenPackage = {
        token: token,
        hashedToken: token, // Store plain token for now (less secure but functional)
        expiresAt: expiresAt
      };
    } else {
      tokenPackage = await tokenService.generateVerificationPackage();
    }

    // Update user with reset token
    const [updateErr] = await dbHelpers.setPasswordResetToken(
      user.id, 
      tokenPackage.hashedToken, 
      tokenPackage.expiresAt
    );
    if (updateErr) {
      console.error('❌ Error setting password reset token:', updateErr);
      return res.status(500).json({ error: 'Failed to generate reset token' });
    }

    // Send password reset email
    let emailSent = false;
    let emailError = null;
    
    if (emailService && emailService.isEmailConfigured()) {
      console.log('📧 Sending password reset email...');
      const emailResult = await emailService.sendPasswordResetEmail(
        user.email, 
        user.username || user.email.split('@')[0], 
        tokenPackage.token,
        user.auth_provider === 'google' || user.auth_provider === 'email_google'
      );
      if (emailResult.success) {
        console.log('✅ Password reset email sent successfully');
        emailSent = true;
      } else {
        console.error('❌ Failed to send password reset email:', emailResult.error);
        emailError = emailResult.error;
      }
    } else {
      console.log('⚠️ Email service not configured, skipping password reset email');
      emailError = 'Email service not configured';
    }

    // Always respond with success for the token creation, but note email status
    if (emailSent) {
      console.log('✅ Password reset email sent to:', user.email);
      res.json({ 
        success: true, 
        message: successMessage,
        note: 'Email sent! Delivery may take 1-5 minutes for new email addresses.'
      });
    } else {
      console.log('⚠️ Password reset token created but email failed to send:', user.email);
      res.json({ 
        success: true, 
        message: 'Password reset token created successfully. Email delivery failed - please try again.',
        error: emailError,
        note: 'You can try requesting another reset email in a few minutes.'
      });
    }

  } catch (error) {
    console.error('❌ Forgot password error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset password endpoint (GET - show form)
app.get('/api/auth/reset-password', async (req, res) => {
  try {
    const token = req.query.token;
    
    if (!token) {
      return res.status(400).json({ error: 'Reset token is required' });
    }

    console.log('🔐 Password reset form request for token:', token.substring(0, 10) + '...');

    // Validate token format
    if (!tokenService) {
      console.log('⚠️ Using fallback token validation');
      if (!token || typeof token !== 'string' || token.length !== 64) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    } else {
      if (!tokenService.isValidTokenFormat(token)) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    }

    // Find user by reset token
    const [err, user] = await dbHelpers.getUserByResetToken(token);
    if (err) {
      console.error('❌ Database error during token validation:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.log('❌ Invalid or expired reset token');
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    console.log('✅ Reset token validated for user:', user.email);
    res.json({ 
      success: true, 
      message: 'Token is valid',
      user: {
        email: user.email,
        username: user.username
      }
    });

  } catch (error) {
    console.error('❌ Reset password validation error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Reset password endpoint (POST - submit new password)
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password, confirmPassword } = req.body;
    
    if (!token || !password || !confirmPassword) {
      return res.status(400).json({ error: 'Token, password, and password confirmation are required' });
    }

    if (password !== confirmPassword) {
      return res.status(400).json({ error: 'Passwords do not match' });
    }

    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    console.log('🔐 Password reset submission for token:', token.substring(0, 10) + '...');

    // Validate token format
    if (!tokenService) {
      console.log('⚠️ Using fallback token validation');
      if (!token || typeof token !== 'string' || token.length !== 64) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    } else {
      if (!tokenService.isValidTokenFormat(token)) {
        console.log('❌ Invalid token format');
        return res.status(400).json({ error: 'Invalid token format' });
      }
    }

    // Find user by reset token
    const [err, user] = await dbHelpers.getUserByResetToken(token);
    if (err) {
      console.error('❌ Database error during password reset:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (!user) {
      console.log('❌ Invalid or expired reset token');
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    console.log('✅ Reset token validated for user:', user.email);

    // Check if new password is different from old password (only if user has an existing password)
    if (user.password_hash && typeof user.password_hash === 'string') {
      const isSamePassword = await bcrypt.compare(password, user.password_hash);
      if (isSamePassword) {
        console.log('❌ New password cannot be the same as the current password');
        return res.status(400).json({ error: 'New password must be different from your current password' });
      }
    } else {
      console.log('🔑 Setting up first password for Google user:', user.email);
    }

    // Hash new password
    const saltRounds = 10;
    const newPasswordHash = await bcrypt.hash(password, saltRounds);

    // Update user password and clear reset token
    const [updateErr] = await dbHelpers.resetUserPassword(user.id, newPasswordHash);
    if (updateErr) {
      console.error('❌ Error updating password:', updateErr);
      return res.status(500).json({ error: 'Failed to update password' });
    }

    console.log(`✅ Password ${user.password_hash ? 'reset' : 'setup'} successful for user: ${user.email}`);

    const message = user.password_hash 
      ? 'Password has been reset successfully. You can now log in with your new password.'
      : 'Password has been set up successfully! You can now log in manually with your email and password.';

    res.json({
      success: true,
      message: message
    });

  } catch (error) {
    console.error('❌ Password reset error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check username availability endpoint
app.post('/api/auth/check-username', async (req, res) => {
  try {
    const { username } = req.body;
    
    if (!username) {
      return res.status(400).json({ error: 'Username is required' });
    }

    // Basic validation
    if (username.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }

    if (username.length > 20) {
      return res.status(400).json({ error: 'Username must be no more than 20 characters' });
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
      return res.status(400).json({ error: 'Username can only contain letters, numbers, underscores, and hyphens' });
    }

    if (username.includes(' ')) {
      return res.status(400).json({ error: 'Username cannot contain spaces' });
    }

    console.log('🔍 Checking username availability:', username);

    // Check availability
    const [err, available] = await dbHelpers.checkUsernameAvailability(username);
    if (err) {
      console.error('❌ Database error during username check:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    res.json({ 
      available: available,
      username: username
    });

  } catch (error) {
    console.error('❌ Username check error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Database test endpoint
app.get('/api/test/db', async (req, res) => {
  try {
    console.log('🧪 Testing database connectivity...');
    
    const { Pool } = require('pg');
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      return res.status(500).json({ error: 'DATABASE_URL not configured' });
    }
    
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
        require: true
      }
    });
    
    // Test connection
    const result = await pool.query('SELECT NOW()');
    console.log('✅ Connected to PostgreSQL database');
    console.log('📅 Database time:', result.rows[0].now);
    
    // Test verification token query
    const tokenTest = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND column_name IN ('verified', 'verification_token', 'token_expires_at')
    `);
    
    console.log('📋 Verification columns:', tokenTest.rows.map(row => row.column_name));
    
    await pool.end();
    
    res.json({
      message: 'Database test successful',
      databaseTime: result.rows[0].now,
      verificationColumns: tokenTest.rows.map(row => row.column_name)
    });
  } catch (error) {
    console.error('❌ Database test failed:', error);
    res.status(500).json({ error: 'Database test failed', details: error.message });
  }
});

// Migration endpoint (remove after running once)
app.post('/api/admin/migrate-verification', async (req, res) => {
  try {
    console.log('🔧 Starting database migration for email verification...');
    
    // Import the database module to get access to the pool
    const { Pool } = require('pg');
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      return res.status(500).json({ error: 'DATABASE_URL not configured' });
    }
    
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
        require: true
      }
    });
    
    // Check if all required columns exist
    const checkColumns = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'users' 
      AND column_name IN ('verified', 'verification_token', 'token_expires_at', 'reset_password_token', 'reset_password_expires')
    `);

    const existingColumns = checkColumns.rows.map(row => row.column_name);
    console.log('📋 Existing columns:', existingColumns);

    // Add missing columns
    const columnsToAdd = [
      { name: 'verified', sql: 'ALTER TABLE users ADD COLUMN verified BOOLEAN DEFAULT FALSE' },
      { name: 'verification_token', sql: 'ALTER TABLE users ADD COLUMN verification_token VARCHAR(255)' },
      { name: 'token_expires_at', sql: 'ALTER TABLE users ADD COLUMN token_expires_at TIMESTAMP' },
      { name: 'reset_password_token', sql: 'ALTER TABLE users ADD COLUMN reset_password_token VARCHAR(255)' },
      { name: 'reset_password_expires', sql: 'ALTER TABLE users ADD COLUMN reset_password_expires TIMESTAMP' }
    ];

    for (const column of columnsToAdd) {
      if (!existingColumns.includes(column.name)) {
        try {
          console.log(`➕ Adding ${column.name} column...`);
          await pool.query(column.sql);
          console.log(`✅ ${column.name} column added`);
        } catch (error) {
          if (error.code === '42701') {
            console.log(`⚠️ Column ${column.name} already exists`);
          } else {
            console.error(`❌ Error adding ${column.name} column:`, error.message);
          }
        }
      } else {
        console.log(`✅ ${column.name} column already exists`);
      }
    }

    // Update existing users to be verified
    console.log('🔄 Updating existing users to verified status...');
    const updateResult = await pool.query('UPDATE users SET verified = TRUE WHERE verified IS NULL');
    console.log(`✅ Updated ${updateResult.rowCount} existing users to verified`);

    await pool.end();

    res.json({ 
      message: 'Migration completed successfully',
      addedColumns: existingColumns.length === 0 ? ['verified', 'verification_token', 'token_expires_at'] : [],
      updatedUsers: updateResult.rowCount
    });
  } catch (error) {
    console.error('❌ Migration error:', error);
    res.status(500).json({ error: 'Migration failed', details: error.message });
  }
});

// Database reset endpoint (remove after use)
app.post('/api/admin/reset-database', async (req, res) => {
  try {
    console.log('🗑️ Starting database reset...');
    
    const { Pool } = require('pg');
    const databaseUrl = process.env.DATABASE_URL;
    
    if (!databaseUrl) {
      return res.status(500).json({ error: 'DATABASE_URL not configured' });
    }
    
    const pool = new Pool({
      connectionString: databaseUrl,
      ssl: {
        rejectUnauthorized: false,
        require: true
      }
    });
    
    // Check which tables exist and clear them (in correct order due to foreign keys)
    const tablesToClear = [
      'event_tracking',
      'watch_sessions', 
      'daily_analytics',
      'users'
    ];
    
    const clearedTables = [];
    
    for (const tableName of tablesToClear) {
      try {
        // Check if table exists
        const tableExists = await pool.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.tables 
            WHERE table_schema = 'public' 
            AND table_name = $1
          )
        `, [tableName]);
        
        if (tableExists.rows[0].exists) {
          console.log(`🗑️ Clearing ${tableName} table...`);
          await pool.query(`DELETE FROM ${tableName}`);
          clearedTables.push(tableName);
          console.log(`✅ ${tableName} table cleared`);
        } else {
          console.log(`⚠️ ${tableName} table does not exist, skipping`);
        }
      } catch (error) {
        console.error(`❌ Error clearing ${tableName} table:`, error.message);
        // Continue with other tables even if one fails
      }
    }
    
    // Reset auto-increment sequences (only for existing tables)
    console.log('🔄 Resetting sequences...');
    const sequencesToReset = [
      'users_id_seq',
      'watch_sessions_id_seq', 
      'event_tracking_id_seq',
      'daily_analytics_id_seq'
    ];
    
    for (const sequenceName of sequencesToReset) {
      try {
        await pool.query(`ALTER SEQUENCE IF EXISTS ${sequenceName} RESTART WITH 1`);
        console.log(`✅ ${sequenceName} reset`);
      } catch (error) {
        console.log(`⚠️ ${sequenceName} does not exist, skipping`);
      }
    }
    
    await pool.end();
    
    res.json({ 
      message: 'Database reset completed successfully',
      clearedTables: clearedTables,
      clearedData: clearedTables.includes('users') ? ['user accounts', 'password reset tokens', 'verification tokens'] : [],
      skippedTables: tablesToClear.filter(table => !clearedTables.includes(table)),
      resetSequences: sequencesToReset
    });
  } catch (error) {
    console.error('❌ Reset error:', error);
    res.status(500).json({ error: 'Reset failed', details: error.message });
  }
});

// ===== TRACKING ROUTES (Ready for your video player) =====

// Start watching session
app.post('/api/tracking/start-session', authenticateToken, async (req, res) => {
  try {
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

    const [err, sessionId] = await dbHelpers.createWatchSession(sessionData);
    if (err) {
      console.error('Error creating watch session:', err);
      return res.status(500).json({ error: 'Failed to start session' });
    }

    console.log(`📺 Session started: ${req.user.username} watching ${videoName} (${quality})`);
    res.json({
      sessionId: sessionId,
      message: 'Session started'
    });
  } catch (error) {
    console.error('Error in start-session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete watching session
app.post('/api/tracking/complete-session', authenticateToken, async (req, res) => {
  try {
    const { sessionId, durationSeconds, completed, pausedCount } = req.body;
    const minutesWatched = Math.floor(durationSeconds / 60);

    // Complete the session
    const [err] = await dbHelpers.updateWatchSession(sessionId, {
      end_time: new Date(),
      duration_seconds: durationSeconds,
      completed: completed,
      paused_count: pausedCount || 0
    });

    if (err) {
      console.error('Error completing session:', err);
      return res.status(500).json({ error: 'Failed to complete session' });
    }

    // Note: Watch time is now tracked per-ad via updateWatchSeconds, not per-session
    // This prevents double-tracking and ensures immediate minute updates

    res.json({
      message: 'Session completed',
      minutesWatched: minutesWatched
    });
  } catch (error) {
    console.error('Error in complete-session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== AD TRACKING ENDPOINTS =====

// Start ad tracking
app.post('/api/tracking/start-ad', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const [err, adTrackingId] = await dbHelpers.startAdTracking(req.user.userId, sessionId);
    if (err) {
      console.error('Error starting ad tracking:', err);
      return res.status(500).json({ error: 'Failed to start ad tracking' });
    }

    console.log(`📺 Ad tracking started for user ${req.user.userId}, session ${sessionId}`);
    res.json({
      adTrackingId: adTrackingId,
      message: 'Ad tracking started'
    });
  } catch (error) {
    console.error('Error in start-ad:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete ad tracking
app.post('/api/tracking/complete-ad', authenticateToken, async (req, res) => {
  try {
    const { adTrackingId, durationSeconds, completed = true } = req.body;
    
    const [err, adTracking] = await dbHelpers.completeAdTracking(adTrackingId, durationSeconds, completed);
    if (err) {
      console.error('Error completing ad tracking:', err);
      return res.status(500).json({ error: 'Failed to complete ad tracking' });
    }

    // Update daily stats and user's monthly minutes if ad was completed
    if (completed && durationSeconds > 0) {
      const [statsErr] = await dbHelpers.updateDailyStats(req.user.userId, 1, durationSeconds);
      if (statsErr) {
        console.error('Error updating daily stats:', statsErr);
      } else {
        console.log(`📊 Updated daily stats for user ${req.user.userId}`);
      }

      // Update user's total and monthly watch time (record seconds every time an ad completes)
      const secondsWatched = parseInt(durationSeconds, 10) || 0;
      console.log('🔍 Backend received ad completion:', {
        userId: req.user.userId,
        username: req.user.username,
        durationSeconds: durationSeconds,
        parsedSeconds: secondsWatched,
        willUpdateMonthly: secondsWatched > 0
      });
      if (secondsWatched > 0) {
        const [watchTimeErr, updatedUser] = await dbHelpers.updateWatchSeconds(req.user.userId, secondsWatched);
        if (watchTimeErr) {
          console.error('Error updating watch seconds:', watchTimeErr);
        } else {
          console.log(`⏱️ ${req.user.username} watched ${secondsWatched} seconds (${durationSeconds} sec) - Total: ${updatedUser.total_seconds_watched}s, Monthly: ${updatedUser.current_month_seconds}s`);
        }
      }
    }

    res.json({
      message: 'Ad tracking completed',
      durationSeconds: durationSeconds
    });
  } catch (error) {
    console.error('Error in complete-ad:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ===== LEADERBOARD ROUTES =====

// Get monthly leaderboard (top 5 users)
app.get('/api/leaderboard/monthly', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 5;
    const [err, leaderboard] = await dbHelpers.getMonthlyLeaderboard(limit);
    
    if (err) {
      console.error('Error getting monthly leaderboard:', err);
      return res.status(500).json({ error: 'Failed to get leaderboard' });
    }

    res.json({
      leaderboard: leaderboard.map((user, index) => ({
        rank: user.rank_number,
        username: user.username,
        minutesWatched: Math.floor(user.current_month_seconds / 60),
        profilePicture: user.profile_picture,
        adsWatchedToday: user.ads_watched_today,
        streakDays: user.streak_days,
        accountAgeDays: Math.floor((new Date() - new Date(user.created_at)) / (1000 * 60 * 60 * 24))
      }))
    });
  } catch (error) {
    console.error('Error in monthly leaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's impact data
// Restore daily stats endpoint (for recovery purposes)
app.post('/api/debug/restore-daily-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const { adsWatched, watchTimeSeconds = 0, date } = req.body;
    
    if (!adsWatched || adsWatched < 0) {
      return res.status(400).json({ error: 'Invalid ads watched count' });
    }
    
    const [err, restoredStats] = await dbHelpers.restoreDailyStats(userId, adsWatched, watchTimeSeconds, date);
    
    if (err) {
      console.error('Error restoring daily stats:', err);
      return res.status(500).json({ error: 'Failed to restore daily stats' });
    }
    
    res.json({
      message: 'Daily stats restored successfully',
      restoredStats: restoredStats
    });
  } catch (error) {
    console.error('Error in restore endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Debug endpoint to check daily stats
app.get('/api/debug/daily-stats', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const [err, debugData] = await dbHelpers.debugDailyStats(userId);
    
    if (err) {
      console.error('Error getting debug data:', err);
      return res.status(500).json({ error: 'Failed to get debug data' });
    }
    
    res.json({
      userId: userId,
      debugData: debugData,
      currentTime: new Date().toISOString(),
      currentDate: new Date().toISOString().split('T')[0]
    });
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/user/impact', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    
    // Get all user data in parallel
    const [
      [adsTodayErr, adsWatchedToday],
      [totalAdsErr, totalAdsWatched],
      [monthlyRankErr, monthlyRank],
      [overallRankErr, overallRank],
      [totalUsersErr, totalUsers],
      [accountAgeErr, accountAgeDays],
      [streakErr, streakDays],
      [userErr, user]
    ] = await Promise.all([
      dbHelpers.getAdsWatchedToday(userId),
      dbHelpers.getTotalAdsWatched(userId),
      dbHelpers.getUserMonthlyRank(userId),
      dbHelpers.getUserOverallRank(userId),
      dbHelpers.getTotalActiveUsers(),
      dbHelpers.getUserAccountAge(userId),
      dbHelpers.calculateUserStreak(userId),
      dbHelpers.getUserById(userId)
    ]);

    if (userErr || !user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      impact: {
        adsWatchedToday: adsWatchedToday,
        totalAdsWatched: totalAdsWatched,
        currentRank: monthlyRank,
        overallRank: overallRank,
        totalUsers: totalUsers,
        watchTimeMinutes: Math.floor((user.current_month_seconds || 0) / 60),
        totalWatchTimeMinutes: Math.floor((user.total_seconds_watched || 0) / 60),
        streakDays: streakDays,
        accountAgeDays: accountAgeDays,
        donationsGenerated: Math.round(totalAdsWatched * 0.01) // Placeholder: $0.01 per ad
      }
    });
  } catch (error) {
    console.error('Error getting user impact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get user's rank
app.get('/api/leaderboard/my-rank', authenticateToken, async (req, res) => {
  try {
    const [err, rank] = await dbHelpers.getUserMonthlyRank(req.user.userId);
    
    if (err) {
      console.error('Error getting user rank:', err);
      return res.status(500).json({ error: 'Failed to get rank' });
    }

    res.json({
      rank: rank,
      username: req.user.username
    });
  } catch (error) {
    console.error('Error in my-rank:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Legacy leaderboard endpoint (for backward compatibility)
app.get('/api/leaderboard', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const [err, leaderboard] = await dbHelpers.getMonthlyLeaderboard(limit);
    
    if (err) {
      console.error('Error getting leaderboard:', err);
      return res.status(500).json({ error: 'Failed to get leaderboard' });
    }

    res.json({
      leaderboard: leaderboard.map((user, index) => ({
        rank: index + 1,
        username: user.username,
        minutesWatched: user.current_month_minutes,
        profilePicture: user.profile_picture
      }))
    });
  } catch (error) {
    console.error('Error in leaderboard:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
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

// ===== STRIPE INTEGRATION =====
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// ===== SUBSCRIPTION ROUTES =====

// Create subscription payment intent
app.post('/api/subscribe/create-payment-intent', authenticateToken, async (req, res) => {
  try {
    console.log('💳 Creating subscription for user:', req.user.userId);
    console.log('📧 User email:', req.user.email);
    
    // Check if Stripe is properly initialized
    if (!process.env.STRIPE_SECRET_KEY) {
      console.error('❌ STRIPE_SECRET_KEY environment variable is not set');
      return res.status(500).json({ error: 'Stripe configuration missing' });
    }

    if (!process.env.STRIPE_PRICE_ID) {
      console.error('❌ STRIPE_PRICE_ID environment variable is not set');
      return res.status(500).json({ error: 'Stripe price ID missing' });
    }

    console.log('🔧 Stripe secret key available:', !!process.env.STRIPE_SECRET_KEY);
    console.log('🔧 Stripe price ID:', process.env.STRIPE_PRICE_ID);

    // Get or create customer
    let customer;
    let customerId = null;

    // Check if user already has a Stripe customer ID
    const [userErr, user] = await dbHelpers.getUserById(req.user.userId);
    if (userErr) {
      console.error('❌ Error fetching user:', userErr);
      return res.status(500).json({ error: 'Failed to fetch user data' });
    }

    if (user.stripe_customer_id) {
      // Use existing customer
      try {
        customer = await stripe.customers.retrieve(user.stripe_customer_id);
        customerId = customer.id;
        console.log('✅ Found existing customer:', customerId);
      } catch (error) {
        console.log('⚠️ Existing customer not found, creating new one');
        customerId = null;
      }
    }

    if (!customerId) {
      // Create new customer
      try {
        customer = await stripe.customers.create({
          email: req.user.email,
          name: req.user.username,
          metadata: {
            userId: req.user.userId,
            username: req.user.username
          }
        });
        customerId = customer.id;
        console.log('✅ Created new customer:', customerId);

        // Save customer ID to database
        const [updateErr] = await dbHelpers.updateStripeCustomerId(req.user.userId, customerId);
        if (updateErr) {
          console.error('❌ Failed to save customer ID:', updateErr);
        }
      } catch (customerError) {
        console.error('❌ Customer creation failed:', customerError);
        return res.status(500).json({ error: 'Failed to create customer' });
      }
    }

    console.log('🔧 Creating subscription...');

    // Create subscription
    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{ price: process.env.STRIPE_PRICE_ID }],
      payment_behavior: 'default_incomplete',
      expand: ['latest_invoice.payment_intent'],
      metadata: {
        userId: req.user.userId,
        username: req.user.username
      }
    });

    console.log('✅ Subscription created:', subscription.id);
    console.log('🔐 Client secret:', subscription.latest_invoice.payment_intent.client_secret);

    // Save subscription ID to database
    const [subUpdateErr] = await dbHelpers.updateStripeSubscriptionId(req.user.userId, subscription.id);
    if (subUpdateErr) {
      console.error('❌ Failed to save subscription ID:', subUpdateErr);
    }

    res.json({
      clientSecret: subscription.latest_invoice.payment_intent.client_secret,
      subscriptionId: subscription.id
    });
  } catch (error) {
    console.error('❌ Subscription creation failed:', error);
    console.error('❌ Error details:', error.message);
    console.error('❌ Error type:', error.type);
    console.error('❌ Error code:', error.code);
    res.status(500).json({ 
      error: 'Failed to create subscription',
      details: error.message,
      type: error.type,
      code: error.code
    });
  }
});

// Get subscription status
app.get('/api/subscribe/status', authenticateToken, async (req, res) => {
  try {
    const { subscriptionId } = req.query;
    
    if (!subscriptionId) {
      return res.status(400).json({ error: 'Subscription ID is required' });
    }

    console.log('🔍 Checking subscription status:', subscriptionId);

    // Retrieve subscription from Stripe
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    console.log('📊 Subscription status:', subscription.status);

    const isActive = subscription.status === 'active' || subscription.status === 'trialing';
    
    // Update user's premium status in database
    const [updateErr] = await dbHelpers.updatePremiumStatus(req.user.userId, isActive);
    if (updateErr) {
      console.error('❌ Failed to update premium status:', updateErr);
    }

    res.json({ 
      isPremium: isActive,
      status: subscription.status,
      subscriptionId: subscription.id
    });
  } catch (error) {
    console.error('❌ Subscription status check failed:', error);
    res.status(500).json({ 
      error: 'Failed to check subscription status',
      details: error.message
    });
  }
});

// Stripe webhook endpoint
app.post('/api/webhook', express.raw({type: 'application/json'}), (req, res) => {
  const sig = req.headers['stripe-signature'];
  const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.log('❌ Webhook signature verification failed:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  console.log('🔔 Webhook received:', event.type);

  // Handle the event
  switch (event.type) {
    case 'invoice.payment_succeeded':
      const invoice = event.data.object;
      console.log('✅ Payment succeeded for invoice:', invoice.id);
      
      if (invoice.subscription) {
        // Update user to premium
        dbHelpers.updatePremiumStatusBySubscriptionId(invoice.subscription, true)
          .then(() => console.log('✅ User updated to premium'))
          .catch(err => console.error('❌ Failed to update premium status:', err));
      }
      break;
      
    case 'customer.subscription.deleted':
      const deletedSubscription = event.data.object;
      console.log('❌ Subscription deleted:', deletedSubscription.id);
      
      // Update user to not premium
      dbHelpers.updatePremiumStatusBySubscriptionId(deletedSubscription.id, false)
        .then(() => console.log('✅ User updated to not premium'))
        .catch(err => console.error('❌ Failed to update premium status:', err));
      break;
      
    case 'invoice.payment_failed':
      const failedInvoice = event.data.object;
      console.log('❌ Payment failed for invoice:', failedInvoice.id);
      
      if (failedInvoice.subscription) {
        // Update user to not premium
        dbHelpers.updatePremiumStatusBySubscriptionId(failedInvoice.subscription, false)
          .then(() => console.log('✅ User updated to not premium'))
          .catch(err => console.error('❌ Failed to update premium status:', err));
      }
      break;
      
    default:
      console.log(`Unhandled event type ${event.type}`);
  }

  res.json({received: true});
});

// ===== CLEAN URL ROUTING =====
// Handle clean URLs without .html extension
const cleanUrlRoutes = {
  '/about': 'about.html',
  '/advertise': 'advertise.html', 
  '/auth': 'auth.html',
  '/impact': 'impact.html',
  '/subscribe': 'subscribe.html',
  '/admin': 'admin.html',
  '/charity': 'charity.html',
  '/lander': 'lander.html',
  '/reset-password': 'reset-password.html',
  '/verify-email': 'verify-email.html',
};

// Add routes for clean URLs
Object.entries(cleanUrlRoutes).forEach(([route, file]) => {
  app.get(route, (req, res) => {
    res.sendFile(path.join(__dirname, '../public', file));
  });
});

// Add specific routes for advertise sub-pages
app.get('/advertise/company', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/advertiser.html'));
});

app.get('/advertise/charity', (req, res) => {
  res.sendFile(path.join(__dirname, '../public/charity.html'));
});

// Serve PDF files from Terms and Conditions folder
app.use('/Terms and Conditions', express.static(path.join(__dirname, '../public/Terms and Conditions')));

// Handle frontend routing - serve index.html for any non-API routes that aren't clean URLs
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api/')) {
    // Check if this is a clean URL route
    const cleanUrlRoutes = ['/about', '/advertise', '/auth', '/impact', '/subscribe', '/admin', '/charity', '/lander', '/reset-password', '/verify-email', '/advertise/company', '/advertise/charity'];
    
    if (cleanUrlRoutes.includes(req.path)) {
      // This should have been handled by the specific routes above


      // If we reach here, something went wrong with the specific routes
      console.log('⚠️ Clean URL route not handled:', req.path);
      return res.status(404).send('Route not found');
    }
    
    // Serve index.html for all other routes (like /, /some-other-page, etc.)
    res.sendFile(path.join(__dirname, '../public/index.html'));
  }
});

app.listen(PORT, () => {
  console.log('🚀 LetsWatchAds Server Started!');
  if (process.env.NODE_ENV === 'production') {
    console.log(`🌐 Production server running on port ${PORT}`);
    console.log(`🔗 Deployed at: https://charitystream.vercel.app`);
  } else {
    console.log(`📡 Server running on http://localhost:${PORT}`);
    console.log(`🎬 Frontend served at http://localhost:${PORT}`);
  }
  console.log(`🔐 API endpoints available at /api/`);
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

// Test Stripe connection
app.get('/api/test/stripe', (req, res) => {
  try {
    console.log('🔧 Testing Stripe connection...');
    console.log('🔧 Stripe secret key available:', !!process.env.STRIPE_SECRET_KEY);
    console.log('🔧 Stripe secret key starts with:', process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.substring(0, 7) : 'undefined');
    console.log('🔧 Stripe publishable key available:', !!process.env.STRIPE_PUBLISHABLE_KEY);
    console.log('🔧 Stripe publishable key starts with:', process.env.STRIPE_PUBLISHABLE_KEY ? process.env.STRIPE_PUBLISHABLE_KEY.substring(0, 7) : 'undefined');
    console.log('🔧 Stripe price ID available:', !!process.env.STRIPE_PRICE_ID);
    console.log('🔧 Stripe price ID:', process.env.STRIPE_PRICE_ID);
    
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'STRIPE_SECRET_KEY not set' });
    }
    
    if (!process.env.STRIPE_PUBLISHABLE_KEY) {
      return res.status(500).json({ error: 'STRIPE_PUBLISHABLE_KEY not set' });
    }
    
    res.json({ 
      message: 'Stripe configuration looks good',
      hasSecretKey: !!process.env.STRIPE_SECRET_KEY,
      hasPublishableKey: !!process.env.STRIPE_PUBLISHABLE_KEY,
      hasPriceId: !!process.env.STRIPE_PRICE_ID,
      keyPrefix: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.substring(0, 7) : 'undefined',
      publishableKeyPrefix: process.env.STRIPE_PUBLISHABLE_KEY ? process.env.STRIPE_PUBLISHABLE_KEY.substring(0, 7) : 'undefined',
      priceId: process.env.STRIPE_PRICE_ID
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Simple Stripe test
app.get('/api/test/stripe-simple', (req, res) => {
  try {
    const hasSecretKey = !!process.env.STRIPE_SECRET_KEY;
    const hasPublishableKey = !!process.env.STRIPE_PUBLISHABLE_KEY;
    const hasPriceId = !!process.env.STRIPE_PRICE_ID;
    
    res.json({ 
      hasSecretKey,
      hasPublishableKey,
      hasPriceId,
      secretKeyPrefix: process.env.STRIPE_SECRET_KEY ? process.env.STRIPE_SECRET_KEY.substring(0, 7) : 'undefined',
      publishableKeyPrefix: process.env.STRIPE_PUBLISHABLE_KEY ? process.env.STRIPE_PUBLISHABLE_KEY.substring(0, 7) : 'undefined',
      priceId: process.env.STRIPE_PRICE_ID
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Basic test endpoint
app.get('/api/test/basic', (req, res) => {
  res.json({ message: 'Server is working', timestamp: new Date().toISOString() });
});

// Minimal PaymentIntent test
app.post('/api/test/payment-intent', authenticateToken, async (req, res) => {
  try {
    console.log('Testing PaymentIntent creation...');
    
    if (!process.env.STRIPE_SECRET_KEY) {
      return res.status(500).json({ error: 'No Stripe secret key' });
    }
    
    const paymentIntent = await stripe.paymentIntents.create({
      amount: 100,
      currency: 'usd',
    });
    
    res.json({ success: true, id: paymentIntent.id });
  } catch (error) {
    console.error('PaymentIntent error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Stripe publishable key (safe to expose to frontend)
app.get('/api/stripe/config', (req, res) => {
  console.log('🔧 Stripe config requested');
  console.log('🔧 Publishable key available:', !!process.env.STRIPE_PUBLISHABLE_KEY);
  console.log('🔧 Price ID available:', !!process.env.STRIPE_PRICE_ID);
  
  // Immediate response without any async operations
  const response = {
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY,
    priceId: process.env.STRIPE_PRICE_ID
  };
  
  console.log('✅ Sending Stripe config response');
  res.json(response);
});