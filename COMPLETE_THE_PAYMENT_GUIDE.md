# Complete the Stripe Payment to Trigger Email

## What's Working ✅
- Email system is fully configured
- Email sending works (test confirmed!)
- Webhook endpoint is ready to receive events

## What's NOT Happening ❌
- No webhook events are being received from Stripe
- This means the payment flow isn't completing

## The Issue

When you fill out the advertiser form, you see:
```
✅ Checkout session created: cs_test_a1We7x...
🔗 Checkout URL: https://checkout.stripe.com/...
```

This creates the checkout session, but **you need to actually complete the payment in the browser** for the webhook to fire.

## How to Complete the Payment

### Step 1: Submit the Advertiser Form
You already did this - saw the checkout session created.

### Step 2: Click the Checkout Button
In your browser, you should be redirected to Stripe checkout, or you need to click a button that takes you there.

### Step 3: Use Stripe Test Card
In the Stripe checkout page:

**Card Number:** `4242 4242 4242 4242`  
**Expiry:** Any future date (e.g., 12/34)  
**CVC:** Any 3 digits (e.g., 123)  
**ZIP:** Any 5 digits (e.g., 12345)  

### Step 4: Click "Pay" or "Subscribe"
Complete the payment. This is when Stripe will fire the webhook.

### Step 5: Watch Your Server Logs
You should now see:
```
🔔🔔🔔 ANY REQUEST TO /api/webhook
🔔 ===== WEBHOOK RECEIVED =====
✅ ===== SUBSCRIPTION CREATED =====
📝 Processing advertiser subscription creation...
📧 Sending advertiser confirmation email...
✅ Advertiser confirmation email sent successfully
```

---

## Alternative: Trigger Webhook Manually

If you want to test without completing payment, you can trigger the webhook manually:

### In Your Stripe CLI Terminal
Run this command:
```
stripe trigger customer.subscription.created
```

This will:
1. Create a fake subscription event
2. Forward it to your webhook endpoint
3. Trigger the email sending

### What You'll See

**In Stripe CLI:**
```
Setting up fixture for: customer.subscription.created
Trigger succeeded! Check the Dashboard: https://dashboard.stripe.com/test/events
```

**In Server Logs:**
```
🔔🔔🔔 ANY REQUEST TO /api/webhook
🔔 ===== WEBHOOK RECEIVED =====
✅ ===== SUBSCRIPTION CREATED =====
```

---

## Check If Payment Was Completed

Look in your server logs. Do you see these after clicking through the Stripe checkout?

- If you see `🔔🔔🔔 ANY REQUEST TO /api/webhook` → Webhook is being received! ✅
- If you DON'T see that → Payment wasn't completed or webhook not configured

---

## Why This Matters

The full flow is:
1. Form submission → Creates advertiser record
2. Stripe checkout → Shows payment form
3. **User completes payment** ← YOU ARE HERE
4. Stripe fires webhook → `customer.subscription.created`
5. Server receives webhook → Updates advertiser status
6. **Email is sent** ← This is what you want!

Without step 3 (completing payment), steps 4-6 don't happen.

---

## Quick Test

Right now, since the test email worked, I can verify the webhook will work:

**Run this to manually trigger:**
```powershell
# In Stripe CLI terminal:
stripe trigger customer.subscription.created
```

**Then check your server logs** - you should see the webhook messages and email being sent!

