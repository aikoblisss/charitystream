# Stripe Webhook Setup for Advertiser Emails

## The Problem
The webhook is not being called. In your server logs, you should see `🔔 ===== WEBHOOK RECEIVED =====` but you don't see it, which means Stripe isn't sending webhooks to your server.

## Solution: Run Stripe CLI

You need to install and run the Stripe CLI to forward webhook events to your local server.

### Step 1: Install Stripe CLI

**Windows (using scoop):**
```powershell
scoop install stripe
```

**Or download directly:**
https://stripe.com/docs/stripe-cli

**Or use Chocolatey:**
```powershell
choco install stripe
```

### Step 2: Login to Stripe CLI

```powershell
stripe login
```

This will open a browser window to authenticate with your Stripe account.

### Step 3: Forward Webhooks to Your Local Server

**In a NEW terminal window** (keep the server running in the first one):

```powershell
stripe listen --forward-to localhost:3001/api/webhook
```

This will output something like:
```
> Ready! Your webhook signing secret is whsec_xxxxx (^C to quit)
```

Copy the signing secret (starting with `whsec_`).

### Step 4: Add to Your .env File

Add this line to your `charitystream/backend/.env` file:

```env
STRIPE_WEBHOOK_SECRET=whsec_xxxxx
```

(Replace `whsec_xxxxx` with the actual secret from step 3)

### Step 5: Restart Your Server

Restart your server so it picks up the new environment variable.

### Step 6: Test the Full Flow

1. Fill out the advertiser form on http://localhost:3001/advertiser.html
2. Complete the Stripe checkout
3. You should see in your server logs:
   ```
   🔔 ===== WEBHOOK RECEIVED =====
   ✅ ===== SUBSCRIPTION CREATED =====
   📧 Sending advertiser confirmation email...
   ✅ Advertiser confirmation email sent successfully
   ```

---

## Alternative: Use Real Stripe Webhooks (Production)

If you want to use real webhooks without the CLI:

1. Deploy your app to production
2. Go to https://dashboard.stripe.com/test/webhooks
3. Click "Add endpoint"
4. Enter your webhook URL: `https://your-domain.com/api/webhook`
5. Select events: `customer.subscription.created`
6. Copy the signing secret
7. Add it to your production environment variables

---

## Testing the Email System

Once the webhook is set up, you can test the email sending:

### Manual Test (Works without webhook)
```powershell
curl -X POST http://localhost:3001/test-advertiser-email -H "Content-Type: application/json" -d '{\"email\":\"your-email@test.com\",\"companyName\":\"Test Company\"}'
```

### Full Flow Test
1. Make sure Stripe CLI is running
2. Fill out advertiser form
3. Complete payment
4. Check email inbox

---

## Troubleshooting

### Webhook Still Not Working?

Check these:

1. **Is Stripe CLI running?**
   - You should see `> Ready! Your webhook signing secret is whsec_xxxxx`

2. **Is STRIPE_WEBHOOK_SECRET set?**
   - Server logs should show: `🔔 Webhook secret configured: true`

3. **Are you using the test key?**
   - Make sure `STRIPE_SECRET_KEY` starts with `sk_test_`

4. **Check server logs:**
   - Look for `🔔🔔🔔 WEBHOOK ENDPOINT CALLED!`
   - If you don't see it, the webhook isn't reaching your server

### Need More Help?

1. Check if webhook is forwarding:
   ```powershell
   # In Stripe CLI terminal, you should see events being forwarded
   ```

2. Check Stripe dashboard:
   - Go to https://dashboard.stripe.com/test/events
   - Look for recent events

3. Test webhook manually:
   ```powershell
   stripe trigger customer.subscription.created
   ```
   You should see the webhook being processed in server logs.

---

## Quick Start Commands

```powershell
# Terminal 1: Start your server
npm start

# Terminal 2: Forward webhooks
stripe listen --forward-to localhost:3001/api/webhook

# Copy the signing secret and add to .env
# Then restart server
```

