# Advertiser Confirmation Email - Diagnostic Guide

This guide helps you diagnose and fix issues with the advertiser confirmation email system.

## Quick Diagnostic Steps

### 1. Check Server Startup Logs

When you start the server, look for these messages:

**✅ GOOD:**
```
✅ Email service loaded
🚀 Initializing email service...
🔍 DEBUG: emailService available: true
🔍 DEBUG: emailService.isEmailConfigured: true
🔍 DEBUG: emailService.transporter: true
✅ Email service is properly configured and ready
```

**❌ BAD (Configuration Issue):**
```
✅ Email service loaded
🚀 Initializing email service...
❌ Email service failed to initialize - check your .env configuration
🔍 DEBUG: Missing env vars: {
  EMAIL_HOST: false,
  EMAIL_PORT: false,
  EMAIL_USER: false,
  EMAIL_PASS: false
}
```

**Fix:** Add these to your `.env` file:
```env
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
```

---

### 2. Test the Email Service Directly

We've added a test endpoint that lets you manually trigger the email to verify it works.

**Test Command:**
```bash
curl -X POST http://localhost:3001/test-advertiser-email \
  -H "Content-Type: application/json" \
  -d '{
    "email": "your-test@email.com",
    "companyName": "Test Company"
  }'
```

**Or using PowerShell (Windows):**
```powershell
Invoke-WebRequest -Uri "http://localhost:3001/test-advertiser-email" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body (@{email="your-test@email.com"; companyName="Test Company"} | ConvertTo-Json)
```

**Expected Response (Success):**
```json
{
  "success": true,
  "result": {
    "success": true,
    "messageId": "<message-id@domain.com>"
  },
  "debug": {
    "emailServiceAvailable": true,
    "emailServiceConfigured": true,
    "hasTransporter": true
  }
}
```

**Expected Response (Failure):**
```json
{
  "success": false,
  "result": {
    "success": false,
    "error": "Email service not configured"
  },
  "debug": {
    "emailServiceAvailable": true,
    "emailServiceConfigured": false,
    "hasTransporter": false
  }
}
```

---

### 3. Check Webhook Logs

When an advertiser completes payment, check your server logs for these messages:

**✅ GOOD (Email Sent):**
```
✅ ===== SUBSCRIPTION CREATED =====
📝 Processing advertiser subscription creation...
📝 Found advertiser: { id: 123, email: 'advertiser@example.com' }
🔍 DEBUG: About to check email service...
🔍 DEBUG: emailService exists: true
🔍 DEBUG: emailService.isEmailConfigured: true
🔍 DEBUG: Email service is configured, proceeding to send email
🔍 DEBUG: Reached email sending point in webhook
📧 Sending advertiser confirmation email to: advertiser@example.com
📧 Campaign summary data: { ad_format: 'video', ... }
✅ Advertiser confirmation email sent successfully
📧 Email message ID: <message-id>
```

**❌ BAD (Email Not Configured):**
```
✅ ===== SUBSCRIPTION CREATED =====
📝 Processing advertiser subscription creation...
📝 Found advertiser: { id: 123, email: 'advertiser@example.com' }
🔍 DEBUG: About to check email service...
🔍 DEBUG: emailService exists: true
🔍 DEBUG: emailService.isEmailConfigured: false
⚠️ Email service NOT configured - skipping email
⚠️ Details: {
  emailServiceExists: true,
  isConfigured: false,
  hasTransporter: false
}
```

**Fix:** Configure environment variables (see step 1).

---

## Common Issues & Solutions

### Issue 1: Email Service Not Configured

**Symptoms:**
- Server logs show `❌ Email service failed to initialize`
- Test endpoint returns `emailServiceConfigured: false`
- No email sent after Stripe payment

**Solution:**
1. Create/update `.env` file in `charitystream/backend/`
2. Add these variables:
   ```env
   EMAIL_HOST=smtp.gmail.com
   EMAIL_PORT=587
   EMAIL_USER=your-email@gmail.com
   EMAIL_PASS=your-app-password
   ```
3. Restart the server

**For Gmail:**
- Go to Google Account settings
- Enable 2-factor authentication
- Generate an "App Password" (not your regular password)
- Use this app password in `EMAIL_PASS`

---

### Issue 2: Transporter Not Initialized

**Symptoms:**
- Service shows as configured but emails don't send
- Test endpoint returns `hasTransporter: false`

**Solution:**
1. Check if transporter verification failed on startup
2. Look for: `❌ Email transporter verification failed`
3. Common causes:
   - Wrong credentials
   - Network/firewall blocking SMTP
   - Gmail needs app password (not regular password)

**Debug:**
```javascript
// Add to server.js temporarily to see verification result
emailService.transporter.verify((error, success) => {
  console.log('Verification error:', error);
  console.log('Verification success:', success);
});
```

---

### Issue 3: Webhook Not Receiving Events

**Symptoms:**
- No webhook logs after payment
- Email service is configured but no emails sent

**Solution:**
1. Check Stripe webhook configuration:
   - Go to Stripe Dashboard → Webhooks
   - Verify endpoint URL: `https://your-domain.com/api/webhook`
   - Check if `customer.subscription.created` event is enabled

