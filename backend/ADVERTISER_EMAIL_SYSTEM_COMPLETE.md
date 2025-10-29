# Advertiser Email System - Complete Implementation

This document shows all email-related code for advertiser submissions.

## Flow Overview

1. **User submits advertiser form** (`advertiser.html`)
   - Form submits to `/api/advertiser/create-checkout-session`
   - Payment processed via Stripe
   
2. **Stripe webhook fires** (after payment)
   - Event: `customer.subscription.created`
   - Handler: Webhook processes advertiser subscription
   - **Email is sent here** confirming campaign submission

3. **Email contains**:
   - Campaign details summary
   - Approval timeline
   - Payment information
   - Next steps

---

## Code Locations

### 1. Email Service Initialization
**File:** `charitystream/backend/server.js`  
**Lines:** 125-140

```javascript
// Email service - handle missing config gracefully
let emailService = null;
let tokenService = null;

try {
  emailService = require('./services/emailService');
  console.log('✅ Email service loaded');
  
  // Test email service on startup
  console.log('🚀 Initializing email service...');
  if (emailService.isEmailConfigured()) {
    console.log('✅ Email service is properly configured and ready');
  } else {
    console.error('❌ Email service failed to initialize - check your .env configuration');
  }
} catch (error) {
  console.error('❌ Email service import failed:', error);
}
```

---

### 2. Email Trigger Location (Webhook)
**File:** `charitystream/backend/server.js`  
**Lines:** 4488-4566

```javascript
// After advertiser subscription is created and payment succeeded
const advertiser = advertiserResult.rows[0];
console.log('📝 Found advertiser:', { id: advertiser.id, email: advertiser.email });

// Update advertiser status to pending approval
let mediaUrl = advertiser.media_r2_link || null;

const updateResult = await pool.query(
  `UPDATE advertisers 
   SET application_status = 'pending_approval',
       stripe_customer_id = $1,
       stripe_subscription_id = $2,
       media_r2_link = $3,
       updated_at = CURRENT_TIMESTAMP
   WHERE id = $4
   RETURNING id, email, company_name, expedited, click_tracking, ad_format, cpm_rate, weekly_budget_cap`,
  [subscription.customer, subscription.id, mediaUrl, advertiserId]
);

if (updateResult.rows.length > 0) {
  const updatedAdvertiser = updateResult.rows[0];
  console.log('✅ Advertiser status updated:', {
    id: updatedAdvertiser.id,
    email: updatedAdvertiser.email,
    companyName: updatedAdvertiser.company_name,
    expedited: updatedAdvertiser.expedited,
    clickTracking: updatedAdvertiser.click_tracking,
    status: 'pending_approval',
    subscriptionId: subscription.id,
    mediaUrl: mediaUrl
  });
  
  // ✨ EMAIL SENDING HAPPENS HERE ✨
  if (emailService && emailService.isEmailConfigured()) {
    try {
      // Build campaign summary object
      const campaignSummary = {
        ad_format: updatedAdvertiser.ad_format,
        cpm_rate: updatedAdvertiser.cpm_rate,
        weekly_budget_cap: updatedAdvertiser.weekly_budget_cap,
        expedited: updatedAdvertiser.expedited,
        click_tracking: updatedAdvertiser.click_tracking
      };
      
      console.log('📧 Sending advertiser confirmation email with campaign summary:', campaignSummary);
      
      const emailResult = await emailService.sendAdvertiserConfirmationEmail(
        updatedAdvertiser.email,
        updatedAdvertiser.company_name,
        campaignSummary
      );
      
      if (emailResult.success) {
        console.log('✅ Advertiser confirmation email sent successfully');
        console.log('📧 Email message ID:', emailResult.messageId);
      } else {
        console.error('❌ Failed to send confirmation email:', emailResult);
      }
    } catch (emailError) {
      console.error('❌ Error sending confirmation email:', emailError);
    }
  }
}
```

---

### 3. Email Service Main Method
**File:** `charitystream/backend/services/emailService.js`  
**Lines:** 418-471

```javascript
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
```

---

### 4. HTML Email Template
**File:** `charitystream/backend/services/emailService.js`  
**Lines:** 474-557

The template includes:
- Campaign summary with all details
- Payment information (no charge until approved)
- Approval timeline (expedited vs standard)
- Next steps
- Call-to-action button

**Key features:**
- Shows ad format (Video vs Static Image)
- Displays CPM rate
- Shows weekly budget cap
- Indicates if expedited approval was selected
- Shows click tracking status
- Special warning box if expedited
- Payment information box
- Approval process timeline

---

### 5. Text Email Template
**File:** `charitystream/backend/services/emailService.js`  
**Lines:** 560-604

Plain text version of the email for email clients that don't support HTML.

---

## Email Configuration

### Environment Variables Required
**File:** `.env` or environment

