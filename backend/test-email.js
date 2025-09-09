const nodemailer = require('nodemailer');

// Test email configuration
async function testEmailConfig() {
  console.log('🧪 Testing email configuration...');
  
  // Replace these with your actual values
  const EMAIL_CONFIG = {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    auth: {
      user: 'YOUR_EMAIL@gmail.com', // Replace with your Gmail
      pass: 'YOUR_APP_PASSWORD'     // Replace with your 16-char app password
    }
  };

  try {
    // Create transporter
    const transporter = nodemailer.createTransporter(EMAIL_CONFIG);
    
    // Verify connection
    console.log('📡 Verifying email connection...');
    await transporter.verify();
    console.log('✅ Email connection verified successfully!');
    
    // Send test email
    console.log('📧 Sending test email...');
    const info = await transporter.sendMail({
      from: `"LetsWatchAds Test" <${EMAIL_CONFIG.auth.user}>`,
      to: EMAIL_CONFIG.auth.user, // Send to yourself
      subject: 'LetsWatchAds Email Test',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
          <div style="background-color: #3f9d5e; color: white; padding: 20px; text-align: center;">
            <h1>🎉 Email Test Successful!</h1>
          </div>
          <div style="padding: 20px; background-color: #f9fafb;">
            <p>If you're reading this, your email configuration is working correctly!</p>
            <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
            <p>You can now proceed with the Google OAuth setup.</p>
          </div>
        </div>
      `
    });
    
    console.log('✅ Test email sent successfully!');
    console.log('📧 Message ID:', info.messageId);
    console.log('📬 Check your inbox for the test email.');
    
  } catch (error) {
    console.error('❌ Email test failed:', error.message);
    console.log('\n🔧 Troubleshooting tips:');
    console.log('1. Make sure 2FA is enabled on your Google account');
    console.log('2. Verify the app password is correct (16 characters)');
    console.log('3. Check that your Gmail address is correct');
    console.log('4. Ensure "Less secure app access" is not enabled (use app passwords instead)');
  }
}

// Run the test
testEmailConfig();