2. Check webhook logs in Stripe dashboard
   - Look for failed deliveries
   - Check response codes

3. Test webhook locally:
   ```bash
   # Install Stripe CLI
   stripe listen --forward-to localhost:3001/api/webhook
   
   # In another terminal, trigger test event
   stripe trigger customer.subscription.created
   ```

---

### Issue 4: Email Goes to Spam

**Symptoms:**
- Email service says it sent successfully
- No email in inbox (not even spam folder)

**Solution:**
1. Check spam folder
2. Verify sender email (`EMAIL_USER`) is correct
3. Add SPF/DKIM records to your domain (if using custom domain)
4. Use a reputable email service (Gmail, SendGrid, etc.)

---

## Enhanced Logging

The code now includes extensive debug logging. Look for these log prefixes:

| Prefix | Meaning |
|--------|---------|
| `🔍 DEBUG:` | Debug diagnostic information |
| `📧` | Email sending process |
| `✅` | Successful operation |
| `❌` | Error occurred |
| `⚠️` | Warning (non-critical) |

---

## Testing Checklist

Use this checklist to verify the system is working:

- [ ] Server starts without email errors
- [ ] Logs show "✅ Email service is properly configured and ready"
- [ ] Test endpoint returns success with `hasTransporter: true`
- [ ] Test email is received in inbox
- [ ] Submit a real advertiser campaign
- [ ] Complete Stripe payment
- [ ] Check server logs for webhook processing
- [ ] Verify email sent successfully
- [ ] Check inbox for confirmation email

---

## Manual Testing

### Step 1: Verify Email Service is Configured

```bash
# Check server logs on startup
# Look for: "✅ Email service is properly configured and ready"
```

### Step 2: Test Email Endpoint

```bash
curl -X POST http://localhost:3001/test-advertiser-email \
  -H "Content-Type: application/json" \
  -d '{"email":"your-email@test.com","companyName":"Test Co"}'
```

### Step 3: Check Response

**If successful:**
```json
{
  "success": true,
  "result": {
    "success": true,
    "messageId": "..."
  }
}
```

**If failed:**
```json
{
  "success": false,
  "result": {
    "success": false,
    "error": "Email service not configured"
  }
}
```

### Step 4: Submit Real Campaign

1. Fill out advertiser form
2. Complete Stripe payment
3. Check server logs for webhook processing
4. Verify email was sent

---

## Environment Variables Reference

```env
# Required for email service
EMAIL_HOST=smtp.gmail.com           # SMTP server hostname
EMAIL_PORT=587                       # SMTP port (587 for TLS, 465 for SSL)
EMAIL_USER=your-email@gmail.com    # Your email address
EMAIL_PASS=your-app-password       # Your app password (not regular password)
FRONTEND_URL=http://localhost:3001  # Your frontend URL (for links in emails)

# Optional - for production
NODE_ENV=production
```

---

## Email Service Architecture

```
Frontend (advertiser.html)
    ↓
Submit Form → /api/advertiser/create-checkout-session
    ↓
Stripe Checkout
    ↓
Payment Success → Stripe Webhook
    ↓
Event: customer.subscription.created
    ↓
Server.js Webhook Handler (lines 4533+)
    ↓
Update Advertiser Status
    ↓
Check emailService.isEmailConfigured()
    ↓
emailService.sendAdvertiserConfirmationEmail()
    ↓
Email Service (services/emailService.js)
    ↓
SMTP Transporter (Nodemailer)
    ↓
Email Sent → Advertiser's Inbox
```

---

## Still Not Working?

If emails still aren't sending after following this guide:

1. **Check all logs** - Look for `❌` or `⚠️` messages
2. **Verify environment variables** - Make sure all 4 EMAIL_* vars are set
3. **Test with a simple script** - Use the test endpoint
4. **Check SMTP credentials** - Wrong password is #1 cause of failures
5. **Try a different email provider** - Gmail, SendGrid, Mailgun, etc.
6. **Review server logs** - All debug info is logged to console

---

## Quick Debug Commands

```bash
# Check if email service is configured
curl http://localhost:3001/test-advertiser-email \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{"email":"test@test.com","companyName":"Test"}'

# Check Stripe webhook logs (if using Stripe CLI)
stripe listen --forward-to localhost:3001/api/webhook

# View recent server logs
tail -f server.log | grep -E "(DEBUG|EMAIL|📧)"
```

---

## Files Modified for Diagnostics

1. **server.js** (lines 125-154):
   - Added debug logging on email service initialization
   - Shows which environment variables are missing

2. **server.js** (lines 4549-4593):
   - Added extensive debug logging in webhook handler
   - Shows email service status before attempting to send
   - Logs campaign summary data being sent

3. **server.js** (lines 4443-4530):
   - Added `/test-advertiser-email` endpoint
   - Allows manual testing of email system
   - Returns detailed debug information

---

## Success Indicators

You'll know the system is working when you see:

1. ✅ Server logs show email service ready
2. ✅ Test endpoint returns `success: true`
3. ✅ Real campaign emails are sent
4. ✅ Emails appear in inbox (not spam)