```bash
EMAIL_HOST=smtp.gmail.com          # Your SMTP host
EMAIL_PORT=587                      # SMTP port
EMAIL_USER=your-email@gmail.com    # Your email address
EMAIL_PASS=your-app-password       # Your app password or regular password
FRONTEND_URL=https://your-site.com # Your frontend URL
```

### Email Service Checks
**File:** `charitystream/backend/services/emailService.js`  
**Lines:** 13-29

```javascript
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
```

---

## When Email is Sent

The email is triggered in the webhook handler when:
1. ✅ Stripe subscription is created (`customer.subscription.created` event)
2. ✅ Advertiser record exists in database
3. ✅ Campaign status is updated to `pending_approval`
4. ✅ Email service is properly configured
5. ✅ Campaign summary data is available

---

## Email Content

### Subject Line
```
Thank You for Your Advertising Campaign Submission - {CompanyName}
```

### Email Includes
1. **Campaign Summary Table:**
   - Ad Format (Video/Static Image)
   - CPM Rate per 1000 views
   - Weekly Budget Cap
   - Expedited Approval (Yes/No)
   - Click Tracking (Yes/No)

2. **Expedited Processing Notice** (if selected):
   - Special highlighted box
   - 24-48 hour approval timeline

3. **Payment Information:**
   - No charge until approved
   - Pay only for actual views/clicks

4. **Approval Process:**
   - Review process explanation
   - Timeline expectations
   - Notification method
   - Campaign launch process
   - Performance tracking

5. **Call-to-Action:**
   - Button to view campaign status

---

## Common Issues & Solutions

### Issue 1: Email Not Sending
**Symptoms:** No email received after advertiser submission

**Check:**
1. Is emailService configured? Check logs for:
   - `✅ Email service is properly configured and ready`
2. Is transporter ready? Check logs for:
   - `✅ Email transporter is ready to send messages`
3. Are environment variables set?
4. Check webhook logs for email sending attempts

### Issue 2: Email Configuration Errors
**Symptoms:** `❌ Email service not configured`

**Solution:**
1. Set all 4 required environment variables:
   - `EMAIL_HOST`
   - `EMAIL_PORT`
   - `EMAIL_USER`
   - `EMAIL_PASS`
2. Restart the server
3. Check logs for configuration errors

### Issue 3: Transporter Not Initialized
**Symptoms:** Email service check passes but emails don't send

**Solution:**
1. Check transporter verification logs
2. Verify SMTP credentials
3. Check firewall/network restrictions
4. For Gmail: Use App Password, not regular password

### Issue 4: Webhook Not Triggering
**Symptoms:** No email sent, webhook logs show nothing

**Solution:**
1. Verify Stripe webhook is configured
2. Check webhook endpoint URL
3. Ensure `customer.subscription.created` event is enabled
4. Check webhook logs in Stripe dashboard

---

## Testing Email System

### Option 1: Test via Environment
```bash
# Set environment variables
export EMAIL_HOST=smtp.gmail.com
export EMAIL_PORT=587
export EMAIL_USER=your-email@gmail.com
export EMAIL_PASS=your-app-password

# Run the app
node server.js
```

### Option 2: Test Email Service Directly
**File:** `charitystream/backend/test-email.js`

```bash
node test-email.js
```

This will attempt to send a test email and show results.

---

## Debugging Tips

1. **Check server logs** for email-related messages:
   ```
   📧 Sending advertiser confirmation email with campaign summary: { ... }
   ✅ Advertiser confirmation email sent successfully
   ```

2. **Look for error logs**:
   ```
   ❌ ===== ADVERTISER CONFIRMATION EMAIL FAILED =====
   ❌ Error details: ...
   ❌ Error code: ...
   ```

3. **Verify email configuration**:
   ```
   ❌ Missing email configuration: [EMAIL_HOST, EMAIL_PORT]
   ```

4. **Check webhook processing**:
   ```
   ✅ ===== SUBSCRIPTION CREATED =====
   📝 Processing advertiser subscription creation...
   ```

---

## File Summary

| File | Purpose | Lines |
|------|---------|-------|
| `server.js` | Email service initialization and webhook trigger | 125-140, 4488-4566 |
| `services/emailService.js` | Email service class and methods | Full file (606 lines) |
| `advertiser.html` | Frontend form submission | Line 1593 (fetch call) |

---

## Next Steps to Fix/Complete

1. ✅ Email service exists
2. ✅ Email template is complete
3. ✅ Webhook triggers email sending
4. ⏳ Verify environment variables are set
5. ⏳ Test email sending from webhook
6. ⏳ Verify email delivery

The system is **fully implemented** - you just need to:
1. Configure your SMTP credentials in `.env`
2. Ensure your Stripe webhook is configured
3. Test the full flow

---

## Quick Test Checklist

- [ ] Email environment variables set in `.env`
- [ ] Server logs show "✅ Email service is properly configured and ready"
- [ ] Webhook URL configured in Stripe
- [ ] Submit test advertiser campaign
- [ ] Check server logs for email sending
- [ ] Check recipient inbox for email
- [ ] Verify email content matches campaign details

