const { OAuth2Client } = require('google-auth-library');

class GoogleAuthService {
  constructor() {
    this.client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);
  }

  /**
   * Verify Google ID token and extract user information
   * @param {string} idToken - The Google ID token
   * @returns {Promise<Object>} - Verified user information
   */
  async verifyIdToken(idToken) {
    try {
      console.log('🔍 Verifying Google ID token...');
      
      // Verify the token
      const ticket = await this.client.verifyIdToken({
        idToken: idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      
      console.log('✅ Google ID token verified successfully');
      console.log('👤 User info:', {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        emailVerified: payload.email_verified
      });

      // Validate required fields
      if (!payload.sub || !payload.email) {
        throw new Error('Missing required user information in token');
      }

      // Check if email is verified
      if (!payload.email_verified) {
        throw new Error('Email not verified by Google');
      }

      return {
        googleId: payload.sub,
        email: payload.email,
        name: payload.name,
        emailVerified: payload.email_verified,
        profilePicture: payload.picture || null
      };

    } catch (error) {
      console.error('❌ Google ID token verification failed:', error.message);
      throw new Error(`Token verification failed: ${error.message}`);
    }
  }

  /**
   * Get Google OAuth URL with account selection
   * @param {string} mode - 'signin' or 'signup'
   * @returns {string} - Google OAuth URL
   */
  getAuthUrl(mode = 'signin') {
    const redirectUri = process.env.GOOGLE_CALLBACK_URL || 'http://localhost:3001/api/auth/google/callback';
    
    const authUrl = this.client.generateAuthUrl({
      access_type: 'offline',
      scope: ['profile', 'email', 'openid'],
      prompt: 'select_account', // Always show account chooser
      state: mode, // Pass mode through state parameter
      redirect_uri: redirectUri
    });

    console.log('🔗 Generated Google OAuth URL with account selection');
    return authUrl;
  }
}

module.exports = new GoogleAuthService();
