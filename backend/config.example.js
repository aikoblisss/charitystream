// Copy this file to config.js and fill in your actual values
// For Vercel deployment, use environment variables instead of this file

module.exports = {
  // Google OAuth Configuration
  google: {
    clientId: 'your-google-client-id-here',
    clientSecret: 'your-google-client-secret-here',
    // For local development:
    callbackUrl: 'http://localhost:3001/api/auth/google/callback'
    // For Vercel deployment, set GOOGLE_CALLBACK_URL environment variable to:
    // https://your-domain.vercel.app/api/auth/google/callback
  },

  // JWT Secret (change this in production)
  jwtSecret: 'your-super-secret-jwt-key-change-in-production',

  // Email Configuration (for verification emails)
  email: {
    host: 'smtp.gmail.com',
    port: 587,
    user: 'your-email@gmail.com',
    pass: 'your-app-password'
  },

  // Frontend URL
  frontendUrl: 'http://localhost:3001',

  // Server Configuration
  port: 3001
};

