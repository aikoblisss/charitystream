// Test script to verify donation thank you email sending
// This uses the same emailService that the webhook uses

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

async function testDonationEmail() {
  console.log('🧪 ===== TESTING DONATION THANK YOU EMAIL =====');
  console.log('🧪 Target email: brandengreene03@gmail.com');
  console.log('');
  
  // Check environment variables
  console.log('📋 Environment Check:');
  console.log('  EMAIL_HOST:', process.env.EMAIL_HOST ? '✅ SET' : '❌ MISSING');
  console.log('  EMAIL_PORT:', process.env.EMAIL_PORT ? `✅ SET (${process.env.EMAIL_PORT})` : '❌ MISSING');
  console.log('  EMAIL_USER:', process.env.EMAIL_USER ? `✅ SET (${process.env.EMAIL_USER})` : '❌ MISSING');
  console.log('  EMAIL_PASS:', process.env.EMAIL_PASS ? `✅ SET (${process.env.EMAIL_PASS.length} chars)` : '❌ MISSING');
  console.log('');
  
  // Load email service (same way server.js does it)
  let emailService;
  try {
    console.log('📦 Loading email service...');
    emailService = require('./services/emailService');
    console.log('✅ Email service loaded');
    console.log('  emailService exists:', !!emailService);
    console.log('  isEmailConfigured:', emailService.isEmailConfigured());
    console.log('  transporter exists:', !!emailService.transporter);
    console.log('');
  } catch (error) {
    console.error('❌ Failed to load email service:', error.message);
    console.error('❌ Error stack:', error.stack);
    process.exit(1);
  }
  
  // Verify email service is configured
  if (!emailService.isEmailConfigured()) {
    console.error('❌ Email service is not configured!');
    console.error('❌ Check your .env file for EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS');
    process.exit(1);
  }
  
  // Test email service connection
  if (!emailService.transporter) {
    console.error('❌ Email transporter is not initialized!');
    console.error('❌ This means the email service failed to create a transporter');
    process.exit(1);
  }
  
  try {
    console.log('🔍 Verifying email transporter connection...');
    await emailService.transporter.verify();
    console.log('✅ Email transporter verified successfully');
    console.log('');
  } catch (verifyError) {
    console.error('❌ Email transporter verification failed:', verifyError.message);
    console.error('❌ This means SMTP connection is failing');
    console.error('❌ Check EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS');
    process.exit(1);
  }
  
  // Test sending donation thank you email (exact same function webhook uses)
  const testEmail = 'brandengreene03@gmail.com';
  const testUsername = 'branden';
  const testAmount = 300; // $3.00 in cents
  
  console.log('📧 Testing donation thank you email send...');
  console.log('  To:', testEmail);
  console.log('  Username:', testUsername);
  console.log('  Amount:', testAmount, 'cents ($3.00)');
  console.log('');
  
  try {
    const result = await emailService.sendDonationThankYouEmail(
      testEmail,
      testUsername,
      testAmount
    );
    
    if (result.success) {
      console.log('');
      console.log('✅ ===== TEST EMAIL SENT SUCCESSFULLY =====');
      console.log('✅ Message ID:', result.messageId);
      console.log('✅ Email sent to:', testEmail);
      console.log('');
      console.log('📬 Please check the inbox for brandengreene03@gmail.com');
      console.log('📬 Also check spam/junk folder if not in inbox');
      console.log('');
      console.log('🧪 If this email works but webhook emails dont,');
      console.log('🧪 then the issue is in the webhook handler, not the email service');
    } else {
      console.error('');
      console.error('❌ ===== TEST EMAIL FAILED =====');
      console.error('❌ Error:', result.error);
      console.error('❌ Email service function returned success: false');
    }
  } catch (sendError) {
    console.error('');
    console.error('❌ ===== TEST EMAIL SEND EXCEPTION =====');
    console.error('❌ Error:', sendError.message);
    console.error('❌ Stack:', sendError.stack);
    console.error('');
    console.error('🔧 This indicates an error in sendDonationThankYouEmail()');
  }
  
  console.log('');
  console.log('🧪 Test complete!');
}

// Run the test
testDonationEmail()
  .then(() => {
    console.log('✅ Test script completed');
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Test script failed:', error);
    process.exit(1);
  });

