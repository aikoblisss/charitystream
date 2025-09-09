const nodemailer = require('nodemailer');
const crypto = require('crypto');
const config = require('../config');

// Email configuration
const EMAIL_CONFIG = {
  host: process.env.EMAIL_HOST || config.email.host,
  port: process.env.EMAIL_PORT || config.email.port,
  secure: false, // true for 465, false for other ports
  auth: {
    user: process.env.EMAIL_USER || config.email.user,
    pass: process.env.EMAIL_PASS || config.email.pass
  }
};

// Create transporter
const transporter = nodemailer.createTransporter(EMAIL_CONFIG);

// Generate verification token
function generateVerificationToken() {
  return crypto.randomBytes(32).toString('hex');
}

// Send verification email
async function sendVerificationEmail(email, username, verificationToken) {
  try {
    const verificationUrl = `${process.env.FRONTEND_URL || config.frontendUrl}/verify-email?token=${verificationToken}`;
    
    const mailOptions = {
      from: `"LetsWatchAds" <${EMAIL_CONFIG.auth.user}>`,
      to: email,
      subject: 'Verify Your Email - LetsWatchAds',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #3f9d5e; color: white; padding: 20px; text-align: center;">
            <h1>Welcome to LetsWatchAds!</h1>
          </div>
          <div style="padding: 20px; background-color: #f9fafb;">
            <h2>Hi ${username}!</h2>
            <p>Thank you for signing up with Google OAuth. To complete your registration and start watching ads for charity, please verify your email address.</p>
            
            <div style="text-align: center; margin: 30px 0;">
              <a href="${verificationUrl}" 
                 style="background-color: #3f9d5e; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
                Verify Email Address
              </a>
            </div>
            
            <p>If the button doesn't work, you can copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${verificationUrl}</p>
            
            <p>This link will expire in 24 hours for security reasons.</p>
            
            <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;">
            <p style="color: #666; font-size: 14px;">
              If you didn't create an account with LetsWatchAds, you can safely ignore this email.
            </p>
          </div>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Verification email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Error sending verification email:', error);
    return { success: false, error: error.message };
  }
}

// Send welcome email after verification
async function sendWelcomeEmail(email, username) {
  try {
    const mailOptions = {
      from: `"LetsWatchAds" <${EMAIL_CONFIG.auth.user}>`,
      to: email,
      subject: 'Welcome to LetsWatchAds - Start Watching Ads for Charity!',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #3f9d5e; color: white; padding: 20px; text-align: center;">
            <h1>🎉 Welcome to LetsWatchAds!</h1>
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
              <a href="${process.env.FRONTEND_URL || config.frontendUrl}" 
                 style="background-color: #3f9d5e; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; display: inline-block;">
                Start Watching Ads
              </a>
            </div>
            
            <p>Thank you for joining our mission to make a positive impact through ad watching!</p>
          </div>
        </div>
      `
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Welcome email sent:', info.messageId);
    return { success: true, messageId: info.messageId };
  } catch (error) {
    console.error('❌ Error sending welcome email:', error);
    return { success: false, error: error.message };
  }
}

module.exports = {
  generateVerificationToken,
  sendVerificationEmail,
  sendWelcomeEmail
};
