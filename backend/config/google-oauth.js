const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { dbHelpers } = require('../database-postgres');
const googleAuthService = require('../services/googleAuthService');

// Google OAuth configuration - prioritize environment variables
let GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
let GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
let GOOGLE_CALLBACK_URL = process.env.GOOGLE_CALLBACK_URL;

// Fallback to config file only if environment variables are not set
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  try {
    const config = require('./config');
    GOOGLE_CLIENT_ID = GOOGLE_CLIENT_ID || config.google.clientId;
    GOOGLE_CLIENT_SECRET = GOOGLE_CLIENT_SECRET || config.google.clientSecret;
    GOOGLE_CALLBACK_URL = GOOGLE_CALLBACK_URL || config.google.callbackUrl;
  } catch (error) {
    console.log('⚠️ Config file not found, using environment variables only');
  }
}

// Debug logging
console.log('🔧 Google OAuth Config:');
console.log('Client ID:', GOOGLE_CLIENT_ID ? 'Set' : 'Missing');
console.log('Client Secret:', GOOGLE_CLIENT_SECRET ? 'Set' : 'Missing');
console.log('Callback URL:', GOOGLE_CALLBACK_URL);

if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.error('❌ Google OAuth credentials are missing!');
  console.error('Please set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables');
  console.log('⚠️ Google OAuth will be disabled');
  
  // Export a mock passport object that doesn't break the app
  module.exports = {
    use: () => {},
    initialize: () => {},
    session: () => {},
    authenticate: () => (req, res, next) => {
      res.status(501).json({ error: 'Google OAuth not configured' });
    }
  };
} else {
  // Configure Google OAuth Strategy
  passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: GOOGLE_CALLBACK_URL,
  scope: ['profile', 'email', 'openid']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('🔍 Google OAuth profile received:', profile.id);
    console.log('📧 Email:', profile.emails?.[0]?.value);
    console.log('👤 Display name:', profile.displayName);
    
    // Verify the profile data matches what we expect
    if (!profile.id || !profile.emails?.[0]?.value) {
      console.error('❌ Invalid Google profile data');
      return done(new Error('Invalid Google profile data'), null);
    }

    const googleId = profile.id;
    const email = profile.emails[0].value;
    const emailVerified = profile.emails[0].verified || false;

    // First check if user already exists by Google ID
    const [err, existingGoogleUser] = await dbHelpers.getUserByGoogleId(googleId);
    if (err) {
      console.error('❌ Database error during Google OAuth:', err);
      return done(err, null);
    }

    if (existingGoogleUser) {
      console.log('✅ Existing Google user found:', existingGoogleUser.email);
      // Update last login
      await dbHelpers.updateLastLogin(existingGoogleUser.id);
      return done(null, existingGoogleUser);
    }

    // Check if user exists by email (manual signup case)
    const [emailErr, existingEmailUser] = await dbHelpers.getUserByEmail(email);
    if (emailErr) {
      console.error('❌ Database error checking existing email:', emailErr);
      return done(emailErr, null);
    }

    if (existingEmailUser) {
      console.log('🔄 User exists with email but no Google ID, linking accounts:', email);
      
      // Update existing user to link Google account
      const [updateErr, updatedUser] = await dbHelpers.linkGoogleAccount(existingEmailUser.id, googleId, profile.photos[0]?.value);
      if (updateErr) {
        console.error('❌ Error linking Google account:', updateErr);
        return done(updateErr, null);
      }

      console.log('✅ Google account linked to existing user:', email);
      // Update last login
      await dbHelpers.updateLastLogin(updatedUser.id);
      return done(null, updatedUser);
    }

    // Create new user - passwordless authentication
    const userData = {
      googleId: googleId,
      username: email.split('@')[0], // Use email prefix as temporary username
      email: email,
      profilePicture: profile.photos[0]?.value || null,
      emailVerified: emailVerified,
      authProvider: 'google'
    };

    console.log('👤 Creating new Google user:', userData);

    const [createErr, userId] = await dbHelpers.createGoogleUser(userData);
    if (createErr) {
      console.error('❌ Error creating Google user:', createErr);
      return done(createErr, null);
    }

    console.log('✅ New Google user created:', email);
    const newUser = {
      id: userId,
      ...userData
    };
    return done(null, newUser);
  } catch (error) {
    console.error('❌ Google OAuth error:', error);
    console.error('Error stack:', error.stack);
    return done(error, null);
  }
}));

  // Serialize user for session
  passport.serializeUser((user, done) => {
    done(null, user.id);
  });

  // Deserialize user from session
  passport.deserializeUser(async (id, done) => {
    try {
      const [err, user] = await dbHelpers.getUserById(id);
      done(err, user);
    } catch (error) {
      done(error, null);
    }
  });

  module.exports = passport;
}
