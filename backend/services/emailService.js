const nodemailer = require('nodemailer');

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

Thank you for your payment! You're now a Charity Stream Premium member. Your subscription helps support our mission while giving you access to exclusive features.

🌟 Premium Benefits Unlocked:
• Pop-out player (Chrome extension)
• 1.25x ad speed for faster watching  
• Fewer interruptions during your session
• HD quality videos (up to 1080p)
• Direct support for charity causes

Start watching premium ads: ${frontendUrl}

Your subscription will automatically renew monthly. You can manage your subscription anytime from your account settings.

Thank you for supporting our mission to make a positive impact through ad watching!

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
          <h1>🎉 Welcome to Charity Stream Premium!</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${username}!</h2>
          <p>Thank you for your payment! You're now a Charity Stream Premium member. Your subscription helps support our mission while giving you access to exclusive features.</p>
          
          <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
            <h3>🌟 Premium Benefits Unlocked:</h3>
            <ul>
              <li>Pop-out player (Chrome extension)</li>
              <li>1.25x ad speed for faster watching</li>
              <li>Fewer interruptions during your session</li>
              <li>HD quality videos (up to 1080p)</li>
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
  getAdvertiserConfirmationEmailTemplate(companyName, campaignSummary = {}, signupToken = null) {
    console.log('📧 [TEMPLATE] getAdvertiserConfirmationEmailTemplate called - NEW VERSION');
    console.log('📧 [TEMPLATE] Company:', companyName);
    console.log('📧 [TEMPLATE] Campaign Summary:', campaignSummary);
    
    const frontendUrl = process.env.FRONTEND_URL || 'https://charitystream.com';
    const isExpedited = campaignSummary.expedited || false;
    const signupUrl = signupToken
      ? `${frontendUrl}/advertiser-signup.html?token=${signupToken}`
      : `${frontendUrl}/advertiser-signup.html`;
    
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
    const frontendUrl = process.env.FRONTEND_URL || 'https://charitystream.com';
    const signupUrl = signupToken
      ? `${frontendUrl}/advertiser-signup.html?token=${signupToken}`
      : `${frontendUrl}/advertiser-signup.html`;
    
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
      
      const frontendUrl = process.env.FRONTEND_URL || 'https://charitystream.com';
      const subject = `Your Advertising Campaign Has Been Approved - ${companyName}`;
      
      // Format campaign details
      const adFormat = campaignSummary.ad_format === 'video' ? 'Video' : 'Static Image';
      const cpmRate = campaignSummary.cpm_rate ? `$${parseFloat(campaignSummary.cpm_rate).toFixed(2)}` : 'Not specified';
      const weeklyBudget = campaignSummary.weekly_budget_cap ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` : 'Not specified';
      const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
      const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
      
      const htmlContent = `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
            <h1>🎉 Your Campaign Has Been Approved!</h1>
          </div>
          <div style="padding: 20px; background-color: #f9fafb;">
            <h2>Hi ${companyName} team,</h2>
            <p>Your advertising campaign has been <strong>approved</strong> and is now playing on Charity Stream.</p>
            
            <div style="background-color: white; padding: 20px; border-radius: 5px; margin: 20px 0;">
              <h3>📋 Campaign Summary</h3>
              <table style="width: 100%; border-collapse: collapse;">
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Ad Format:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${adFormat}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">CPM Rate:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${cpmRate} per 1000 views</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Weekly Budget Cap:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${weeklyBudget}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee; font-weight: bold;">Expedited Approval:</td>
                  <td style="padding: 8px 0; border-bottom: 1px solid #eee;">${expeditedApproval}</td>
                </tr>
                <tr>
                  <td style="padding: 8px 0; font-weight: bold;">Click Tracking:</td>
                  <td style="padding: 8px 0;">${clickTracking}</td>
                </tr>
              </table>
            </div>
            
            ${signupToken ? `
            <div style="background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; border-radius: 5px; margin: 20px 0;">
              <h3>🔐 Access Your Campaign Dashboard</h3>
              <p>Create your advertiser portal account to access your campaign dashboard and track performance:</p>
              <div style="text-align: center; margin: 15px 0;">
                <a href="${frontendUrl}/advertiser-signup.html?token=${signupToken}" 
                   style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
                  Create Portal Account
                </a>
              </div>
            </div>
            ` : ''}
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${frontendUrl}/advertiser.html" 
                 style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
                View Campaign Status
              </a>
            </div>
            
            <p>If you have any questions, please contact us at <strong>charity.stream.support@gmail.com</strong>.</p>
          </div>
        </div>
      `;
      
      const signupUrl = signupToken ? `${frontendUrl}/advertiser-signup.html?token=${signupToken}` : null;
      const textContent = `Your Advertising Campaign Has Been Approved - ${companyName}\n\nHi ${companyName} team,\n\nYour advertising campaign has been approved and is now playing on Charity Stream.\n\nCAMPAIGN SUMMARY:\n- Ad Format: ${adFormat}\n- CPM Rate: ${cpmRate} per 1000 views\n- Weekly Budget Cap: ${weeklyBudget}\n- Expedited Approval: ${expeditedApproval}\n- Click Tracking: ${clickTracking}\n\n${signupUrl ? `ACCESS YOUR CAMPAIGN DASHBOARD:\nCreate your advertiser portal account to access your campaign dashboard:\n${signupUrl}\n\n` : ''}View your campaign status: ${frontendUrl}/advertiser.html\n\nQuestions? Contact charity.stream.support@gmail.com`;
      
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
}

// Export a singleton instance
module.exports = new EmailService();