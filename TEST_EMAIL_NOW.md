# Test Email Sending Right Now

## Problem
The Stripe webhook isn't firing. We can't see any webhook logs in the server.

## Solution: Test Email Manually

You can test the email system RIGHT NOW without waiting for the webhook.

### Step 1: Find Your Advertiser ID

Look at your server logs from when you submitted the form. You should see:
```
✅ Payment pending advertiser created: { id: 57, email: 'brandengreene03@gmail.com' }
```

In this case, the advertiser ID is **57**.

### Step 2: Trigger Email Manually

Open a new terminal and run:

```powershell
curl -X POST http://localhost:3001/trigger-advertiser-webhook `
  -H "Content-Type: application/json" `
  -d '{\"advertiserId\": 57}'
```

**Or using PowerShell:**
```powershell
Invoke-WebRequest -Uri "http://localhost:3001/trigger-advertiser-webhook" `
  -Method POST `
  -Headers @{"Content-Type"="application/json"} `
  -Body (@{advertiserId=57} | ConvertTo-Json)
```

### Step 3: Check Results

You should see in your server logs:
```
🧪 ===== MANUAL WEBHOOK TRIGGER FOR ADVERTISER EMAIL =====
📝 Looking up advertiser ID: 57
📝 Found advertiser: { id: 57, email: '...', application_status: '...' }
📧 Campaign summary: { ad_format: 'video', ... }
🔍 DEBUG: Email service is configured, proceeding to send email
📧 Sending advertiser confirmation email to: brandengreene03@gmail.com
✅ Advertiser confirmation email sent successfully
```

---

## Why the Webhook Isn't Working

Looking at your logs, you created the checkout session but **there's no indication you completed the payment**. 

In Stripe test mode, the webhook fires when:
1. Customer submits payment form
2. Payment succeeds
3. Subscription is created

If you just see the checkout page and close it, the webhook won't fire.

### To Fix the Webhook:

1. Make sure Stripe CLI is running (it looks like it is)
2. Actually **complete the payment** in the browser
3. Check the Stripe CLI terminal - you should see events being forwarded
4. Then check your server logs for webhook messages

---

## Quick Test Checklist

- [ ] Find your advertiser ID from server logs (look for "Payment pending advertiser created")
- [ ] Use the manual trigger endpoint with that ID
- [ ] Check email inbox
- [ ] If that works, the issue is with webhook delivery, not email sending

