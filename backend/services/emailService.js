const nodemailer = require('nodemailer');

class EmailService {
  constructor() {
    this.isConfigured = false;
    this.transporter = null;
    this.initialize();
  }

  initialize() {
    // Email configuration - prioritize environment variables
    const emailConfig = {
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT) || 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
      },
      // Optimize for faster delivery
      pool: false, // Disable pooling for faster individual sends
      connectionTimeout: 20000, // 20 seconds
      greetingTimeout: 10000, // 10 seconds
      socketTimeout: 20000, // 20 seconds
      // Simplified retry configuration
      retryDelay: 1000, // 1 second between retries
      retryAttempts: 1, // Single retry attempt for speed
      // Remove potentially problematic settings
      tls: {
        rejectUnauthorized: true // Use secure connections
      }
    };

    // Check if email service is properly configured
    this.isConfigured = emailConfig.host && emailConfig.auth.user && emailConfig.auth.pass;

    if (this.isConfigured) {
      this.transporter = nodemailer.createTransport(emailConfig);
      console.log('✅ Email service configured');
    } else {
      console.log('⚠️ Email service not configured - set EMAIL_HOST, EMAIL_USER, and EMAIL_PASS environment variables');
    }
  }

  /**
   * Send verification email
   * @param {string} email - Recipient email
   * @param {string} username - Recipient username (not used in greeting)
   * @param {string} token - Verification token
   * @returns {Promise<Object>} - {success: boolean, messageId?: string, error?: string}
   */
  async sendVerificationEmail(email, username, token) {
    if (!this.isConfigured || !this.transporter) {
      console.log('⚠️ Email service not configured, skipping verification email');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      const verificationUrl = `${frontendUrl}/verify-email.html?token=${token}`;
      
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Verify Your Email - Charity Stream',
        html: this.getVerificationEmailTemplate(verificationUrl)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Verification email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Error sending verification email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send welcome email after verification
   * @param {string} email - Recipient email
   * @param {string} username - Recipient username
   * @returns {Promise<Object>} - {success: boolean, messageId?: string, error?: string}
   */
  async sendWelcomeEmail(email, username) {
    if (!this.isConfigured || !this.transporter) {
      console.log('⚠️ Email service not configured, skipping welcome email');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Welcome to Charity Stream - Start Watching Ads for Charity!',
        html: this.getWelcomeEmailTemplate(username, frontendUrl)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Welcome email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Error sending welcome email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Get verification email HTML template
   * @param {string} verificationUrl - Verification URL
   * @returns {string} - HTML email template
   */
  getVerificationEmailTemplate(verificationUrl) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #3f9d5e; color: white; padding: 20px; text-align: center;">
          <h1>Welcome to Charity Stream!</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hello!</h2>
          <p>Thank you for signing up! To complete your registration and start watching ads for charity, please verify your email address.</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" 
               style="background-color: #3f9d5e; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Verify Email Address
            </a>
          </div>
          
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
          
          <p><strong>This link will expire in 30 minutes for security reasons.</strong></p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            If you didn't create an account with Charity Stream, you can safely ignore this email.
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Get welcome email HTML template
   * @param {string} username - Username
   * @param {string} frontendUrl - Frontend URL
   * @returns {string} - HTML email template
   */
  getWelcomeEmailTemplate(username, frontendUrl) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #3f9d5e; color: white; padding: 20px; text-align: center;">
          <h1>🎉 Welcome to Charity Stream!</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${username}!</h2>
          <p>Your email has been verified successfully! You're now ready to start watching ads for charity.</p>
          
          <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>🚀 What's Next?</h3>
            <ul>
              <li>Start watching ads to earn money for charity</li>
              <li>Compete on the leaderboard with other users</li>
              <li>Track your impact and see how much you've raised</li>
              <li>Upgrade to premium for higher quality videos</li>
            </ul>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${frontendUrl}" 
               style="background-color: #3f9d5e; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Start Watching Ads
            </a>
          </div>
          
          <p>Thank you for joining our mission to make a positive impact through ad watching!</p>
        </div>
      </div>
    `;
  }

  /**
   * Send password reset email
   * @param {string} email - Recipient email
   * @param {string} username - Recipient username
   * @param {string} token - Reset token
   * @param {boolean} isGoogleUser - Whether this is for a Google user setting up their first password
   * @returns {Promise<Object>} - {success: boolean, messageId?: string, error?: string}
   */
  async sendPasswordResetEmail(email, username, token, isGoogleUser = false) {
    if (!this.isConfigured || !this.transporter) {
      console.log('⚠️ Email service not configured, skipping password reset email');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const startTime = Date.now();
      console.log(`📧 Starting password reset email to ${email} at ${new Date().toISOString()}`);
      
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      const resetUrl = `${frontendUrl}/reset-password.html?token=${token}`;
      
      const subject = isGoogleUser 
        ? 'Set Up Your Password - Charity Stream' 
        : 'Reset Your Password - Charity Stream';
        
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        html: isGoogleUser 
          ? this.getGooglePasswordSetupEmailTemplate(username, resetUrl)
          : this.getPasswordResetEmailTemplate(username, resetUrl)
      };

      // Create a fresh transporter for faster delivery
      const emailConfig = {
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT) || 587,
        secure: false,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASS
        },
        connectionTimeout: 15000, // 15 seconds
        greetingTimeout: 8000, // 8 seconds
        socketTimeout: 15000 // 15 seconds
      };
      
      const freshTransporter = nodemailer.createTransporter(emailConfig);

      // Add timeout wrapper to prevent long waits
      const emailPromise = freshTransporter.sendMail(mailOptions);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Email sending timeout after 25 seconds')), 25000)
      );

      const info = await Promise.race([emailPromise, timeoutPromise]);
      const endTime = Date.now();
      const duration = endTime - startTime;
      
      // Close the fresh transporter
      freshTransporter.close();
      
      console.log(`✅ Password reset email sent to ${email} in ${duration}ms:`, info.messageId);
      console.log(`📧 Email sent at: ${new Date().toISOString()}`);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Error sending password reset email:', error);
      
      // Provide more specific error messages
      if (error.message.includes('timeout')) {
        return { 
          success: false, 
          error: 'Email service timeout - please try again in a few minutes' 
        };
      } else if (error.message.includes('rate limit') || error.message.includes('quota')) {
        return { 
          success: false, 
          error: 'Email rate limit reached - please wait before trying again' 
        };
      } else {
        return { success: false, error: error.message };
      }
    }
  }

  /**
   * Get password reset email HTML template
   * @param {string} username - Username
   * @param {string} resetUrl - Reset URL
   * @returns {string} - HTML email template
   */
  getPasswordResetEmailTemplate(username, resetUrl) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>Password Reset Request</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${username}!</h2>
          <p>We received a request to reset your password for your Charity Stream account.</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Reset Password
            </a>
          </div>
          
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666;">${resetUrl}</p>
          
          <p><strong>This link will expire in 30 minutes for security reasons.</strong></p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            If you didn't request a password reset, you can safely ignore this email. Your password will remain unchanged.
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Get Google password setup email HTML template
   * @param {string} username - Username
   * @param {string} resetUrl - Setup URL
   * @returns {string} - HTML email template
   */
  getGooglePasswordSetupEmailTemplate(username, resetUrl) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>Set Up Your Password</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${username}!</h2>
          <p>You signed up for Charity Stream using Google, but you can also log in manually with your email and password.</p>
          <p>To enable manual login, please set up a password for your account.</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Set Up Password
            </a>
          </div>
          
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666;">${resetUrl}</p>
          
          <p><strong>This link will expire in 30 minutes for security reasons.</strong></p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            You can still log in with Google at any time. Setting up a password just gives you another way to access your account.
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Check if email service is configured
   * @returns {boolean} - True if configured
   */
  isEmailConfigured() {
    return this.isConfigured;
  }
}

module.exports = new EmailService();