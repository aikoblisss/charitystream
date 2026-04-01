console.log('🌍 [ENV CHECK] SITE_BASE_URL =', process.env.SITE_BASE_URL);

const R2_PUBLIC_ASSETS_URL = process.env.R2_PUBLIC_ASSETS_URL || 'https://public.stream.charity';
const COMMUNITY_GUIDELINES_URL = `${R2_PUBLIC_ASSETS_URL}/community-guidelines.pdf`;
const CHARITY_GUIDELINES_PDF_URL = `${R2_PUBLIC_ASSETS_URL}/charity-community-guidelines.pdf`;

const nodemailer = require('nodemailer');
const https = require('https');

class EmailService {
  constructor() {
    this.isConfigured = this.checkEmailConfiguration();
    this.transporter = null;
    this.initializeTransporter();
    console.log('📧 Email service constructor called');
    console.log('📧 Email service configured:', this.isConfigured);
  }

  // Check if all required email environment variables are set
  checkEmailConfiguration() {
    const required = ['EMAIL_HOST', 'EMAIL_PORT', 'EMAIL_USER', 'EMAIL_PASS'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      console.error('❌ Missing email configuration:', missing);
      return false;
    }
    
    console.log('✅ Email configuration check passed');
    console.log('📧 Email host:', process.env.EMAIL_HOST);
    console.log('📧 Email port:', process.env.EMAIL_PORT);
    console.log('📧 Email user:', process.env.EMAIL_USER);
    console.log('📧 Email pass length:', process.env.EMAIL_PASS ? process.env.EMAIL_PASS.length : 'MISSING');
    
    return true;
  }

