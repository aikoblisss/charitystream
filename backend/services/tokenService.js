const crypto = require('crypto');
const bcrypt = require('bcryptjs');

class TokenService {
  constructor() {
    this.TOKEN_LENGTH = 32; // 32 bytes = 64 hex characters
    this.TOKEN_EXPIRY_MINUTES = 30; // 30 minutes expiry
  }

  /**
   * Generate a secure random verification token
   * @returns {string} - Hex string token
   */
  generateVerificationToken() {
    return crypto.randomBytes(this.TOKEN_LENGTH).toString('hex');
  }

  /**
   * Hash a verification token for secure storage
   * @param {string} token - Plain text token
   * @returns {Promise<string>} - Hashed token
   */
  async hashToken(token) {
    const saltRounds = 12;
    return await bcrypt.hash(token, saltRounds);
  }

  /**
   * Verify a token against its hash
   * @param {string} token - Plain text token
   * @param {string} hash - Hashed token from database
   * @returns {Promise<boolean>} - True if token matches
   */
  async verifyToken(token, hash) {
    return await bcrypt.compare(token, hash);
  }

  /**
   * Calculate token expiry timestamp
   * @returns {Date} - Expiry timestamp
   */
  getTokenExpiry() {
    const now = new Date();
    return new Date(now.getTime() + (this.TOKEN_EXPIRY_MINUTES * 60 * 1000));
  }

  /**
   * Check if a token is expired
   * @param {Date|string} expiresAt - Expiry timestamp
   * @returns {boolean} - True if expired
   */
  isTokenExpired(expiresAt) {
    const expiry = new Date(expiresAt);
    const now = new Date();
    return now > expiry;
  }

  /**
   * Generate a complete verification token package
   * @returns {Promise<Object>} - {token, hashedToken, expiresAt}
   */
  async generateVerificationPackage() {
    const token = this.generateVerificationToken();
    const hashedToken = await this.hashToken(token);
    const expiresAt = this.getTokenExpiry();

    return {
      token,        // Plain text token for email
      hashedToken,  // Hashed token for database
      expiresAt     // Expiry timestamp
    };
  }

  /**
   * Validate token format (basic check)
   * @param {string} token - Token to validate
   * @returns {boolean} - True if valid format
   */
  isValidTokenFormat(token) {
    if (!token || typeof token !== 'string') return false;
    if (token.length !== this.TOKEN_LENGTH * 2) return false; // Hex length
    return /^[a-f0-9]+$/i.test(token);
  }
}

module.exports = new TokenService();
