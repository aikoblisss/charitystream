const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { dbHelpers } = require('../database');

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
}

// Configure Google OAuth Strategy
passport.use(new GoogleStrategy({
  clientID: GOOGLE_CLIENT_ID,
  clientSecret: GOOGLE_CLIENT_SECRET,
  callbackURL: GOOGLE_CALLBACK_URL,
  scope: ['profile', 'email']
}, async (accessToken, refreshToken, profile, done) => {
  try {
    console.log('🔍 Google OAuth profile received:', profile.id);
    console.log('📧 Email:', profile.emails?.[0]?.value);
    console.log('👤 Display name:', profile.displayName);
    
    // Check if user already exists
    dbHelpers.getUserByGoogleId(profile.id, (err, existingUser) => {
      if (err) {
        console.error('❌ Database error during Google OAuth:', err);
        return done(err, null);
      }

      if (existingUser) {
        console.log('✅ Existing Google user found:', existingUser.email);
        return done(null, existingUser);
      }

      // Create new user
      const userData = {
        googleId: profile.id,
        username: profile.displayName || profile.emails[0].value.split('@')[0],
        email: profile.emails[0].value,
        profilePicture: profile.photos[0]?.value || 'default.png',
        emailVerified: profile.emails[0].verified || false
      };

      console.log('👤 Creating new user with data:', userData);

      dbHelpers.createGoogleUser(userData, function(err) {
        if (err) {
          console.error('❌ Error creating Google user:', err);
          return done(err, null);
        }

        console.log('✅ New Google user created:', userData.email);
        const newUser = {
          id: this.lastID,
          ...userData
        };
        return done(null, newUser);
      });
    });
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
passport.deserializeUser((id, done) => {
  dbHelpers.getUserById(id, (err, user) => {
    done(err, user);
  });
});

module.exports = passport;