  // Initialize the email transporter
  initializeTransporter() {
    if (!this.isConfigured) {
      console.error('❌ Cannot initialize transporter - email not configured');
      return;
    }

    try {
      // Remove any spaces from the app password (common issue with .env files)
      const cleanEmailPass = process.env.EMAIL_PASS.replace(/\s+/g, '');
      
      console.log('🔧 Creating email transporter with enhanced timeout settings...');
      this.transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT),
        secure: false, // true for 465, false for other ports
        auth: {
          user: process.env.EMAIL_USER,
          pass: cleanEmailPass, // Use cleaned password
        },
        // 🚨 CRITICAL: Enhanced timeout settings for Vercel/serverless environments
        connectionTimeout: 30000, // 30 seconds - increased from 10s
        greetingTimeout: 30000,   // 30 seconds - increased from 10s
        socketTimeout: 30000,     // 30 seconds socket timeout
        // Connection pool settings
        maxConnections: 5,         // Maximum number of concurrent connections
        maxMessages: 100,          // Maximum number of messages per connection
        rateDelta: 1000,           // Rate limiting delay (ms)
        rateLimit: 5,              // Maximum number of messages per rateDelta
        // Retry settings
        pool: true,                // Use connection pooling
        // Additional SMTP options for better reliability
        requireTLS: false,         // Don't require TLS (let server negotiate)
        tls: {
          rejectUnauthorized: false, // Accept self-signed certificates if needed
          // Note: Modern TLS will be negotiated automatically
        }
      });

      console.log('✅ Email transporter created, verifying connection...');
      console.log('🔧 Timeout settings:', {
        connectionTimeout: 30000,
        greetingTimeout: 30000,
        socketTimeout: 30000
      });
      
      // Verify transporter configuration with timeout
      const verifyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Email transporter verification timeout after 30 seconds'));
        }, 30000);
        
        this.transporter.verify((error, success) => {
          clearTimeout(timeout);
          if (error) {
            reject(error);
          } else {
            resolve(success);
          }
        });
      });
      
      verifyPromise
        .then(() => {
          console.log('✅ Email transporter is ready to send messages');
          console.log('✅ SMTP connection successful');
        })
        .catch((error) => {
          console.error('❌ Email transporter verification failed:', error);
          console.error('❌ Error details:', error.message);
          console.error('❌ Error code:', error.code);
          // Don't set transporter to null - allow retry on first send
          console.log('⚠️ Transporter created but verification failed - will retry on first send');
        });
      
    } catch (error) {
      console.error('❌ Failed to create email transporter:', error);
      this.transporter = null;
    }
  }

  // Helper method to send email with retry logic
  async sendMailWithRetry(mailOptions, maxRetries = 3) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`📧 Attempting to send email (attempt ${attempt}/${maxRetries})...`);
        
        // If transporter is null, try to reinitialize
        if (!this.transporter) {
          console.log('⚠️ Transporter is null, reinitializing...');
          this.initializeTransporter();
          // Wait a bit for initialization
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
        const info = await this.transporter.sendMail(mailOptions);
        console.log(`✅ Email sent successfully on attempt ${attempt}`);
        return { success: true, messageId: info.messageId, response: info.response };
      } catch (error) {
        lastError = error;
        console.error(`❌ Email send attempt ${attempt} failed:`, error.message);
        console.error(`❌ Error code:`, error.code);
        
        // If it's a connection timeout error, wait before retrying
        if (error.code === 'ETIMEDOUT' || error.message.includes('timeout') || error.message.includes('Connection timeout')) {
          const waitTime = attempt * 2000; // Exponential backoff: 2s, 4s, 6s
          console.log(`⏳ Connection timeout, waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
          
          // Try to reinitialize transporter on timeout
          console.log('🔄 Reinitializing transporter after timeout...');
          this.initializeTransporter();
          await new Promise(resolve => setTimeout(resolve, 1000));
        } else if (attempt < maxRetries) {
          // For other errors, wait shorter time
          const waitTime = attempt * 1000; // 1s, 2s, 3s
          console.log(`⏳ Waiting ${waitTime}ms before retry...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }
    
    console.error(`❌ Email send failed after ${maxRetries} attempts`);
    return { 
      success: false, 
      error: lastError?.message || 'Unknown error',
      code: lastError?.code,
      command: lastError?.command
    };
  }

  // Check if email service is ready to send
  isEmailConfigured() {
    const isReady = this.isConfigured && this.transporter !== null;
    console.log('📧 Email service ready check:', isReady);
    return isReady;
  }

  /**
   * Send verification email to user
   * @param {string} email - Recipient email
   * @param {string} username - Recipient username
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
        subject: 'Welcome to Charity Stream!',
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
   * Send password reset email
   * @param {string} email - Recipient email
   * @param {string} username - Recipient username
   * @param {string} token - Reset token
   * @returns {Promise<Object>} - {success: boolean, messageId?: string, error?: string}
   */
  async sendPasswordResetEmail(email, username, token) {
    if (!this.isConfigured || !this.transporter) {
      console.log('⚠️ Email service not configured, skipping password reset email');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      const resetUrl = `${frontendUrl}/reset-password.html?token=${token}`;
      
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: 'Reset Your Password - Charity Stream',
        html: this.getPasswordResetEmailTemplate(username, resetUrl)
      };

      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Password reset email sent:', info.messageId);
      return { success: true, messageId: info.messageId };
    } catch (error) {
      console.error('❌ Error sending password reset email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Send subscription confirmation email
   * @param {string} email - Recipient email
   * @param {string} username - Recipient username
   * @returns {Promise<Object>} - {success: boolean, messageId?: string, error?: string}
   */
  // Enhanced email sending with better error handling
  async sendSubscriptionConfirmationEmail(email, username) {
    console.log('📧 ===== ATTEMPTING TO SEND EMAIL =====');
    console.log('📧 Recipient:', email);
    console.log('📧 Username:', username);
    
    if (!this.isEmailConfigured()) {
      console.error('❌ Email service not properly configured or transporter not ready');
      return { success: false, error: 'Email service not configured' };
    }

    try {
      const frontendUrl = process.env.FRONTEND_URL || 'https://stream.charity';
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: '🎉 Thank You for Your Payment - Welcome to Charity Stream Premium!',
        html: this.getSubscriptionConfirmationEmailTemplate(username, frontendUrl),
        text: this.getTextVersion(username, frontendUrl)
      };

      console.log('📧 Mail options prepared:', {
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject
      });

      console.log('📧 Attempting to send mail...');
      const info = await this.transporter.sendMail(mailOptions);
      console.log('✅ Email sent successfully!');
      console.log('✅ Message ID:', info.messageId);
      console.log('✅ Response:', info.response);
      
      return { success: true, messageId: info.messageId, response: info.response };
    } catch (error) {
      console.error('❌ Email sending failed:', error);
      console.error('❌ Error name:', error.name);
      console.error('❌ Error code:', error.code);
      console.error('❌ Error command:', error.command);
      console.error('❌ Full error details:', error);
      
      return { 
        success: false, 
        error: error.message, 
        code: error.code,
        command: error.command 
      };
    }
  }

  // Add text version for email
  getTextVersion(username, frontendUrl) {
    return `
Hi ${username}!

Thank you for subscribing to Charity Stream Premium! Your $1/month goes directly toward our weekly charity donation pool.

Premium Benefits Unlocked:
• Pop-out player (Chrome extension coming soon) — Picture-in-Picture available now
• 1.25x ad speed for faster watching
• Fewer interruptions during your session
• Golden username on the leaderboard
• Direct support for charity causes

Start watching: ${frontendUrl}

Your subscription renews monthly. Thank you for supporting our mission!

-- The Charity Stream Team
    `;
  }

  /**
   * Get subscription confirmation email HTML template
   * @param {string} username - User's username
   * @param {string} frontendUrl - Frontend URL
   * @returns {string} - HTML template
   */
  getSubscriptionConfirmationEmailTemplate(username, frontendUrl) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>Welcome to Charity Stream Premium!</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${username}!</h2>
          <p>Thank you for subscribing to Charity Stream Premium! Your $1/month goes directly toward our weekly charity donation pool.</p>

          <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>Premium Benefits Unlocked:</h3>
            <ul>
              <li>Pop-out player (Chrome extension coming soon) — Picture-in-Picture available now</li>
              <li>1.25x ad speed for faster watching</li>
              <li>Fewer interruptions during your session</li>
              <li>Golden username on the leaderboard</li>
              <li>Direct support for charity causes</li>
            </ul>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${frontendUrl}" 
               style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Start Watching Premium Ads
            </a>
          </div>
          
          <p>Your subscription will automatically renew monthly. You can manage your subscription anytime from your account settings.</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            Thank you for supporting our mission to make a positive impact through ad watching!
          </p>
        </div>
      </div>
    `;
  }

  // Send donation thank you email
  async sendDonationThankYouEmail(customerEmail, username, donationAmount, stripeCustomerId = null) {
    try {
      console.log('📧 ===== SENDING DONATION THANK YOU EMAIL =====');
      console.log('📧 To (Stripe customer email):', customerEmail);
      console.log('📧 Username:', username);
      console.log('📧 Donation Amount (cents):', donationAmount);
      
      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }
      
      const formattedAmount = (Number(donationAmount || 0) / 100).toFixed(2);
      const subject = `Thank You for Your Donation!`;
      
      const htmlContent = this.getDonationThankYouEmailTemplate(username, formattedAmount);
      const textContent = this.getDonationThankYouTextTemplate(username, formattedAmount);
      
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: customerEmail,
        subject: subject,
        text: textContent,
        html: htmlContent
      };
      
      console.log('📧 Sending donation thank you email with retry logic...');
      
      // Use retry logic for sending
      const result = await this.sendMailWithRetry(mailOptions, 3);
      
      if (result.success) {
        console.log('✅ Donation thank you email sent successfully');
        console.log('📧 Message ID:', result.messageId);
      } else {
        console.error('❌ Donation thank you email failed after retries:', result.error);
      }
      
      return result;
      
    } catch (error) {
      console.error('❌ ===== DONATION THANK YOU EMAIL FAILED =====');
      console.error('❌ Error details:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Get donation thank you email template (HTML)
  getDonationThankYouEmailTemplate(username, donationAmount) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>💝 Thank You for Your Donation!</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${username},</h2>
          <p>Thank you so much for your generous donation of <strong>$${donationAmount}</strong> to Charity Stream!</p>
          
          <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0; text-align: center;">
            <h3 style="color: #2F7D31; margin: 0;">Your donation of $${donationAmount} will make a real difference!</h3>
          </div>
          
          <p>Your contribution helps us continue our mission of supporting charitable causes through advertising revenue. Every dollar goes directly to making a positive impact.</p>
          
          <div style="background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3>📊 Your Impact</h3>
            <p><strong>Charity Stream Username:</strong> ${username}</p>
            <p><strong>Donation Amount:</strong> $${donationAmount}</p>
            <p><strong>Thank you for being part of our community!</strong></p>
          </div>
          
          <p>If you have any questions about your donation, please reply to this email.</p>
          
          <p>With gratitude,<br>The Charity Stream Team</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            Charity Stream - Making Every View Count for Charity
          </p>
        </div>
      </div>
    `;
  }

  // Get donation thank you email template (Text)
  getDonationThankYouTextTemplate(username, donationAmount) {
    return `Thank You for Your Donation!

Hi ${username},

Thank you so much for your generous donation of $${donationAmount} to Charity Stream!

Your donation of $${donationAmount} will make a real difference!

Your contribution helps us continue our mission of supporting charitable causes through advertising revenue. Every dollar goes directly to making a positive impact.

YOUR IMPACT:
- Charity Stream Username: ${username}
- Donation Amount: $${donationAmount}
- Thank you for being part of our community!

If you have any questions about your donation, please reply to this email.

With gratitude,
The Charity Stream Team

Charity Stream - Making Every View Count for Charity`;
  }

  /**
   * Get verification email HTML template
   * @param {string} verificationUrl - Verification URL
   * @returns {string} - HTML template
   */
  getVerificationEmailTemplate(verificationUrl) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>Verify Your Email</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Welcome to Charity Stream!</h2>
          <p>Please click the button below to verify your email address and complete your registration:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" 
               style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Verify Email Address
            </a>
          </div>
          
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            This verification link will expire in 24 hours. If you didn't create an account, please ignore this email.
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Get welcome email HTML template
   * @param {string} username - User's username
   * @param {string} frontendUrl - Frontend URL
   * @returns {string} - HTML template
   */
  getWelcomeEmailTemplate(username, frontendUrl) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>Welcome to Charity Stream!</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${username}!</h2>
          <p>Your email has been verified and your account is now active. Welcome to Charity Stream!</p>
          
          <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>🎯 What's Next?</h3>
            <ul>
              <li>Start watching ads to support charity causes</li>
              <li>Track your impact on our leaderboard</li>
              <li>Earn rewards for your contributions</li>
              <li>Connect with other users making a difference</li>
            </ul>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${frontendUrl}" 
               style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Start Watching Ads
            </a>
          </div>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            Thank you for joining our mission to make a positive impact through ad watching!
          </p>
        </div>
      </div>
    `;
  }

  /**
   * Get password reset email HTML template
   * @param {string} username - User's username
   * @param {string} resetUrl - Reset URL
   * @returns {string} - HTML template
   */
  getPasswordResetEmailTemplate(username, resetUrl) {
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>Reset Your Password</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${username}!</h2>
          <p>You requested to reset your password. Click the button below to create a new password:</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${resetUrl}" 
               style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              Reset Password
            </a>
          </div>
          
          <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
          <p style="word-break: break-all; color: #666;">${resetUrl}</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            This reset link will expire in 1 hour. If you didn't request a password reset, please ignore this email.
          </p>
        </div>
      </div>
    `;
  }

  // Send advertiser confirmation email with campaign summary
  async sendAdvertiserConfirmationEmail(email, companyName, campaignSummary = {}, signupToken = null) {
    try {
      console.log('📧 ===== SENDING ADVERTISER CONFIRMATION EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Company:', companyName);
      console.log('📧 Campaign Summary:', campaignSummary);
      console.log('🔑 Portal signup token:', signupToken ? `${signupToken.substring(0, 8)}...` : 'NOT PROVIDED');
      
      const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
      if (signupToken) {
        const fullSignupLink = `${siteBaseUrl}/portal/reset-password?token=${signupToken}`;
        console.log('🔗 [SIGNUP EMAIL] SITE_BASE_URL:', siteBaseUrl);
        console.log('🔗 [SIGNUP EMAIL] Full signup link:', fullSignupLink);
      }
      
      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }
      
      const isExpedited = campaignSummary.expedited || false;
      const subject = `Thank You for Your Advertising Campaign Submission - ${companyName}`;
      
      console.log('📧 [EMAIL] About to call getAdvertiserConfirmationEmailTemplate...');
      console.log('📧 [EMAIL] Parameters:', { companyName, campaignSummary, hasToken: !!signupToken });
      
      const htmlContent = this.getAdvertiserConfirmationEmailTemplate(companyName, campaignSummary, signupToken);
      console.log('📧 [EMAIL] HTML template length:', htmlContent ? htmlContent.length : 'NULL');
      console.log('📧 [EMAIL] HTML template preview (first 200 chars):', htmlContent ? htmlContent.substring(0, 200) : 'NULL');
      console.log('📧 [EMAIL] HTML contains "Campaign Submitted":', htmlContent ? htmlContent.includes('Campaign Submitted') : false);
      
      // DEBUG: Check what URL is actually in the generated HTML
      if (htmlContent && signupToken) {
        const urlMatches = htmlContent.match(/href="([^"]*advertiser-signup\.html[^"]*)"/g);
        console.log('🔍 [EMAIL DEBUG] Found signup URLs in HTML:', urlMatches);
        if (urlMatches) {
          urlMatches.forEach((match, idx) => {
            console.log(`🔍 [EMAIL DEBUG] URL ${idx + 1} in email:`, match);
          });
        }
      }
      console.log('📧 [EMAIL] HTML contains "Approval Process":', htmlContent ? htmlContent.includes('Approval Process') : false);
      
      const textContent = this.getAdvertiserConfirmationTextTemplate(companyName, campaignSummary, signupToken);
      console.log('📧 [EMAIL] Text template length:', textContent ? textContent.length : 'NULL');
      
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        text: textContent,
        html: htmlContent
      };
      
      console.log('📧 Sending email with options:', {
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject,
        hasHtml: !!mailOptions.html,
        hasText: !!mailOptions.text
      });
      
      // DEBUG: Final check of URLs in the email before sending
      if (htmlContent && signupToken) {
        const finalUrlCheck = htmlContent.match(/href="([^"]*advertiser-signup\.html[^"]*)"/);
        if (finalUrlCheck) {
          console.log('🔍 [FINAL CHECK] URL that will be sent in email:', finalUrlCheck[1]);
        }
      }
      
      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Advertiser confirmation email sent successfully');
      console.log('📧 Message ID:', result.messageId);
      
      return { success: true, messageId: result.messageId };
      
    } catch (error) {
      console.error('❌ ===== ADVERTISER CONFIRMATION EMAIL FAILED =====');
      console.error('❌ Error details:', error.message);
      console.error('❌ Error code:', error.code);
      console.error('❌ Error response:', error.response);
      
      return { 
        success: false, 
        error: error.message,
        code: error.code,
        response: error.response
      };
    }
  }
  
  // Get advertiser confirmation email template with campaign summary
  // hamburger
  getAdvertiserConfirmationEmailTemplate(companyName, campaignSummary = {}, signupToken = null) {
    console.log('📧 [TEMPLATE] getAdvertiserConfirmationEmailTemplate called - NEW VERSION');
    console.log('📧 [TEMPLATE] Company:', companyName);
    console.log('📧 [TEMPLATE] Campaign Summary:', campaignSummary);
    
    // DEBUG: Check environment variable at template generation time
    console.log('🔍 [TEMPLATE DEBUG] process.env.SITE_BASE_URL =', process.env.SITE_BASE_URL);
    console.log('🔍 [TEMPLATE DEBUG] typeof process.env.SITE_BASE_URL =', typeof process.env.SITE_BASE_URL);
    console.log('🔍 [TEMPLATE DEBUG] All SITE_* env vars:', Object.keys(process.env).filter(k => k.startsWith('SITE')));
    
    const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
    console.log('🔍 [TEMPLATE DEBUG] Resolved siteBaseUrl =', siteBaseUrl);
    
    const isExpedited = campaignSummary.expedited || false;
    const signupUrl = signupToken
      ? `${siteBaseUrl}/portal/reset-password?token=${signupToken}`
      : `${siteBaseUrl}/advertiser-login.html`;
    
    console.log('🔍 [TEMPLATE DEBUG] Generated signupUrl =', signupUrl);
    
    if (signupToken) {
      console.log('🔗 [TEMPLATE] SITE_BASE_URL:', siteBaseUrl);
      console.log('🔗 [TEMPLATE] Full signup link:', signupUrl);
    }
    
    // Format campaign details
    const adFormat = campaignSummary.ad_format === 'video' 
      ? 'Video' 
      : (campaignSummary.ad_format ? 'Static Image' : 'Not specified');
    const cpmRate = campaignSummary.cpm_rate 
      ? parseFloat(campaignSummary.cpm_rate).toFixed(2) 
      : 'Not specified';
    const weeklyBudget = campaignSummary.weekly_budget_cap 
      ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` 
      : 'Not specified';
    const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
    const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>Charity Stream: Your Submission is In</title>
    <!-- MSO conditional for Windows/Outlook rendering -->
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:AllowPNG/>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
</head>
<!--
    Design Principles:
    1. System Font Stack for native feel.
    2. Primary Brand Color: #2F7D31 (Green).
    3. Generous, consistent white space and subtle borders.
    4. Elevated CTA for maximum clarity.
-->
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
    
    <!-- Email Wrapper (Full Width) -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
        <tr>
            <!-- Outer padding standardized to 40px top, 60px bottom for envelope feel -->
            <td align="center" style="padding: 40px 0 60px 0;">
                
                <!-- Logo/Brand Section (Minimal Header - Outside the main card) -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
                    <tr>
                        <td align="left" style="padding-bottom: 32px;"> 
                            <!-- Left-Aligned Logo -->
                            <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0; letter-spacing: -0.2px; text-align: left;">
                                <span style="color: #276629;">Charity</span> Stream
                            </h1>
                        </td>
                    </tr>
                </table>
                <!-- Main Content Container (The "Card") -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden;">
                    
                    <!-- 1. TOP GREEN HEADER BAR (Frames the content, minimalist header element) -->
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
                    </tr>
                    <!-- Main Content Area -->
                    <tr>
                        <!-- Padding around the entire content block -->
                        <td style="padding: 48px 40px 40px 40px;">

                            <!-- START OF NEW, CENTERED, EASY-TO-SCAN HEADER BLOCK -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center;">
                                <tr>
                                    <!-- Centered Checkmark Icon -->
                                    <td align="center" style="padding-bottom: 24px;">
                                        <div style="width: 44px; height: 44px; background-color: #1c1c1e; border-radius: 50%; display: inline-block; text-align: center; line-height: 44px;">
                                            <!-- SVG/Unicode Checkmark -->
                                            <span style="font-size: 24px; color: #ffffff;">&#10003;</span>
        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 12px;">
                                        <h2 style="color: #1c1c1e; font-size: 30px; font-weight: 700; margin: 0; line-height: 1.25; letter-spacing: -0.8px;">
                                            Campaign Submitted
                                        </h2>
                                    </td>
                                </tr>
                                <tr>
                                    <!-- Simplified Greeting and Message -->
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #1c1c1e; font-size: 18px; line-height: 1.6; margin: 0; font-weight: 500;">
                                            Thank you, ${companyName} Team. Your campaign is now in review.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            <!-- END OF NEW HEADER BLOCK -->
                            
                            <!-- NEW STATUS AND QUICK-LINK BLOCK (Balanced Spacing) -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center; margin-bottom: 50px;">
                                <tr>
                                    <!-- Notification Timeline (Subtle, secondary color) -->
                                    <td style="padding-bottom: 8px;">
                                        <p style="color: #8e8e93; font-size: 15px; line-height: 1.5; margin: 0; font-weight: 500;">
                                            You will be notified of approval within 3–5 business days.
                                        </p>
                                    </td>
              </tr>
              <tr>
                                    <!-- Quick Link (Primary Brand Color) -->
                                    <td>
                                        <p style="margin: 0; font-size: 15px;">
                                            <a href="${signupUrl}" style="color: #2F7D31; text-decoration: none; font-weight: 600;">
                                                Stay Updated in the Advertiser Portal →
                                            </a>
                                        </p>
                                    </td>
              </tr>
                            </table>
                            <!-- END OF NEW STATUS AND QUICK-LINK BLOCK -->
                            <!-- Campaign Summary Section (Minimal Grid Look) -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px; border-top: 1px solid #ededed; border-bottom: 1px solid #ededed;">
                                <tr>
                                    <!-- Increased vertical padding inside the summary box for air -->
                                    <td style="padding: 30px 0;">
                                        <!-- Section Header -->
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">Campaign Summary</h3>
                                        
                                        <!-- Campaign Details List -->
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <!-- Detail Rows use 10px padding for consistent spacing -->
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="30%" style="color: #6a6a6f; font-size: 15px;">Ad Format:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${adFormat}</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="30%" style="color: #6a6a6f; font-size: 15px;">CPM Rate:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">$${cpmRate} per 1,000 views</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Weekly Budget Cap:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${weeklyBudget}</td>
              </tr>
            </table>
                                                </td>
                                            </tr>
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Expedited Review:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${expeditedApproval}</td>
                                                        </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Clickable Link:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${clickTracking}</td>
                                                        </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Process Steps -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px;">
                                <tr>
                                    <td style="padding-bottom: 30px;">
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">The Process</h3>
                                    </td>
                                </tr>
                                
                                <!-- Payment Step -->
                                <tr>
                                    <!-- Standardized vertical separation between steps to 40px -->
                                    <td style="padding-bottom: 40px;"> 
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td width="40" valign="top">
                                                    <div style="width: 32px; height: 32px; background-color: #f0f0f5; border-radius: 8px; text-align: center; line-height: 32px; font-size: 18px; color: #1c1c1e;">
                                                        <span style="color: #2F7D31;">$</span>
          </div>
                                                </td>
                                                <td style="padding-left: 20px;">
                                                    <h4 style="color: #1c1c1e; font-size: 17px; font-weight: 600; margin: 0 0 8px 0;">No upfront charges</h4>
                                                    <p style="color: #6a6a6f; font-size: 16px; line-height: 1.6; margin: 0;">
                                                        You won't be charged until your campaign is approved and finished. You'll only pay based on actual views/clicks at your CPM rate.
                                                    </p>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                                
                                <!-- Approval Step (No padding-bottom on the last item in the list) -->
                                <tr>
                                    <td>
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td width="40" valign="top">
                                                    <div style="width: 32px; height: 32px; background-color: #f0f0f5; border-radius: 8px; text-align: center; line-height: 32px; font-size: 18px; color: #1c1c1e;">
                                                        <span style="color: #2F7D31;">✓</span>
          </div>
                                                </td>
                                                <td style="padding-left: 20px;">
                                                    <h4 style="color: #1c1c1e; font-size: 17px; font-weight: 600; margin: 0 0 12px 0;">Approval & Launch Timeline</h4>
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <!-- Line-height set to 1.6 on bullets for air -->
                                                        <tr>
                                                            <td style="padding-bottom: 8px;">
                                                                <span style="color: #2F7D31; font-weight: 700; font-size: 15px; display: inline-block; width: 15px;">•</span>
                                                                <span style="color: #1c1c1e; font-size: 15px; line-height: 1.6;"><strong style="color: #6a6a6f; font-weight: 500;">Review:</strong> Creative quality, accuracy, and compliance.</span>
                                                            </td>
                                                        </tr>
                                                        <tr>
                                                            <td style="padding-bottom: 8px;">
                                                                <span style="color: #2F7D31; font-weight: 700; font-size: 15px; display: inline-block; width: 15px;">•</span>
                                                                <span style="color: #1c1c1e; font-size: 15px; line-height: 1.6;"><strong style="color: #6a6a6f; font-weight: 500;">Timeline:</strong> 3–5 business days (or sooner if expedited).</span>
                                                            </td>
                                                        </tr>
                                                        <tr>
                                                            <td style="padding-bottom: 8px;">
                                                                <span style="color: #2F7D31; font-weight: 700; font-size: 15px; display: inline-block; width: 15px;">•</span>
                                                                <span style="color: #1c1c1e; font-size: 15px; line-height: 1.6;"><strong style="color: #6a6a6f; font-weight: 500;">Notification:</strong> We'll email you immediately upon approval.</span>
                                                            </td>
                                                        </tr>
                                                        <tr>
                                                            <td>
                                                                <span style="color: #2F7D31; font-weight: 700; font-size: 15px; display: inline-block; width: 15px;">•</span>
                                                                <span style="color: #1c1c1e; font-size: 15px; line-height: 1.6;"><strong style="color: #6a6a6f; font-weight: 500;">Tracking:</strong> Performance is live via the Advertiser Portal.</span>
                                                            </td>
                                                        </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Primary CTA Button (Elevated Green Block) -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 40px;">
                                <tr>
                                    <td align="center">
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <!-- Instructional text spacing refined -->
                                            <tr>
                                                <td style="padding-bottom: 16px; text-align: center;">
                                                    <p style="color: #1c1c1e; font-size: 16px; font-weight: 500; margin: 0;">
                                                        View your campaign
                                                    </p>
                                                </td>
                                            </tr>
                                            <tr>
                                                <!-- Increased padding and full width presentation for maximum visibility -->
                                                <td style="background-color: #2F7D31; border-radius: 12px; text-align: center; padding: 20px; box-shadow: 0 4px 12px rgba(47,125,49,0.3);">
                                                    <a href="${signupUrl}" style="display: block; padding: 12px 0; color: #ffffff; text-decoration: none; font-size: 18px; font-weight: 700; line-height: 1; -webkit-text-size-adjust: none;">
                                                        Open Advertiser Portal →
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <!-- Secondary CTA/Footer Separator -->
                    <tr>
                        <td style="padding: 0 40px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td height="1" style="background-color: #ededed;"></td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <!-- Questions & Minimal Footer -->
                    <tr>
                        <!-- Standardized padding on the contact section -->
                        <td style="padding: 30px 40px 40px 40px; text-align: center;">
                            <p style="color: #6a6a6f; font-size: 16px; margin: 0 0 12px 0;">Have a question about your submission?</p>
                            <p style="margin: 0;">
                                <a href="mailto:contactcharitystream@gmail.com" style="color: #2F7D31; font-weight: 600; text-decoration: none; font-size: 16px;">
                                    contactcharitystream@gmail.com
                                </a>
                            </p>
                        </td>
                    </tr>
                    
                    <!-- 2. BOTTOM GREEN FOOTER BAR (Frames the card base) -->
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px;">&nbsp;</td>
                    </tr>
                </table>
                <!-- Bottom Footer (Outside the Main Card) -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; padding-top: 40px;">
                    <!-- Increased top padding here for maximal card separation -->
                    <tr>
                        <td align="center">
                            <p style="color: #8e8e93; font-size: 14px; margin: 0 0 16px 0; font-style: normal; line-height: 1.5;">
                                Stream ads. Fuel impact. Compete for good.
                            </p>
                            
                            <!-- Social Links (Minimalist Grey Circles) -->
                            <table cellpadding="0" cellspacing="0" border="0" align="center">
                                <tr>
                                    <td style="padding: 0 10px;">
                                        <!-- Email icon (placeholder) -->
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">✉</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <!-- LinkedIn icon (placeholder) -->
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">in</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <!-- X/Twitter icon (placeholder) -->
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">X</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    
</body>
</html>
    `;
  }
  
  // Get advertiser confirmation text template with campaign summary
  getAdvertiserConfirmationTextTemplate(companyName, campaignSummary = {}, signupToken = null) {
    const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
    const signupUrl = signupToken
      ? `${siteBaseUrl}/portal/reset-password?token=${signupToken}`
      : `${siteBaseUrl}/advertiser-login.html`;
    
    // Format campaign details
    const adFormat = campaignSummary.ad_format === 'video' 
      ? 'Video' 
      : (campaignSummary.ad_format ? 'Static Image' : 'Not specified');
    const cpmRate = campaignSummary.cpm_rate 
      ? `$${parseFloat(campaignSummary.cpm_rate).toFixed(2)}` 
      : 'Not specified';
    const weeklyBudget = campaignSummary.weekly_budget_cap 
      ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` 
      : 'Not specified';
    const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
    const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
    
    return `Thank You for Your Advertising Campaign Submission - ${companyName}

Hi ${companyName} Team,

Thank you for submitting your advertising campaign to Charity Stream. Your campaign is now in review.

CAMPAIGN SUMMARY:
- Ad Format: ${adFormat}
- CPM Rate: $${cpmRate} per 1,000 views
- Weekly Budget Cap: ${weeklyBudget}
- Expedited Review: ${expeditedApproval}
- Clickable Link: ${clickTracking}

You will be notified of approval within 3–5 business days.

ACCESS YOUR CAMPAIGN:
Stay updated in the Advertiser Portal: ${signupUrl}
Open Advertiser Portal: ${signupUrl}

THE PROCESS:
• No upfront charges - You won't be charged until your campaign is approved and finished. You'll only pay based on actual views/clicks at your CPM rate.
• Approval & Launch Timeline:
  - Review: Creative quality, accuracy, and compliance.
  - Timeline: 3–5 business days (or sooner if expedited).
  - Notification: We'll email you immediately upon approval.
  - Tracking: Performance is live via the Advertiser Portal.

Have a question about your submission?
Contact us at: contactcharitystream@gmail.com

Stream ads. Fuel impact. Compete for good.

-- The Charity Stream Team`;
  }

  /**
   * Get the next Monday's date from submission time in America/Los_Angeles.
   * Returns a formatted string e.g. "March 3, 2025".
   */
  getNextMondayLabel(createdAt) {
    const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
    const laDateStr = created.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const [y, m, d] = laDateStr.split('-').map(Number);
    const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const day = utcNoon.getUTCDay();
    const add = day === 1 ? 0 : day === 0 ? 1 : 8 - day;
    const nextMonday = new Date(utcNoon);
    nextMonday.setUTCDate(nextMonday.getUTCDate() + add);
    return nextMonday.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
  }

  /**
   * Get the next Monday as YYYY-MM-DD (America/Los_Angeles) for charity_week_pool.week_start.
   */
  getNextMondayDate(createdAt) {
    const created = createdAt instanceof Date ? createdAt : new Date(createdAt);
    const laDateStr = created.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
    const [y, m, d] = laDateStr.split('-').map(Number);
    const utcNoon = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    const day = utcNoon.getUTCDay();
    const add = day === 1 ? 0 : day === 0 ? 1 : 8 - day;
    const nextMonday = new Date(utcNoon);
    nextMonday.setUTCDate(nextMonday.getUTCDate() + add);
    const yy = nextMonday.getUTCFullYear();
    const mm = String(nextMonday.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(nextMonday.getUTCDate()).padStart(2, '0');
    return `${yy}-${mm}-${dd}`;
  }

  /**
   * Charity application confirmation email template.
   * Same HTML structure and styling as advertiser confirmation; content tailored for charity intake.
   */
  getCharityConfirmationEmailTemplate(charityName, nextMondayLabel) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>Charity Stream: Your Application is In</title>
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:AllowPNG/>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
        <tr>
            <td align="center" style="padding: 40px 0 60px 0;">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
                    <tr>
                        <td align="left" style="padding-bottom: 32px;">
                            <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0; letter-spacing: -0.2px; text-align: left;">
                                <span style="color: #276629;">Charity</span> Stream
                            </h1>
                        </td>
                    </tr>
                </table>
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden;">
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
                    </tr>
                    <tr>
                        <td style="padding: 48px 40px 40px 40px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center;">
                                <tr>
                                    <td align="center" style="padding-bottom: 24px;">
                                        <div style="width: 44px; height: 44px; background-color: #1c1c1e; border-radius: 50%; display: inline-block; text-align: center; line-height: 44px;">
                                            <span style="font-size: 24px; color: #ffffff;">&#10003;</span>
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 12px;">
                                        <h2 style="color: #1c1c1e; font-size: 30px; font-weight: 700; margin: 0; line-height: 1.25; letter-spacing: -0.8px;">
                                            Application Submitted
                                        </h2>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #1c1c1e; font-size: 18px; line-height: 1.6; margin: 0; font-weight: 500;">
                                            Thank you, ${charityName}. Your application is now pending review.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center; margin-bottom: 32px;">
                                <tr>
                                    <td style="padding-bottom: 8px;">
                                        <p style="color: #8e8e93; font-size: 15px; line-height: 1.5; margin: 0; font-weight: 500;">
                                            You will be notified of the outcome via email.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px; border-top: 1px solid #ededed; border-bottom: 1px solid #ededed;">
                                <tr>
                                    <td style="padding: 30px 0;">
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">Application for the week of:</h3>
                                        <p style="color: #1c1c1e; font-size: 17px; font-weight: 600; margin: 0;">${nextMondayLabel}</p>
                                    </td>
                                </tr>
                            </table>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px;">
                                <tr>
                                    <td style="padding-bottom: 30px;">
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">The Process:</h3>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #6a6a6f; font-size: 16px; line-height: 1.6; margin: 0;">
                                            If approved, your organization will be entered into our weekly charity pool.
                                        </p>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #6a6a6f; font-size: 16px; line-height: 1.6; margin: 0;">
                                            If your application is not approved, your $1 entry payment will be fully refunded.
                                        </p>
                                    </td>
                                </tr>
                                <tr>
                                    <td>
                                        <p style="color: #6a6a6f; font-size: 16px; line-height: 1.6; margin: 0;">
                                            If approved but not selected as the weekly winner, your entry will still contribute to the winning charity's donation total.
                                        </p>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-top: 24px;">
                                        <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0; font-weight: 500;">
                                            Thank you for working with us and best of luck!
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td height="1" style="background-color: #ededed;"></td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 30px 40px 40px 40px; text-align: center;">
                            <p style="color: #6a6a6f; font-size: 16px; margin: 0 0 12px 0;">Have a question about your submission?</p>
                            <p style="margin: 0;">
                                <a href="mailto:contactcharitystream@gmail.com" style="color: #2F7D31; font-weight: 600; text-decoration: none; font-size: 16px;">
                                    contactcharitystream@gmail.com
                                </a>
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px;">&nbsp;</td>
                    </tr>
                </table>
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; padding-top: 40px;">
                    <tr>
                        <td align="center">
                            <p style="color: #8e8e93; font-size: 14px; margin: 0 0 16px 0; font-style: normal; line-height: 1.5;">
                                Stream ads. Fuel impact. Compete for good.
                            </p>
                            <table cellpadding="0" cellspacing="0" border="0" align="center">
                                <tr>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">&#9993;</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">in</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">X</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `;
  }

  async sendCharityConfirmationEmail(email, charityName, createdAt) {
    try {
      console.log('📧 Sending charity application confirmation email to:', email);
      if (!this.isEmailConfigured()) {
        console.warn('⚠️ Email service not configured, skipping charity confirmation email');
        return { success: false, error: 'Email service not configured' };
      }
      const nextMondayLabel = this.getNextMondayLabel(createdAt);
      const subject = `Thank You for Your Charity Application - ${charityName}`;
      const htmlContent = this.getCharityConfirmationEmailTemplate(charityName, nextMondayLabel);
      const textContent = `Thank You for Your Charity Application - ${charityName}

Hi ${charityName},

Thank you for submitting your charity application to Charity Stream. Your application is now pending review.

Application for the week of: ${nextMondayLabel}

The Process:
- If approved, your organization will be entered into our weekly charity pool.
- If your application is not approved, your $1 entry payment will be fully refunded.
- If approved but not selected as the weekly winner, your entry will still contribute to the winning charity's donation total.

Thank you for working with us and best of luck!

Have a question about your submission?
Contact us at: contactcharitystream@gmail.com

Stream ads. Fuel impact. Compete for good.

-- The Charity Stream Team`;
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        text: textContent,
        html: htmlContent
      };
      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Charity confirmation email sent successfully');
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Failed to send charity confirmation email:', error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Charity approval email template. Same layout as charity confirmation; header "Application Approved" and body for pool entry.
   */
  getCharityApprovalEmailTemplate(charityName, weekStartLabel) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>Charity Stream: Application Approved</title>
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:AllowPNG/>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
        <tr>
            <td align="center" style="padding: 40px 0 60px 0;">
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
                    <tr>
                        <td align="left" style="padding-bottom: 32px;">
                            <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0; letter-spacing: -0.2px; text-align: left;">
                                <span style="color: #276629;">Charity</span> Stream
                            </h1>
                        </td>
                    </tr>
                </table>
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden;">
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
                    </tr>
                    <tr>
                        <td style="padding: 48px 40px 40px 40px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center;">
                                <tr>
                                    <td align="center" style="padding-bottom: 24px;">
                                        <div style="width: 44px; height: 44px; background-color: #1c1c1e; border-radius: 50%; display: inline-block; text-align: center; line-height: 44px;">
                                            <span style="font-size: 24px; color: #ffffff;">&#10003;</span>
                                        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 12px;">
                                        <h2 style="color: #1c1c1e; font-size: 30px; font-weight: 700; margin: 0; line-height: 1.25; letter-spacing: -0.8px;">
                                            Application Approved
                                        </h2>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #1c1c1e; font-size: 18px; line-height: 1.6; margin: 0; font-weight: 500;">
                                            You have been approved and entered into the charity pool for the week of:
                                        </p>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #2F7D31; font-size: 20px; font-weight: 700; margin: 0;">${weekStartLabel}</p>
                                    </td>
                                </tr>
                            </table>
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td height="1" style="background-color: #ededed;"></td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 30px 40px 40px 40px; text-align: center;">
                            <p style="color: #6a6a6f; font-size: 16px; margin: 0 0 12px 0;">Have a question about your submission?</p>
                            <p style="margin: 0;">
                                <a href="mailto:contactcharitystream@gmail.com" style="color: #2F7D31; font-weight: 600; text-decoration: none; font-size: 16px;">
                                    contactcharitystream@gmail.com
                                </a>
                            </p>
                        </td>
                    </tr>
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px;">&nbsp;</td>
                    </tr>
                </table>
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; padding-top: 40px;">
                    <tr>
                        <td align="center">
                            <p style="color: #8e8e93; font-size: 14px; margin: 0 0 16px 0; font-style: normal; line-height: 1.5;">
                                Stream ads. Fuel impact. Compete for good.
                            </p>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
</body>
</html>
    `;
  }

  async sendCharityApprovalEmail(email, charityName, weekStartLabel) {
    try {
      console.log('📧 Sending charity approval email to:', email);
      if (!this.isEmailConfigured()) {
        console.warn('⚠️ Email service not configured, skipping charity approval email');
        return { success: false, error: 'Email service not configured' };
      }
      const subject = `Your Charity Application was Approved - ${charityName}`;
      const htmlContent = this.getCharityApprovalEmailTemplate(charityName, weekStartLabel);
      const textContent = `Your Charity Application was Approved - ${charityName}

Hi ${charityName},

You have been approved and entered into the charity pool for the week of:
${weekStartLabel}

Have a question about your submission?
Contact us at: contactcharitystream@gmail.com

Stream ads. Fuel impact. Compete for good.

-- The Charity Stream Team`;
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        text: textContent,
        html: htmlContent
      };
      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Charity approval email sent successfully');
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Failed to send charity approval email:', error);
      return { success: false, error: error.message };
    }
  }

  // Send sponsor rejection email (after Stripe refund/cancel is complete)
  // Approval email (Email #2) NEVER includes password setup - always links to login
  getAdvertiserApprovalEmailTemplate(companyName, campaignSummary = {}, signupToken = null) {
    console.log('📧 [TEMPLATE] getAdvertiserApprovalEmailTemplate called');
    console.log('📧 [TEMPLATE] Company:', companyName);
    console.log('📧 [TEMPLATE] Campaign Summary:', campaignSummary);
    
    const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
    // Approval email always links to advertiser-login.html (no password setup)
    const signupUrl = `${siteBaseUrl}/advertiser-login.html`;
    
    // Format campaign details (identical to confirmation email)
    const adFormat = campaignSummary.ad_format === 'video' 
      ? 'Video' 
      : (campaignSummary.ad_format ? 'Static Image' : 'Not specified');
    const cpmRate = campaignSummary.cpm_rate 
      ? parseFloat(campaignSummary.cpm_rate).toFixed(2) 
      : 'Not specified';
    const weeklyBudget = campaignSummary.weekly_budget_cap 
      ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` 
      : 'Not specified';
    const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
    const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>Charity Stream: Your Campaign Has Been Approved</title>
    <!-- MSO conditional for Windows/Outlook rendering -->
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:AllowPNG/>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
</head>
<!--
    Design Principles:
    1. System Font Stack for native feel.
    2. Primary Brand Color: #2F7D31 (Green).
    3. Generous, consistent white space and subtle borders.
    4. Elevated CTA for maximum clarity.
-->
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
    
    <!-- Email Wrapper (Full Width) -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
        <tr>
            <!-- Outer padding standardized to 40px top, 60px bottom for envelope feel -->
            <td align="center" style="padding: 40px 0 60px 0;">
                
                <!-- Logo/Brand Section (Minimal Header - Outside the main card) -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
                    <tr>
                        <td align="left" style="padding-bottom: 32px;"> 
                            <!-- Left-Aligned Logo -->
                            <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0; letter-spacing: -0.2px; text-align: left;">
                                <span style="color: #276629;">Charity</span> Stream
                            </h1>
                        </td>
                    </tr>
                </table>
                <!-- Main Content Container (The "Card") -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden;">
                    
                    <!-- 1. TOP GREEN HEADER BAR (Frames the content, minimalist header element) -->
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
                    </tr>
                    <!-- Main Content Area -->
                    <tr>
                        <!-- Padding around the entire content block -->
                        <td style="padding: 48px 40px 40px 40px;">

                            <!-- START OF NEW, CENTERED, EASY-TO-SCAN HEADER BLOCK -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center;">
                                <tr>
                                    <!-- Centered Checkmark Icon -->
                                    <td align="center" style="padding-bottom: 24px;">
                                        <div style="width: 44px; height: 44px; background-color: #1c1c1e; border-radius: 50%; display: inline-block; text-align: center; line-height: 44px;">
                                            <!-- SVG/Unicode Checkmark -->
                                            <span style="font-size: 24px; color: #ffffff;">&#10003;</span>
        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 12px;">
                                        <h2 style="color: #1c1c1e; font-size: 30px; font-weight: 700; margin: 0; line-height: 1.25; letter-spacing: -0.8px;">
                                            Campaign Approved
                                        </h2>
                                    </td>
                                </tr>
                                <tr>
                                    <!-- Simplified Greeting and Message -->
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #1c1c1e; font-size: 18px; line-height: 1.6; margin: 0; font-weight: 500;">
                                            Good news ${companyName} Team. Your campaign is now live!
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            <!-- END OF NEW HEADER BLOCK -->
                            
                            <!-- NEW STATUS AND QUICK-LINK BLOCK (Balanced Spacing) -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center; margin-bottom: 50px;">
                                <tr>
                                    <!-- Quick Link (Primary Brand Color) -->
                                    <td>
                                        <p style="margin: 0; font-size: 15px;">
                                            <a href="${signupUrl}" style="color: #2F7D31; text-decoration: none; font-weight: 600;">
                                                Stay Updated in the Advertiser Portal →
                                            </a>
                                        </p>
                                    </td>
              </tr>
                            </table>
                            <!-- END OF NEW STATUS AND QUICK-LINK BLOCK -->
                            <!-- Campaign Summary Section (Minimal Grid Look) -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px; border-top: 1px solid #ededed; border-bottom: 1px solid #ededed;">
                                <tr>
                                    <!-- Increased vertical padding inside the summary box for air -->
                                    <td style="padding: 30px 0;">
                                        <!-- Section Header -->
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">Campaign Summary</h3>
                                        
                                        <!-- Campaign Details List -->
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <!-- Detail Rows use 10px padding for consistent spacing -->
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="30%" style="color: #6a6a6f; font-size: 15px;">Ad Format:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${adFormat}</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="30%" style="color: #6a6a6f; font-size: 15px;">CPM Rate:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">$${cpmRate} per 1,000 views</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Weekly Budget Cap:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${weeklyBudget}</td>
              </tr>
            </table>
                                                </td>
                                            </tr>
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Expedited Review:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${expeditedApproval}</td>
                                                        </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <!-- Detail Row -->
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Clickable Link:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${clickTracking}</td>
                                                        </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- What's Next Section (Replaces "The Process") -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px;">
                                <tr>
                                    <td style="padding-bottom: 30px;">
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">What's Next</h3>
                                    </td>
                                </tr>
                                
                                <!-- Bullet Points -->
                                <tr>
                                    <td style="padding-bottom: 8px;">
                                        <span style="color: #2F7D31; font-weight: 700; font-size: 15px; display: inline-block; width: 15px;">•</span>
                                        <span style="color: #1c1c1e; font-size: 15px; line-height: 1.6;">Track impressions and clicks in real time</span>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 8px;">
                                        <span style="color: #2F7D31; font-weight: 700; font-size: 15px; display: inline-block; width: 15px;">•</span>
                                        <span style="color: #1c1c1e; font-size: 15px; line-height: 1.6;">Replace or update your creative at any time</span>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 8px;">
                                        <span style="color: #2F7D31; font-weight: 700; font-size: 15px; display: inline-block; width: 15px;">•</span>
                                        <span style="color: #1c1c1e; font-size: 15px; line-height: 1.6;">Increase or adjust your weekly budget cap</span>
                                    </td>
                                </tr>
                                <tr>
                                    <td>
                                        <span style="color: #2F7D31; font-weight: 700; font-size: 15px; display: inline-block; width: 15px;">•</span>
                                        <span style="color: #1c1c1e; font-size: 15px; line-height: 1.6;">Pause or resume your campaign instantly</span>
                                    </td>
                                </tr>
                            </table>
                            
                            <!-- Primary CTA Button (Elevated Green Block) -->
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 40px;">
                                <tr>
                                    <td align="center">
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <!-- Instructional text spacing refined -->
                                            <tr>
                                                <td style="padding-bottom: 16px; text-align: center;">
                                                    <p style="color: #1c1c1e; font-size: 16px; font-weight: 500; margin: 0;">
                                                        View your campaign
                                                    </p>
                                                </td>
                                            </tr>
                                            <tr>
                                                <!-- Increased padding and full width presentation for maximum visibility -->
                                                <td style="background-color: #2F7D31; border-radius: 12px; text-align: center; padding: 20px; box-shadow: 0 4px 12px rgba(47,125,49,0.3);">
                                                    <a href="${signupUrl}" style="display: block; padding: 12px 0; color: #ffffff; text-decoration: none; font-size: 18px; font-weight: 700; line-height: 1; -webkit-text-size-adjust: none;">
                                                        Open Advertiser Portal →
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <!-- Secondary CTA/Footer Separator -->
                    <tr>
                        <td style="padding: 0 40px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td height="1" style="background-color: #ededed;"></td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <!-- Questions & Minimal Footer -->
                    <tr>
                        <!-- Standardized padding on the contact section -->
                        <td style="padding: 30px 40px 40px 40px; text-align: center;">
                            <p style="color: #6a6a6f; font-size: 16px; margin: 0 0 12px 0;">Have a question about your campaign?</p>
                            <p style="margin: 0;">
                                <a href="mailto:contactcharitystream@gmail.com" style="color: #2F7D31; font-weight: 600; text-decoration: none; font-size: 16px;">
                                    contactcharitystream@gmail.com
                                </a>
                            </p>
                        </td>
                    </tr>
                    
                    <!-- 2. BOTTOM GREEN FOOTER BAR (Frames the card base) -->
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px;">&nbsp;</td>
                    </tr>
                </table>
                <!-- Bottom Footer (Outside the Main Card) -->
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; padding-top: 40px;">
                    <!-- Increased top padding here for maximal card separation -->
                    <tr>
                        <td align="center">
                            <p style="color: #8e8e93; font-size: 14px; margin: 0 0 16px 0; font-style: normal; line-height: 1.5;">
                                Stream ads. Fuel impact. Compete for good.
                            </p>
                            
                            <!-- Social Links (Minimalist Grey Circles) -->
                            <table cellpadding="0" cellspacing="0" border="0" align="center">
                                <tr>
                                    <td style="padding: 0 10px;">
                                        <!-- Email icon (placeholder) -->
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">✉</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <!-- LinkedIn icon (placeholder) -->
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">in</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <!-- X/Twitter icon (placeholder) -->
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">X</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    
</body>
</html>
    `;
  }

  // New: Send advertiser approval email with distinct content
  async sendAdvertiserApprovalEmail(email, companyName, campaignSummary = {}, signupToken = null) {
    try {
      console.log('📧 ===== SENDING ADVERTISER APPROVAL EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Company:', companyName);
      console.log('📧 Campaign Summary:', campaignSummary);
      console.log('🔑 Portal signup token:', signupToken ? `${signupToken.substring(0, 8)}...` : 'NOT PROVIDED');
      
      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }
      
      const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
      const subject = `Your Advertising Campaign Has Been Approved - ${companyName}`;
      
      // Approval email (Email #2) does NOT include password setup links
      console.log('🔗 [APPROVAL EMAIL] SITE_BASE_URL:', siteBaseUrl);
      console.log('🔗 [APPROVAL EMAIL] Approval email links to advertiser-login.html (no password setup)');
      
      // Use the new template function that reuses confirmation email layout
      const htmlContent = this.getAdvertiserApprovalEmailTemplate(companyName, campaignSummary, signupToken);
      
      // Format campaign details for text version
      const adFormat = campaignSummary.ad_format === 'video' ? 'Video' : 'Static Image';
      const cpmRate = campaignSummary.cpm_rate ? `$${parseFloat(campaignSummary.cpm_rate).toFixed(2)}` : 'Not specified';
      const weeklyBudget = campaignSummary.weekly_budget_cap ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` : 'Not specified';
      const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
      const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
      // Approval email (Email #2) always links to advertiser-login.html (no password setup)
      const signupUrl = `${siteBaseUrl}/advertiser-login.html`;
      
      const textContent = `Your Advertising Campaign Has Been Approved - ${companyName}

Good news ${companyName} Team. Your campaign is now live!

CAMPAIGN SUMMARY:
- Ad Format: ${adFormat}
- CPM Rate: $${cpmRate} per 1,000 views
- Weekly Budget Cap: ${weeklyBudget}
- Expedited Review: ${expeditedApproval}
- Clickable Link: ${clickTracking}

WHAT'S NEXT:
• Track impressions and clicks in real time
• Replace or update your creative at any time
• Increase or adjust your weekly budget cap
• Pause or resume your campaign instantly

${signupUrl ? `Stay Updated in the Advertiser Portal: ${signupUrl}\n\n` : ''}Open Advertiser Portal: ${signupUrl || `${siteBaseUrl}/advertiser-login.html`}

Have a question about your campaign?
Contact us at: contactcharitystream@gmail.com

Stream ads. Fuel impact. Compete for good.`;
      
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        html: htmlContent,
        text: textContent
      };
      
      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Advertiser approval email sent successfully');
      console.log('📧 Message ID:', result.messageId);
      
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ ===== ADVERTISER APPROVAL EMAIL FAILED =====');
      console.error('❌ Error details:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Send sponsor confirmation email (Email #1) with submission summary
  async sendSponsorConfirmationEmail(email, organizationName, submissionSummary = {}, signupToken = null) {
    try {
      console.log('📧 ===== SENDING SPONSOR CONFIRMATION EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Organization:', organizationName);
      console.log('📧 Submission Summary:', submissionSummary);
      console.log('🔑 Portal signup token:', signupToken ? `${signupToken.substring(0, 8)}...` : 'NOT PROVIDED');
      
      const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
      if (signupToken) {
        const fullSignupLink = `${siteBaseUrl}/portal/reset-password?token=${signupToken}`;
        console.log('🔗 [SIGNUP EMAIL] SITE_BASE_URL:', siteBaseUrl);
        console.log('🔗 [SIGNUP EMAIL] Full signup link:', fullSignupLink);
      }
      
      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }
      
      const subject = `Thank You for Your Sponsor Campaign Submission – ${organizationName}`;
      
      console.log('📧 [EMAIL] About to call getSponsorConfirmationEmailTemplate...');
      console.log('📧 [EMAIL] Parameters:', { organizationName, submissionSummary, hasToken: !!signupToken });
      
      const htmlContent = this.getSponsorConfirmationEmailTemplate(organizationName, submissionSummary, signupToken);
      console.log('📧 [EMAIL] HTML template length:', htmlContent ? htmlContent.length : 'NULL');
      
      const textContent = this.getSponsorConfirmationTextTemplate(organizationName, submissionSummary, signupToken);
      console.log('📧 [EMAIL] Text template length:', textContent ? textContent.length : 'NULL');
      
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        text: textContent,
        html: htmlContent
      };
      
      console.log('📧 Sending email with options:', {
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject,
        hasHtml: !!mailOptions.html,
        hasText: !!mailOptions.text
      });
      
      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Sponsor confirmation email sent successfully');
      console.log('📧 Message ID:', result.messageId);
      
      return { success: true, messageId: result.messageId };
      
    } catch (error) {
      console.error('❌ ===== SPONSOR CONFIRMATION EMAIL FAILED =====');
      console.error('❌ Error details:', error.message);
      console.error('❌ Error code:', error.code);
      console.error('❌ Error response:', error.response);
      
      return { 
        success: false, 
        error: error.message,
        code: error.code,
        response: error.response
      };
    }
  }

  // Get sponsor confirmation email template (Email #1)
  getSponsorConfirmationEmailTemplate(organizationName, submissionSummary = {}, signupToken = null) {
    console.log('📧 [TEMPLATE] getSponsorConfirmationEmailTemplate called');
    console.log('📧 [TEMPLATE] Organization:', organizationName);
    console.log('📧 [TEMPLATE] Submission Summary:', submissionSummary);
    
    const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
    const signupUrl = signupToken
      ? `${siteBaseUrl}/portal/reset-password?token=${signupToken}`
      : `${siteBaseUrl}/sponsor-login.html`;
    
    console.log('🔍 [TEMPLATE DEBUG] Resolved siteBaseUrl =', siteBaseUrl);
    console.log('🔍 [TEMPLATE DEBUG] Generated signupUrl =', signupUrl);
    
    // Format submission details
    const tier = submissionSummary.tier 
      ? submissionSummary.tier.charAt(0).toUpperCase() + submissionSummary.tier.slice(1)
      : 'Not specified';
    const paymentType = submissionSummary.isRecurring ? 'Recurring (Weekly)' : 'One-time';
    
    // Tier perks mapping
    const getTierPerks = (tierName) => {
      const tierLower = tierName.toLowerCase();
      if (tierLower === 'bronze') {
        return ['Logo placement in videos', 'Weekly recognition', 'Basic analytics'];
      } else if (tierLower === 'silver') {
        return ['Logo placement in videos', 'Weekly recognition', 'Enhanced analytics', 'Priority placement'];
      } else if (tierLower === 'gold') {
        return ['Logo placement in videos', 'Weekly recognition', 'Full analytics dashboard', 'Premium placement', 'Featured mention'];
      } else if (tierLower === 'diamond') {
        return ['Prominent logo placement', 'Weekly recognition', 'Full analytics dashboard', 'Premium placement', 'Featured mention', 'Custom messaging'];
      }
      return ['Logo placement', 'Weekly recognition'];
    };
    
    const perks = getTierPerks(tier);
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>Charity Stream: Your Submission is In</title>
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:AllowPNG/>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
    
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
        <tr>
            <td align="center" style="padding: 40px 0 60px 0;">
                
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
                    <tr>
                        <td align="left" style="padding-bottom: 32px;"> 
                            <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0; letter-spacing: -0.2px; text-align: left;">
                                <span style="color: #276629;">Charity</span> Stream
                            </h1>
                        </td>
                    </tr>
                </table>
                
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden;">
                    
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
                    </tr>
                    <tr>
                        <td style="padding: 48px 40px 40px 40px;">

                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center;">
                                <tr>
                                    <td align="center" style="padding-bottom: 24px;">
                                        <div style="width: 44px; height: 44px; background-color: #1c1c1e; border-radius: 50%; display: inline-block; text-align: center; line-height: 44px;">
                                            <span style="font-size: 24px; color: #ffffff;">&#10003;</span>
        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 12px;">
                                        <h2 style="color: #1c1c1e; font-size: 30px; font-weight: 700; margin: 0; line-height: 1.25; letter-spacing: -0.8px;">
                                            Submission Completed
                                        </h2>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #1c1c1e; font-size: 18px; line-height: 1.6; margin: 0; font-weight: 500;">
                                            Thank you, ${organizationName} Team. Your sponsorship submission has been received and payment confirmed.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center; margin-bottom: 50px;">
                                <tr>
                                    <td style="padding-bottom: 8px;">
                                        <p style="color: #8e8e93; font-size: 15px; line-height: 1.5; margin: 0; font-weight: 500;">
                                            Your sponsorship will be reviewed for content and brand guidelines.
                                        </p>
                                    </td>
              </tr>
              <tr>
                                    <td>
                                        <p style="margin: 0; font-size: 15px;">
                                            <a href="${signupUrl}" style="color: #2F7D31; text-decoration: none; font-weight: 600;">
                                                Stay Updated in the Sponsor Portal →
                                            </a>
                                        </p>
                                    </td>
              </tr>
                            </table>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px; border-top: 1px solid #ededed; border-bottom: 1px solid #ededed;">
                                <tr>
                                    <td style="padding: 30px 0;">
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">Submission Summary</h3>
                                        
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Organization:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${organizationName}</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Sponsorship Tier:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${tier}</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Payment Type:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${paymentType}</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px; vertical-align: top;">Included Perks:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right; vertical-align: top;">
                                                                ${perks.map(perk => `<div style="padding-bottom: 4px;">${perk}</div>`).join('')}
                                                            </td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px;">
                                <tr>
                                    <td style="padding-bottom: 30px;">
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">What Happens Next</h3>
                                    </td>
                                </tr>
                                
                                <tr>
                                    <td style="padding-bottom: 16px;">
                                        <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0;">
                                            If your sponsorship meets our content and brand guidelines, it will be featured on the platform starting next Monday.
                                        </p>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 16px;">
                                        <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0;">
                                            If we receive a high volume of submissions, placement may begin the following week instead.
                                        </p>
                                    </td>
                                </tr>
                                <tr>
                                    <td>
                                        <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0;">
                                            If your submission does not meet our requirements, you will be fully refunded and notified by email.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 40px;">
                                <tr>
                                    <td align="center">
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="padding-bottom: 16px; text-align: center;">
                                                    <p style="color: #1c1c1e; font-size: 16px; font-weight: 500; margin: 0;">
                                                        View your sponsorship
                                                    </p>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="background-color: #2F7D31; border-radius: 12px; text-align: center; padding: 20px; box-shadow: 0 4px 12px rgba(47,125,49,0.3);">
                                                    <a href="${signupUrl}" style="display: block; padding: 12px 0; color: #ffffff; text-decoration: none; font-size: 18px; font-weight: 700; line-height: 1; -webkit-text-size-adjust: none;">
                                                        Open Sponsor Portal →
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 0 40px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td height="1" style="background-color: #ededed;"></td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <tr>
                        <td style="padding: 30px 40px 40px 40px; text-align: center;">
                            <p style="color: #6a6a6f; font-size: 16px; margin: 0 0 12px 0;">Have a question about your submission?</p>
                            <p style="margin: 0;">
                                <a href="mailto:contactcharitystream@gmail.com" style="color: #2F7D31; font-weight: 600; text-decoration: none; font-size: 16px;">
                                    contactcharitystream@gmail.com
                                </a>
                            </p>
                        </td>
                    </tr>
                    
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px;">&nbsp;</td>
                    </tr>
                </table>
                
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; padding-top: 40px;">
                    <tr>
                        <td align="center">
                            <p style="color: #8e8e93; font-size: 14px; margin: 0 0 16px 0; font-style: normal; line-height: 1.5;">
                                Stream ads. Fuel impact. Compete for good.
                            </p>
                            
                            <table cellpadding="0" cellspacing="0" border="0" align="center">
                                <tr>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">✉</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">in</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">X</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    
</body>
</html>
    `;
  }

  // Get sponsor confirmation text template (Email #1)
  getSponsorConfirmationTextTemplate(organizationName, submissionSummary = {}, signupToken = null) {
    const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
    const signupUrl = signupToken
      ? `${siteBaseUrl}/portal/reset-password?token=${signupToken}`
      : `${siteBaseUrl}/sponsor-login.html`;
    
    const tier = submissionSummary.tier 
      ? submissionSummary.tier.charAt(0).toUpperCase() + submissionSummary.tier.slice(1)
      : 'Not specified';
    const paymentType = submissionSummary.isRecurring ? 'Recurring (Weekly)' : 'One-time';
    
    const getTierPerks = (tierName) => {
      const tierLower = tierName.toLowerCase();
      if (tierLower === 'bronze') {
        return ['Logo placement in videos', 'Weekly recognition', 'Basic analytics'];
      } else if (tierLower === 'silver') {
        return ['Logo placement in videos', 'Weekly recognition', 'Enhanced analytics', 'Priority placement'];
      } else if (tierLower === 'gold') {
        return ['Logo placement in videos', 'Weekly recognition', 'Full analytics dashboard', 'Premium placement', 'Featured mention'];
      } else if (tierLower === 'diamond') {
        return ['Prominent logo placement', 'Weekly recognition', 'Full analytics dashboard', 'Premium placement', 'Featured mention', 'Custom messaging'];
      }
      return ['Logo placement', 'Weekly recognition'];
    };
    
    const perks = getTierPerks(tier);
    
    return `Thank You for Your Sponsor Campaign Submission – ${organizationName}

Hi ${organizationName} Team,

Thank you for submitting your sponsorship to Charity Stream. Your submission has been received and payment confirmed.

SUBMISSION SUMMARY:
- Organization: ${organizationName}
- Sponsorship Tier: ${tier}
- Payment Type: ${paymentType}
- Included Perks:
${perks.map(perk => `  • ${perk}`).join('\n')}

Your sponsorship will be reviewed for content and brand guidelines.

ACCESS YOUR SPONSORSHIP:
Stay Updated in the Sponsor Portal: ${signupUrl}
Open Sponsor Portal: ${signupUrl}

WHAT HAPPENS NEXT:
• If your sponsorship meets our content and brand guidelines, it will be featured on the platform starting next Monday.
• If we receive a high volume of submissions, placement may begin the following week instead.
• If your submission does not meet our requirements, you will be fully refunded and notified by email.

Have a question about your submission?
Contact us at: contactcharitystream@gmail.com

Stream ads. Fuel impact. Compete for good.

-- The Charity Stream Team`;
  }

  // Send sponsor approval email (sent after campaign is approved and video generated)
  async sendSponsorApprovalEmail(email, organizationName, submissionSummary = {}, nextMondayDate) {
    try {
      console.log('📧 ===== SENDING SPONSOR APPROVAL EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Organization:', organizationName);
      console.log('📧 Submission Summary:', submissionSummary);
      console.log('📅 Next Monday Date:', nextMondayDate);
      
      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }
      
      const subject = `Your Sponsor Campaign Submission Has Been Approved! – ${organizationName}`;
      
      const htmlContent = this.getSponsorApprovalEmailTemplate(organizationName, submissionSummary, nextMondayDate);
      const textContent = this.getSponsorApprovalTextTemplate(organizationName, submissionSummary, nextMondayDate);
      
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject: subject,
        text: textContent,
        html: htmlContent
      };
      
      console.log('📧 Sending approval email with options:', {
        from: mailOptions.from,
        to: mailOptions.to,
        subject: mailOptions.subject,
        hasHtml: !!mailOptions.html,
        hasText: !!mailOptions.text
      });
      
      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Sponsor approval email sent successfully');
      console.log('📧 Message ID:', result.messageId);
      
      return { success: true, messageId: result.messageId };
      
    } catch (error) {
      console.error('❌ ===== SPONSOR APPROVAL EMAIL FAILED =====');
      console.error('❌ Error details:', error.message);
      console.error('❌ Error code:', error.code);
      console.error('❌ Error response:', error.response);
      
      return { 
        success: false, 
        error: error.message,
        code: error.code,
        response: error.response
      };
    }
  }

  // Get sponsor approval email template (HTML)
  getSponsorApprovalEmailTemplate(organizationName, submissionSummary = {}, nextMondayDate) {
    console.log('📧 [TEMPLATE] getSponsorApprovalEmailTemplate called');
    console.log('📧 [TEMPLATE] Organization:', organizationName);
    console.log('📧 [TEMPLATE] Submission Summary:', submissionSummary);
    console.log('📧 [TEMPLATE] Next Monday Date:', nextMondayDate);
    
    const siteBaseUrl = process.env.SITE_BASE_URL || 'http://localhost:3001';
    const portalUrl = `${siteBaseUrl}/sponsor-login.html`;
    
    // Format submission details
    const tier = submissionSummary.tier 
      ? submissionSummary.tier.charAt(0).toUpperCase() + submissionSummary.tier.slice(1)
      : 'Not specified';
    const paymentType = submissionSummary.isRecurring ? 'Recurring (Weekly)' : 'One-time';
    
    // Tier perks mapping
    const getTierPerks = (tierName) => {
      const tierLower = tierName.toLowerCase();
      if (tierLower === 'bronze') {
        return ['Logo placement in videos', 'Weekly recognition', 'Basic analytics'];
      } else if (tierLower === 'silver') {
        return ['Logo placement in videos', 'Weekly recognition', 'Enhanced analytics', 'Priority placement'];
      } else if (tierLower === 'gold') {
        return ['Logo placement in videos', 'Weekly recognition', 'Full analytics dashboard', 'Premium placement', 'Featured mention'];
      } else if (tierLower === 'diamond') {
        return ['Prominent logo placement', 'Weekly recognition', 'Full analytics dashboard', 'Premium placement', 'Featured mention', 'Custom messaging'];
      }
      return ['Logo placement', 'Weekly recognition'];
    };
    
    const perks = getTierPerks(tier);
    
    return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="IE=edge">
    <title>Charity Stream: Your Sponsorship Has Been Approved</title>
    <!--[if mso]>
    <noscript>
        <xml>
            <o:OfficeDocumentSettings>
                <o:AllowPNG/>
                <o:PixelsPerInch>96</o:PixelsPerInch>
            </o:OfficeDocumentSettings>
        </xml>
    </noscript>
    <![endif]-->
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%;">
    
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
        <tr>
            <td align="center" style="padding: 40px 0 60px 0;">
                
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
                    <tr>
                        <td align="left" style="padding-bottom: 32px;"> 
                            <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0; letter-spacing: -0.2px; text-align: left;">
                                <span style="color: #276629;">Charity</span> Stream
                            </h1>
                        </td>
                    </tr>
                </table>
                
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px; box-shadow: 0 1px 3px rgba(0,0,0,0.05); overflow: hidden;">
                    
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
                    </tr>
                    <tr>
                        <td style="padding: 48px 40px 40px 40px;">

                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center;">
                                <tr>
                                    <td align="center" style="padding-bottom: 24px;">
                                        <div style="width: 44px; height: 44px; background-color: #1c1c1e; border-radius: 50%; display: inline-block; text-align: center; line-height: 44px;">
                                            <span style="font-size: 24px; color: #ffffff;">&#10003;</span>
        </div>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 12px;">
                                        <h2 style="color: #1c1c1e; font-size: 30px; font-weight: 700; margin: 0; line-height: 1.25; letter-spacing: -0.8px;">
                                            Sponsorship Approved
                                        </h2>
                                    </td>
                                </tr>
                                <tr>
                                    <td style="padding-bottom: 24px;">
                                        <p style="color: #1c1c1e; font-size: 18px; line-height: 1.6; margin: 0; font-weight: 500;">
                                            Thank you, ${organizationName} Team. Your sponsorship has been approved and will be live on Monday, ${nextMondayDate}.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="text-align: center; margin-bottom: 50px;">
                                <tr>
                                    <td>
                                        <p style="margin: 0; font-size: 15px;">
                                            <a href="${portalUrl}" style="color: #2F7D31; text-decoration: none; font-weight: 600;">
                                                Stay Updated in the Sponsor Portal →
                                            </a>
                                        </p>
                                    </td>
              </tr>
                            </table>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px; border-top: 1px solid #ededed; border-bottom: 1px solid #ededed;">
                                <tr>
                                    <td style="padding: 30px 0;">
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">Sponsor Summary</h3>
                                        
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Organization:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${organizationName}</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Sponsorship Tier:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${tier}</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px;">Payment Type:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right;">${paymentType}</td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="padding: 10px 0;">
                                                    <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                                        <tr>
                                                            <td width="40%" style="color: #6a6a6f; font-size: 15px; vertical-align: top;">Included Perks:</td>
                                                            <td style="color: #1c1c1e; font-size: 15px; font-weight: 500; text-align: right; vertical-align: top;">
                                                                ${perks.map(perk => `<div style="padding-bottom: 4px;">${perk}</div>`).join('')}
                                                            </td>
              </tr>
                                                    </table>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 50px;">
                                <tr>
                                    <td style="padding-bottom: 30px;">
                                        <h3 style="color: #1c1c1e; font-size: 18px; font-weight: 600; margin: 0 0 16px 0;">What Happens Next</h3>
                                    </td>
                                </tr>
                                
                                <tr>
                                    <td style="padding-bottom: 16px;">
                                        <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0;">
                                            Your sponsorship campaign will go live on Monday of next week.
                                        </p>
                                    </td>
                                </tr>
                                <tr>
                                    <td>
                                        <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0;">
                                            You can track impressions and clicks in the Sponsor Portal.
                                        </p>
                                    </td>
                                </tr>
                            </table>
                            
                            <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 40px;">
                                <tr>
                                    <td align="center">
                                        <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                            <tr>
                                                <td style="padding-bottom: 16px; text-align: center;">
                                                    <p style="color: #1c1c1e; font-size: 16px; font-weight: 500; margin: 0;">
                                                        View your sponsorship
                                                    </p>
                                                </td>
                                            </tr>
                                            <tr>
                                                <td style="background-color: #2F7D31; border-radius: 12px; text-align: center; padding: 20px; box-shadow: 0 4px 12px rgba(47,125,49,0.3);">
                                                    <a href="${portalUrl}" style="display: block; padding: 12px 0; color: #ffffff; text-decoration: none; font-size: 18px; font-weight: 700; line-height: 1; -webkit-text-size-adjust: none;">
                                                        Open Sponsor Portal →
                                                    </a>
                                                </td>
                                            </tr>
                                        </table>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    <tr>
                        <td style="padding: 0 40px;">
                            <table width="100%" cellpadding="0" cellspacing="0" border="0">
                                <tr>
                                    <td height="1" style="background-color: #ededed;"></td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                    
                    <tr>
                        <td style="padding: 30px 40px 40px 40px; text-align: center;">
                            <p style="color: #6a6a6f; font-size: 16px; margin: 0 0 12px 0;">Have a question about your sponsorship?</p>
                            <p style="margin: 0;">
                                <a href="mailto:contactcharitystream@gmail.com" style="color: #2F7D31; font-weight: 600; text-decoration: none; font-size: 16px;">
                                    contactcharitystream@gmail.com
                                </a>
                            </p>
                        </td>
                    </tr>
                    
                    <tr>
                        <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px;">&nbsp;</td>
                    </tr>
                </table>
                
                <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; padding-top: 40px;">
                    <tr>
                        <td align="center">
                            <p style="color: #8e8e93; font-size: 14px; margin: 0 0 16px 0; font-style: normal; line-height: 1.5;">
                                Stream ads. Fuel impact. Compete for good.
                            </p>
                            
                            <table cellpadding="0" cellspacing="0" border="0" align="center">
                                <tr>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">✉</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">in</a>
                                    </td>
                                    <td style="padding: 0 10px;">
                                        <a href="#" style="display: inline-block; width: 28px; height: 28px; background-color: #e5e5ea; border-radius: 50%; text-align: center; line-height: 28px; text-decoration: none; color: #8e8e93; font-size: 14px;">X</a>
                                    </td>
                                </tr>
                            </table>
                        </td>
                    </tr>
                </table>
            </td>
        </tr>
    </table>
    
</body>
</html>
    `;
  }

  // Get sponsor approval text template (plain text version)
  getSponsorApprovalTextTemplate(organizationName, submissionSummary = {}, nextMondayDate) {
    const siteBaseUrl = process.env.SITE_BASE_URL || 'http://localhost:3001';
    const portalUrl = `${siteBaseUrl}/sponsor-login.html`;
    
    const tier = submissionSummary.tier 
      ? submissionSummary.tier.charAt(0).toUpperCase() + submissionSummary.tier.slice(1)
      : 'Not specified';
    const paymentType = submissionSummary.isRecurring ? 'Recurring (Weekly)' : 'One-time';
    
    return `Charity Stream - Sponsorship Approved

Sponsorship Approved

Thank you, ${organizationName} Team. Your sponsorship has been approved and will be live on Monday, ${nextMondayDate}.

Stay Updated in the Sponsor Portal: ${portalUrl}

Sponsor Summary
Organization: ${organizationName}
Sponsorship Tier: ${tier}
Payment Type: ${paymentType}

What Happens Next

Your sponsorship campaign will go live on Monday of next week.

You can track impressions and clicks in the Sponsor Portal.

Open Sponsor Portal: ${portalUrl}

Have a question about your sponsorship?
contactcharitystream@gmail.com

Stream ads. Fuel impact. Compete for good.

-- The Charity Stream Team`;
  }

  // Send sponsor rejection email (after Stripe refund/cancel is complete)
  async sendSponsorRejectionEmail(email, organizationLegalName) {
    try {
      console.log('📧 ===== SENDING SPONSOR REJECTION EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Organization:', organizationLegalName);

      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }

      const subject = `${organizationLegalName || 'Sponsorship'} – Sponsorship Denied`;
      const htmlContent = this.getSponsorRejectionEmailTemplate(organizationLegalName);
      const textContent = this.getSponsorRejectionTextTemplate(organizationLegalName);

      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        text: textContent,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Sponsor rejection email sent successfully');
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Sponsor rejection email failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  getSponsorRejectionEmailTemplate(organizationLegalName) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Stream: Sponsorship Denied</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
    <tr>
      <td align="center" style="padding: 40px 0 60px 0;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
          <tr>
            <td align="left" style="padding-bottom: 32px;">
              <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0;">
                <span style="color: #276629;">Charity</span> Stream
              </h1>
            </td>
          </tr>
        </table>
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px;">
          <tr>
            <td height="5" style="background-color: #b91c1c; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding: 48px 40px 40px 40px;">
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;">
                Dear ${organizationLegalName || 'Sponsor'} Team,
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;">
                Unfortunately, your sponsorship request has been denied due to a failure to adhere to our Sponsorship Community Guidelines.
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 24px 0;">
                Any payments associated with this request will be refunded.
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0;">
                You may review our Sponsorship Community Guidelines here:<br/>
                <a href="${COMMUNITY_GUIDELINES_URL}" style="color: #2F7D31; text-decoration: none;">Community Guidelines (PDF)</a>
              </p>
              <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin: 32px 0 0 0;">
                – The Charity Stream Team
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  getSponsorRejectionTextTemplate(organizationLegalName) {
    return `[${organizationLegalName || 'Sponsorship'}]\u200b Sponsorship Denied

Dear ${organizationLegalName || 'Sponsor'} Team,

Unfortunately, your sponsorship request has been denied due to a failure to adhere to our Sponsorship Community Guidelines.

Any payments associated with this request will be refunded.

You may review our Sponsorship Community Guidelines here:
${COMMUNITY_GUIDELINES_URL}

– The Charity Stream Team`;
  }

  // Send advertiser rejection email (after Stripe refund/cancel is complete)
  async sendAdvertiserRejectionEmail(email, companyName) {
    try {
      console.log('📧 ===== SENDING ADVERTISER REJECTION EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Company:', companyName);

      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }

      const subject = `${companyName || 'Advertising Campaign'} Advertising Campaign Denied`;
      const htmlContent = this.getAdvertiserRejectionEmailTemplate(companyName);
      const textContent = this.getAdvertiserRejectionTextTemplate(companyName);

      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        text: textContent,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Advertiser rejection email sent successfully');
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Advertiser rejection email failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  getAdvertiserRejectionEmailTemplate(companyName) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Stream: Advertising Campaign Denied</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
    <tr>
      <td align="center" style="padding: 40px 0 60px 0;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
          <tr>
            <td align="left" style="padding-bottom: 32px;">
              <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0;">
                <span style="color: #276629;">Charity</span> Stream
              </h1>
            </td>
          </tr>
        </table>
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px;">
          <tr>
            <td height="5" style="background-color: #b91c1c; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding: 48px 40px 40px 40px;">
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;">
                Dear ${companyName || 'Advertising'} Team,
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;">
                Your advertising campaign request has been denied due to a failure to adhere to our Advertising Community Guidelines.
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 24px 0;">
                Any payments associated with this request will be refunded.
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0;">
                You may review our Advertising Community Guidelines here:<br/>
                <a href="${COMMUNITY_GUIDELINES_URL}" style="color: #2F7D31; text-decoration: none;">Community Guidelines (PDF)</a>
              </p>
              <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin: 32px 0 0 0;">
                – The Charity Stream Team
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  getAdvertiserRejectionTextTemplate(companyName) {
    return `[${companyName || 'Advertising Campaign'}]\u200b Advertising Campaign Denied

Dear ${companyName || 'Advertising'} Team,

Your advertising campaign request has been denied due to a failure to adhere to our Advertising Community Guidelines.

Any payments associated with this request will be refunded.

You may review our Advertising Community Guidelines here:
${COMMUNITY_GUIDELINES_URL}

– The Charity Stream Team`;
  }

  /**
   * Fetch PDF from public R2 URL and return buffer. Used for rejection email attachments
   * (sponsor, advertiser, charity). Returns null on failure.
   */
  async fetchPdfAttachmentFromUrl(url) {
    return new Promise((resolve) => {
      const req = https.get(url, { timeout: 15000 }, (res) => {
        if (res.statusCode !== 200) {
          console.warn(`⚠️ PDF fetch failed: ${url} status ${res.statusCode}`);
          resolve(null);
          return;
        }
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => resolve(Buffer.concat(chunks)));
        res.on('error', (err) => {
          console.warn('⚠️ PDF fetch error:', err.message);
          resolve(null);
        });
      });
      req.on('error', (err) => {
        console.warn('⚠️ PDF request error:', err.message);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        console.warn('⚠️ PDF fetch timeout');
        resolve(null);
      });
    });
  }

  // Send charity rejection email (after Stripe refund is complete)
  async sendCharityRejectionEmail(email, charityName) {
    try {
      console.log('📧 Sending charity rejection email to:', email);
      if (!this.isEmailConfigured()) {
        console.warn('⚠️ Email service not configured, skipping charity rejection email');
        return { success: false, error: 'Email service not configured' };
      }
      const subject = `${charityName || 'Charity Application'} – Charity Application Denied`;
      const htmlContent = this.getCharityRejectionEmailTemplate(charityName);
      const textContent = this.getCharityRejectionTextTemplate(charityName);
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        text: textContent,
        html: htmlContent
      };

      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Charity rejection email sent successfully');
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Failed to send charity rejection email:', error);
      return { success: false, error: error.message };
    }
  }

  getCharityRejectionEmailTemplate(charityName) {
    return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Stream: Charity Application Denied</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
    <tr>
      <td align="center" style="padding: 40px 0 60px 0;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
          <tr>
            <td align="left" style="padding-bottom: 32px;">
              <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0;">
                <span style="color: #276629;">Charity</span> Stream
              </h1>
            </td>
          </tr>
        </table>
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px;">
          <tr>
            <td height="5" style="background-color: #b91c1c; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding: 48px 40px 40px 40px;">
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;">
                Dear ${charityName || 'Charity'} Team,
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;">
                Unfortunately, your charity application has been denied due to a failure to adhere to our Charity Partner Community Guidelines.
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 24px 0;">
                Your $1 entry payment associated with this application will be refunded.
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0;">
                You may review our Charity Community Guidelines here:<br/>
                <a href="${CHARITY_GUIDELINES_PDF_URL}" style="color: #2F7D31; text-decoration: none;">Charity Community Guidelines (PDF)</a>
              </p>
              <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin: 32px 0 0 0;">
                – The Charity Stream Team
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `.trim();
  }

  getCharityRejectionTextTemplate(charityName) {
    return `[${charityName || 'Charity Application'}]\u200b Charity Application Denied

Dear ${charityName || 'Charity'} Team,

Unfortunately, your charity application has been denied due to a failure to adhere to our Charity Partner Community Guidelines.

Your $1 entry payment associated with this application will be refunded.

You may review our Charity Community Guidelines here:
${CHARITY_GUIDELINES_PDF_URL}

– The Charity Stream Team`;
  }

  /**
   * Send email to charity when they are selected as the weekly winner.
   * @param {string} email - contact_email for the charity
   * @param {string} charityName - charity_name
   * @param {string} weekStart - YYYY-MM-DD (Monday)
   * @param {string} weekEnd - YYYY-MM-DD (Sunday)
   * @param {{ automatic?: boolean }} [options] - if automatic is true, body says "automatically selected"
   */
  async sendCharityWeekWinnerEmail(email, charityName, weekStart, weekEnd, options = {}) {
    try {
      console.log('📧 Sending charity week winner email to:', email);
      if (!this.isEmailConfigured()) {
        console.warn('⚠️ Email service not configured, skipping charity week winner email');
        return { success: false, error: 'Email service not configured' };
      }
      const isAutomatic = options.automatic === true;
      const selectedWording = isAutomatic
        ? 'has been automatically selected to receive all donations'
        : 'has been selected to receive all donations';
      const subject = "You've Been Selected as Charity of the Week";
      const textContent = `You've Been Selected as Charity of the Week

Congratulations! ${charityName} ${selectedWording} for the week of ${weekStart} through ${weekEnd}.

Funds are typically transferred within 5–7 business days after your week ends.

Have a question? Contact us at: contactcharitystream@gmail.com

Stream ads. Fuel impact. Compete for good.

– The Charity Stream Team`;
      const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Stream: Charity of the Week</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
    <tr>
      <td align="center" style="padding: 40px 0 60px 0;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
          <tr>
            <td align="left" style="padding-bottom: 32px;">
              <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0;">
                <span style="color: #276629;">Charity</span> Stream
              </h1>
            </td>
          </tr>
        </table>
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color: #ffffff; border-radius: 12px; border: 1px solid #e5e5e5; max-width: 600px;">
          <tr>
            <td height="5" style="background-color: #2F7D31; line-height: 5px; font-size: 5px; border-radius: 12px 12px 0 0;">&nbsp;</td>
          </tr>
          <tr>
            <td style="padding: 48px 40px 40px 40px;">
              <p style="color: #1c1c1e; font-size: 18px; font-weight: 600; line-height: 1.5; margin: 0 0 16px 0;">You've Been Selected as Charity of the Week</p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 16px 0;">
                Congratulations! <strong>${charityName}</strong> ${isAutomatic ? 'has been automatically selected' : 'has been selected'} to receive all donations for the week of <strong>${weekStart}</strong> through <strong>${weekEnd}</strong>.
              </p>
              <p style="color: #1c1c1e; font-size: 16px; line-height: 1.6; margin: 0 0 24px 0;">
                Funds are typically transferred within 5–7 business days after your week ends.
              </p>
              <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin: 0;">
                Have a question? Contact us at: contactcharitystream@gmail.com
              </p>
              <p style="color: #4b5563; font-size: 14px; line-height: 1.6; margin: 32px 0 0 0;">
                – The Charity Stream Team
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();
      const mailOptions = {
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        text: textContent,
        html: htmlContent
      };
      const result = await this.transporter.sendMail(mailOptions);
      console.log('✅ Charity week winner email sent successfully');
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Failed to send charity week winner email:', error);
      return { success: false, error: error.message };
    }
  }

  // ── Advertiser campaign ended ────────────────────────────────────────────
  async sendAdvertiserCampaignEndedEmail(email, companyName, totalImpressions) {
    try {
      console.log('📧 ===== SENDING ADVERTISER CAMPAIGN ENDED EMAIL =====');
      console.log('📧 To:', email, '| Company:', companyName, '| Impressions:', totalImpressions);

      if (!this.isEmailConfigured()) {
        return { success: false, error: 'Email service not configured' };
      }

      const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
      const subject = `Your Campaign Has Ended – ${companyName}`;
      const portalUrl = `${siteBaseUrl}/advertiser-login.html`;
      const impressionsFormatted = (totalImpressions || 0).toLocaleString();

      const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${subject}</title></head>
<body style="margin:0;padding:0;background-color:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f7f7;">
    <tr><td align="center" style="padding:40px 0 60px 0;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td align="left" style="padding-bottom:32px;">
          <h1 style="font-size:20px;font-weight:700;color:#1c1c1e;margin:0;">
            <span style="color:#276629;">Charity</span> Stream
          </h1>
        </td></tr>
      </table>
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;border:1px solid #e5e5e5;max-width:600px;">
        <tr><td height="5" style="background-color:#2F7D31;line-height:5px;font-size:5px;border-radius:12px 12px 0 0;">&nbsp;</td></tr>
        <tr><td style="padding:48px 40px 40px 40px;">
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">Dear ${companyName} Team,</p>
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Your advertising campaign on Charity Stream has ended. Thank you for running a campaign that supports charitable causes.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9f9f9;border-radius:8px;margin:0 0 24px 0;">
            <tr><td style="padding:20px 24px;">
              <p style="color:#6b7280;font-size:12px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;margin:0 0 12px 0;">Final Campaign Results</p>
              <p style="color:#1c1c1e;font-size:15px;margin:0;">Total Impressions: <strong>${impressionsFormatted}</strong></p>
            </td></tr>
          </table>
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            You can view your full campaign history and start a new campaign anytime from the Advertiser Portal.
          </p>
          <p style="margin:0 0 24px 0;">
            <a href="${portalUrl}" style="display:inline-block;background-color:#2F7D31;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">View Advertiser Portal</a>
          </p>
          <p style="color:#4b5563;font-size:14px;line-height:1.6;margin:0;">– The Charity Stream Team</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

      const text = `Your Campaign Has Ended – ${companyName}

Dear ${companyName} Team,

Your advertising campaign on Charity Stream has ended. Thank you for running a campaign that supports charitable causes.

FINAL CAMPAIGN RESULTS:
- Total Impressions: ${impressionsFormatted}

You can view your full campaign history and start a new campaign anytime from the Advertiser Portal:
${portalUrl}

– The Charity Stream Team`;

      const result = await this.transporter.sendMail({
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        html,
        text
      });
      console.log('✅ Advertiser campaign ended email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Advertiser campaign ended email failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ── Advertiser campaign paused ───────────────────────────────────────────
  async sendAdvertiserCampaignPausedEmail(email, companyName) {
    try {
      console.log('📧 ===== SENDING ADVERTISER CAMPAIGN PAUSED EMAIL =====');
      console.log('📧 To:', email, '| Company:', companyName);

      if (!this.isEmailConfigured()) {
        return { success: false, error: 'Email service not configured' };
      }

      const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
      const subject = `Your Campaign Has Been Paused – ${companyName}`;
      const portalUrl = `${siteBaseUrl}/advertiser-login.html`;

      const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${subject}</title></head>
<body style="margin:0;padding:0;background-color:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f7f7;">
    <tr><td align="center" style="padding:40px 0 60px 0;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td align="left" style="padding-bottom:32px;">
          <h1 style="font-size:20px;font-weight:700;color:#1c1c1e;margin:0;">
            <span style="color:#276629;">Charity</span> Stream
          </h1>
        </td></tr>
      </table>
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;border:1px solid #e5e5e5;max-width:600px;">
        <tr><td height="5" style="background-color:#6b7280;line-height:5px;font-size:5px;border-radius:12px 12px 0 0;">&nbsp;</td></tr>
        <tr><td style="padding:48px 40px 40px 40px;">
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">Dear ${companyName} Team,</p>
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Your advertising campaign on Charity Stream has been paused. Your ad will no longer serve impressions until you resume it.
          </p>
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            You can resume your campaign at any time from the Advertiser Portal.
          </p>
          <p style="margin:0 0 24px 0;">
            <a href="${portalUrl}" style="display:inline-block;background-color:#2F7D31;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">View Advertiser Portal</a>
          </p>
          <p style="color:#4b5563;font-size:14px;line-height:1.6;margin:0;">– The Charity Stream Team</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

      const text = `Your Campaign Has Been Paused – ${companyName}

Dear ${companyName} Team,

Your advertising campaign on Charity Stream has been paused. Your ad will no longer serve impressions until you resume it.

You can resume your campaign at any time from the Advertiser Portal:
${portalUrl}

– The Charity Stream Team`;

      const result = await this.transporter.sendMail({
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        html,
        text
      });
      console.log('✅ Advertiser campaign paused email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Advertiser campaign paused email failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ── Sponsor sponsorship ended ────────────────────────────────────────────
  async sendSponsorCampaignEndedEmail(email, organizationName, totalImpressions) {
    try {
      console.log('📧 ===== SENDING SPONSOR CAMPAIGN ENDED EMAIL =====');
      console.log('📧 To:', email, '| Org:', organizationName, '| Impressions:', totalImpressions);

      if (!this.isEmailConfigured()) {
        return { success: false, error: 'Email service not configured' };
      }

      const siteBaseUrl = process.env.SITE_BASE_URL || 'https://stream.charity';
      const subject = `Your Sponsorship Has Ended – ${organizationName}`;
      const portalUrl = `${siteBaseUrl}/sponsor-login.html`;
      const impressionsFormatted = (totalImpressions || 0).toLocaleString();

      const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${subject}</title></head>
<body style="margin:0;padding:0;background-color:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f7f7;">
    <tr><td align="center" style="padding:40px 0 60px 0;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td align="left" style="padding-bottom:32px;">
          <h1 style="font-size:20px;font-weight:700;color:#1c1c1e;margin:0;">
            <span style="color:#276629;">Charity</span> Stream
          </h1>
        </td></tr>
      </table>
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;border:1px solid #e5e5e5;max-width:600px;">
        <tr><td height="5" style="background-color:#2F7D31;line-height:5px;font-size:5px;border-radius:12px 12px 0 0;">&nbsp;</td></tr>
        <tr><td style="padding:48px 40px 40px 40px;">
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">Dear ${organizationName} Team,</p>
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Your sponsorship on Charity Stream has come to an end. Thank you for your support — your contribution has made a real difference.
          </p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f9f9f9;border-radius:8px;margin:0 0 24px 0;">
            <tr><td style="padding:20px 24px;">
              <p style="color:#6b7280;font-size:12px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;margin:0 0 12px 0;">Final Sponsorship Results</p>
              <p style="color:#1c1c1e;font-size:15px;margin:0;">Total Impressions: <strong>${impressionsFormatted}</strong></p>
            </td></tr>
          </table>
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            You can view your sponsorship history and start a new sponsorship anytime from the Sponsor Portal.
          </p>
          <p style="margin:0 0 24px 0;">
            <a href="${portalUrl}" style="display:inline-block;background-color:#2F7D31;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:12px 24px;border-radius:8px;">View Sponsor Portal</a>
          </p>
          <p style="color:#4b5563;font-size:14px;line-height:1.6;margin:0;">– The Charity Stream Team</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

      const text = `Your Sponsorship Has Ended – ${organizationName}

Dear ${organizationName} Team,

Your sponsorship on Charity Stream has come to an end. Thank you for your support — your contribution has made a real difference.

FINAL SPONSORSHIP RESULTS:
- Total Impressions: ${impressionsFormatted}

You can view your sponsorship history and start a new sponsorship anytime from the Sponsor Portal:
${portalUrl}

– The Charity Stream Team`;

      const result = await this.transporter.sendMail({
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        html,
        text
      });
      console.log('✅ Sponsor campaign ended email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Sponsor campaign ended email failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  // ── Charity weekly finalization ──────────────────────────────────────────
  async sendCharityFinalizationEmail(email, charityName) {
    try {
      console.log('📧 ===== SENDING CHARITY FINALIZATION EMAIL =====');
      console.log('📧 To:', email, '| Charity:', charityName);

      if (!this.isEmailConfigured()) {
        return { success: false, error: 'Email service not configured' };
      }

      const subject = `Weekly Donation Update – ${charityName}`;

      const html = `
<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${subject}</title></head>
<body style="margin:0;padding:0;background-color:#f7f7f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f7f7f7;">
    <tr><td align="center" style="padding:40px 0 60px 0;">
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
        <tr><td align="left" style="padding-bottom:32px;">
          <h1 style="font-size:20px;font-weight:700;color:#1c1c1e;margin:0;">
            <span style="color:#276629;">Charity</span> Stream
          </h1>
        </td></tr>
      </table>
      <table width="600" cellpadding="0" cellspacing="0" border="0" style="background-color:#ffffff;border-radius:12px;border:1px solid #e5e5e5;max-width:600px;">
        <tr><td height="5" style="background-color:#2F7D31;line-height:5px;font-size:5px;border-radius:12px 12px 0 0;">&nbsp;</td></tr>
        <tr><td style="padding:48px 40px 40px 40px;">
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">Dear ${charityName} Team,</p>
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 16px 0;">
            Great news! The weekly donation cycle has concluded and your donation is currently being processed.
          </p>
          <p style="color:#1c1c1e;font-size:16px;line-height:1.6;margin:0 0 24px 0;">
            Thank you for being a part of Charity Stream — we're proud to support your mission.
          </p>
          <p style="color:#4b5563;font-size:14px;line-height:1.6;margin:0;">– The Charity Stream Team</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`.trim();

      const text = `Weekly Donation Update – ${charityName}

Dear ${charityName} Team,

Great news! The weekly donation cycle has concluded and your donation is currently being processed.

Thank you for being a part of Charity Stream — we're proud to support your mission.

– The Charity Stream Team`;

      const result = await this.transporter.sendMail({
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        html,
        text
      });
      console.log('✅ Charity finalization email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Charity finalization email failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  async sendSponsorPaymentFailedEmail(email, organizationLegalName) {
    try {
      console.log('📧 ===== SENDING SPONSOR PAYMENT FAILED EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Organization:', organizationLegalName);

      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }

      const subject = `${organizationLegalName || 'Sponsorship'} – Payment Failed`;
      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Stream: Sponsorship Payment Failed</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
    <tr>
      <td align="center" style="padding: 40px 0 60px 0;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
          <tr>
            <td align="left" style="padding-bottom: 32px;">
              <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0;">
                <span style="color: #276629;">Charity</span> Stream
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px; border: 1px solid #e5e5ea;">
              <h2 style="font-size: 22px; font-weight: 700; color: #1c1c1e; margin: 0 0 16px 0;">Payment Failed</h2>
              <p style="font-size: 15px; color: #3a3a3c; line-height: 1.6; margin: 0 0 16px 0;">
                Hi ${organizationLegalName || 'there'},
              </p>
              <p style="font-size: 15px; color: #3a3a3c; line-height: 1.6; margin: 0 0 16px 0;">
                We were unable to process the payment for your sponsorship on Charity Stream. Your sponsorship has been paused until payment is resolved.
              </p>
              <p style="font-size: 15px; color: #3a3a3c; line-height: 1.6; margin: 0 0 24px 0;">
                Please log in to your sponsor portal and update your payment method or retry the charge to reactivate your sponsorship.
              </p>
              <p style="font-size: 14px; color: #8e8e93; line-height: 1.6; margin: 0;">
                If you believe this is an error or need assistance, please contact our support team.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 32px;">
              <p style="font-size: 13px; color: #8e8e93; margin: 0; text-align: center;">
                Stream ads. Fuel impact. Compete for good.<br>
                — The Charity Stream Team
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

      const text = `Payment Failed – ${organizationLegalName || 'Sponsorship'}

Hi ${organizationLegalName || 'there'},

We were unable to process the payment for your sponsorship on Charity Stream. Your sponsorship has been paused until payment is resolved.

Please log in to your sponsor portal and update your payment method or retry the charge to reactivate your sponsorship.

If you believe this is an error or need assistance, please contact our support team.

Stream ads. Fuel impact. Compete for good.

-- The Charity Stream Team`;

      const result = await this.transporter.sendMail({
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        html,
        text
      });
      console.log('✅ Sponsor payment failed email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Sponsor payment failed email failed:', error.message);
      return { success: false, error: error.message };
    }
  }

  async sendAdvertiserPaymentFailedEmail(email, companyName) {
    try {
      console.log('📧 ===== SENDING ADVERTISER PAYMENT FAILED EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Company:', companyName);

      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }

      const subject = `${companyName || 'Advertiser'} – Payment Failed`;
      const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Charity Stream: Advertiser Payment Failed</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f7f7f7; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f7f7f7;">
    <tr>
      <td align="center" style="padding: 40px 0 60px 0;">
        <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px;">
          <tr>
            <td align="left" style="padding-bottom: 32px;">
              <h1 style="font-size: 20px; font-weight: 700; color: #1c1c1e; margin: 0;">
                <span style="color: #276629;">Charity</span> Stream
              </h1>
            </td>
          </tr>
          <tr>
            <td style="background-color: #ffffff; border-radius: 12px; padding: 40px; border: 1px solid #e5e5ea;">
              <h2 style="font-size: 22px; font-weight: 700; color: #1c1c1e; margin: 0 0 16px 0;">Payment Failed</h2>
              <p style="font-size: 15px; color: #3a3a3c; line-height: 1.6; margin: 0 0 16px 0;">
                Hi ${companyName || 'there'},
              </p>
              <p style="font-size: 15px; color: #3a3a3c; line-height: 1.6; margin: 0 0 16px 0;">
                We were unable to process the payment for your advertising campaign on Charity Stream. Your campaign has been paused until payment is resolved.
              </p>
              <p style="font-size: 15px; color: #3a3a3c; line-height: 1.6; margin: 0 0 24px 0;">
                Please log in to your advertiser portal and update your payment method to reactivate your campaign.
              </p>
              <p style="font-size: 14px; color: #8e8e93; line-height: 1.6; margin: 0;">
                If you believe this is an error or need assistance, please contact our support team.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-top: 32px;">
              <p style="font-size: 13px; color: #8e8e93; margin: 0; text-align: center;">
                Stream ads. Fuel impact. Compete for good.<br>
                — The Charity Stream Team
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

      const text = `Payment Failed – ${companyName || 'Advertiser'}

Hi ${companyName || 'there'},

We were unable to process the payment for your advertising campaign on Charity Stream. Your campaign has been paused until payment is resolved.

Please log in to your advertiser portal and update your payment method to reactivate your campaign.

If you believe this is an error or need assistance, please contact our support team.

Stream ads. Fuel impact. Compete for good.

-- The Charity Stream Team`;

      const result = await this.transporter.sendMail({
        from: `"Charity Stream" <${process.env.EMAIL_USER}>`,
        to: email,
        subject,
        html,
        text
      });
      console.log('✅ Advertiser payment failed email sent:', result.messageId);
      return { success: true, messageId: result.messageId };
    } catch (error) {
      console.error('❌ Advertiser payment failed email failed:', error.message);
      return { success: false, error: error.message };
    }
  }
}

// Export a singleton instance
module.exports = new EmailService();