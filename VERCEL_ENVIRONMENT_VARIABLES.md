# Vercel Environment Variables Configuration

## Required Environment Variables for Production

You need to set these environment variables in your Vercel dashboard:

### 1. Database Configuration
```
DATABASE_URL=postgresql://username:password@host:port/database
```
- **Source**: Your Neon PostgreSQL database connection string
- **Format**: `postgresql://user:password@ep-cool-name-123456.us-east-1.aws.neon.tech/neondb?sslmode=require`

### 2. JWT Secret
```
JWT_SECRET=your-super-secret-jwt-key-change-in-production-12345
```
- **Important**: Use a long, random string (32+ characters)
- **Security**: Never use the default value in production

### 3. Google OAuth Configuration
```
GOOGLE_CLIENT_ID=your-google-client-id-here
GOOGLE_CLIENT_SECRET=your-google-client-secret-here
GOOGLE_CALLBACK_URL=https://charitystream.vercel.app/api/auth/google/callback
```

### 4. Stripe Configuration (if using payments)
```
STRIPE_SECRET_KEY=sk_live_your_stripe_secret_key
STRIPE_PUBLISHABLE_KEY=pk_live_your_stripe_publishable_key
STRIPE_PRICE_ID=price_your_stripe_price_id
STRIPE_WEBHOOK_SECRET=whsec_your_webhook_secret
```

### 5. Email Configuration (optional)
```
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_USER=your-email@gmail.com
EMAIL_PASS=your-app-password
```

### 6. Frontend URL
```
FRONTEND_URL=https://charitystream.vercel.app
```

### 7. Node Environment
```
NODE_ENV=production
```

## How to Set Environment Variables in Vercel

1. Go to your Vercel dashboard
2. Select your project
3. Go to "Settings" → "Environment Variables"
4. Add each variable with:
   - **Name**: The variable name (e.g., `DATABASE_URL`)
   - **Value**: The variable value
   - **Environment**: Select "Production", "Preview", and/or "Development"

## Google Cloud Console Configuration

You need to add these redirect URIs to your Google OAuth app:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Select your project
3. Go to "APIs & Services" → "Credentials"
4. Edit your OAuth 2.0 Client ID
5. Add these authorized redirect URIs:
   - `https://charitystream.vercel.app/api/auth/google/callback`
   - `https://charitystream.vercel.app/auth/google/callback`
   - `http://localhost:3001/api/auth/google/callback` (for local development)
   - `http://localhost:8081/auth/google/callback` (for Electron app)

## Stripe Configuration

If you're using Stripe payments:

1. Go to your [Stripe Dashboard](https://dashboard.stripe.com/)
2. Get your live API keys (not test keys)
3. Set up webhooks pointing to: `https://charitystream.vercel.app/api/stripe/webhook`

## Database Setup

Your Neon PostgreSQL database should already be configured with the required tables. The server will automatically create missing tables on startup.

## Testing Your Deployment

After setting all environment variables:

1. Deploy to Vercel
2. Test the main functionality:
   - User registration/login
   - Google OAuth
   - Video playback
   - Database operations
   - Static file serving (videos, PDFs)

## Common Issues

### CORS Errors
- Make sure your domain is in the CORS origins list in `server.js`
- Check that `FRONTEND_URL` is set correctly

### Database Connection Issues
- Verify your `DATABASE_URL` is correct
- Check that your Neon database allows connections from Vercel

### Google OAuth Issues
- Ensure redirect URIs are added to Google Cloud Console
- Check that `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct

### Static Files Not Loading
- Verify that your `vercel.json` routing is correct
- Check that files are in the `public/` directory
