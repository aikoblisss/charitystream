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
      
      console.log('🔧 Creating email transporter...');
      this.transporter = nodemailer.createTransport({
        host: process.env.EMAIL_HOST,
        port: parseInt(process.env.EMAIL_PORT),
        secure: false, // true for 465, false for other ports
        auth: {
          user: process.env.EMAIL_USER,
          pass: cleanEmailPass, // Use cleaned password
        },
        // Add connection timeout
        connectionTimeout: 10000,
        // Add greeting timeout
        greetingTimeout: 10000,
      });

      console.log('✅ Email transporter created, verifying connection...');
      
      // Verify transporter configuration
      this.transporter.verify((error, success) => {
        if (error) {
          console.error('❌ Email transporter verification failed:', error);
          console.error('❌ Error details:', error.message);
          this.transporter = null;
        } else {
          console.log('✅ Email transporter is ready to send messages');
          console.log('✅ SMTP connection successful');
        }
      });
      
    } catch (error) {
      console.error('❌ Failed to create email transporter:', error);
      this.transporter = null;
    }
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
  async sendAdvertiserConfirmationEmail(email, companyName, campaignSummary = {}) {
    try {
      console.log('📧 ===== SENDING ADVERTISER CONFIRMATION EMAIL =====');
      console.log('📧 To:', email);
      console.log('📧 Company:', companyName);
      console.log('📧 Campaign Summary:', campaignSummary);
      
      if (!this.isEmailConfigured()) {
        console.error('❌ Email service not configured');
        return { success: false, error: 'Email service not configured' };
      }
      
      const isExpedited = campaignSummary.expedited || false;
      const subject = `Thank You for Your Advertising Campaign Submission - ${companyName}`;
      
      const htmlContent = this.getAdvertiserConfirmationEmailTemplate(companyName, campaignSummary);
      const textContent = this.getAdvertiserConfirmationTextTemplate(companyName, campaignSummary);
      
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
  getAdvertiserConfirmationEmailTemplate(companyName, campaignSummary = {}) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const isExpedited = campaignSummary.expedited || false;
    
    // Format campaign details
    const adFormat = campaignSummary.ad_format === 'video' ? 'Video' : 'Static Image';
    const cpmRate = campaignSummary.cpm_rate ? `$${parseFloat(campaignSummary.cpm_rate).toFixed(2)}` : 'Not specified';
    const weeklyBudget = campaignSummary.weekly_budget_cap ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` : 'Not specified';
    const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
    const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
    
    return `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #2F7D31; color: white; padding: 20px; text-align: center;">
          <h1>🎉 Thank You for Your Advertising Campaign Submission!</h1>
        </div>
        <div style="padding: 20px; background-color: #f9fafb;">
          <h2>Hi ${companyName} team,</h2>
          <p>Thank you for choosing Charity Stream! Your advertising campaign has been successfully submitted and is now pending review.</p>
          
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
          
          ${isExpedited ? `
          <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <strong>🚀 Expedited Processing:</strong> Your campaign will receive priority review and should be approved within 24-48 hours instead of the standard 3-5 business days.
          </div>
          ` : ''}
          
          <div style="background-color: #d1ecf1; border: 1px solid #bee5eb; padding: 15px; border-radius: 5px; margin: 20px 0;">
            <h3>💰 Important Payment Information</h3>
            <p><strong>You will NOT be charged until your campaign is approved.</strong></p>
            <p>Once approved, you'll only pay for actual views/clicks based on your CPM rate. This ensures you only pay for real engagement with your ads.</p>
          </div>
          
          <h3>📅 Approval Process</h3>
          <ul>
            <li><strong>Review Process:</strong> Our team will review your campaign and creative materials</li>
            <li><strong>Timeline:</strong> ${isExpedited ? '24-48 hours' : '3-5 business days'} for approval decision</li>
            <li><strong>Notification:</strong> You'll receive an email notification once approved</li>
            <li><strong>Campaign Launch:</strong> Your ads will start running and generating charitable impact</li>
            <li><strong>Performance Tracking:</strong> Monitor your campaign performance in real-time</li>
          </ul>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${frontendUrl}/advertiser.html" 
               style="background-color: #2F7D31; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
              View Campaign Status
            </a>
          </div>
          
          <p>Thank you for choosing Charity Stream to make your advertising dollars count twice!</p>
          
          <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
          <p style="color: #666; font-size: 14px;">
            Questions? Reply to this email or visit our support center.
          </p>
        </div>
      </div>
    `;
  }
  
  // Get advertiser confirmation text template with campaign summary
  getAdvertiserConfirmationTextTemplate(companyName, campaignSummary = {}) {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3001';
    const isExpedited = campaignSummary.expedited || false;
    
    // Format campaign details
    const adFormat = campaignSummary.ad_format === 'video' ? 'Video' : 'Static Image';
    const cpmRate = campaignSummary.cpm_rate ? `$${parseFloat(campaignSummary.cpm_rate).toFixed(2)}` : 'Not specified';
    const weeklyBudget = campaignSummary.weekly_budget_cap ? `$${parseFloat(campaignSummary.weekly_budget_cap).toFixed(2)}` : 'Not specified';
    const clickTracking = campaignSummary.click_tracking ? 'Yes' : 'No';
    const expeditedApproval = campaignSummary.expedited ? 'Yes' : 'No';
    
    return `
Thank You for Your Advertising Campaign Submission - ${companyName}

Hi ${companyName} team,

Thank you for choosing Charity Stream! Your advertising campaign has been successfully submitted and is now pending review.

CAMPAIGN SUMMARY:
- Ad Format: ${adFormat}
- CPM Rate: ${cpmRate} per 1000 views
- Weekly Budget Cap: ${weeklyBudget}
- Expedited Approval: ${expeditedApproval}
- Click Tracking: ${clickTracking}

${isExpedited ? 'EXPEDITED PROCESSING: Your campaign will receive priority review and should be approved within 24-48 hours instead of the standard 3-5 business days.\n' : ''}

IMPORTANT PAYMENT INFORMATION:
You will NOT be charged until your campaign is approved. Once approved, you'll only pay for actual views/clicks based on your CPM rate. This ensures you only pay for real engagement with your ads.

APPROVAL PROCESS:
- Review Process: Our team will review your campaign and creative materials
- Timeline: ${isExpedited ? '24-48 hours' : '3-5 business days'} for approval decision
- Notification: You'll receive an email notification once approved
- Campaign Launch: Your ads will start running and generating charitable impact
- Performance Tracking: Monitor your campaign performance in real-time

View your campaign status: ${frontendUrl}/advertiser.html

Thank you for choosing Charity Stream to make your advertising dollars count twice!

Charity Stream - Making Every Dollar Count Twice
Questions? Reply to this email or visit our support center.
    `;
  }
}

// Export a singleton instance
module.exports = new EmailService();