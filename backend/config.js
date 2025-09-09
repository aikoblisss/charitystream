// Google OAuth and Email Configuration
// Replace the placeholder values with your actual credentials

module.exports = {
  // Google OAuth Configuration
  google: {
    clientId: 'YOUR_GOOGLE_CLIENT_ID_HERE',
    clientSecret: 'YOUR_GOOGLE_CLIENT_SECRET_HERE',
    callbackUrl: 'http://localhost:3001/api/auth/google/callback'
  },

  // JWT Secret (change this in production)
  jwtSecret: 'your-super-secret-jwt-key-change-in-production-12345',

  // Email Configuration (for verification emails)
  email: {
    host: 'smtp.gmail.com',
    port: 587,
    user: 'YOUR_EMAIL@gmail.com',        // Your Gmail address
    pass: 'YOUR_APP_PASSWORD'             // Your 16-character app password
  },

  // Frontend URL
  frontendUrl: 'http://localhost:3001',

  // Server Configuration
  port: 3001
};

