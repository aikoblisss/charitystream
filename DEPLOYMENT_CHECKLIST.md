# Vercel Deployment Checklist

## Pre-Deployment Checklist

### ✅ Code Changes Made
- [x] Updated CORS origins to include `https://charitystream.vercel.app`
- [x] Fixed Google OAuth redirect URIs for production environment
- [x] Updated vercel.json with proper routing for all pages
- [x] Added PDF file serving routes
- [x] Made all URLs environment-aware (localhost for dev, production for prod)

### 📋 Required Environment Variables

Set these in your Vercel dashboard (Settings → Environment Variables):

#### Database
- [ ] `DATABASE_URL` - Your Neon PostgreSQL connection string
- [ ] `NODE_ENV=production`

#### Authentication
- [ ] `JWT_SECRET` - A secure random string (32+ characters)

#### Google OAuth
- [ ] `GOOGLE_CLIENT_ID` - Your Google OAuth client ID
- [ ] `GOOGLE_CLIENT_SECRET` - Your Google OAuth client secret
- [ ] `GOOGLE_CALLBACK_URL=https://charitystream.vercel.app/api/auth/google/callback`

#### Frontend URL
- [ ] `FRONTEND_URL=https://charitystream.vercel.app`

#### Stripe (if using payments)
- [ ] `STRIPE_SECRET_KEY` - Your Stripe secret key
- [ ] `STRIPE_PUBLISHABLE_KEY` - Your Stripe publishable key
- [ ] `STRIPE_PRICE_ID` - Your Stripe price ID
- [ ] `STRIPE_WEBHOOK_SECRET` - Your Stripe webhook secret

#### Email (optional)
- [ ] `EMAIL_HOST=smtp.gmail.com`
- [ ] `EMAIL_PORT=587`
- [ ] `EMAIL_USER` - Your Gmail address
- [ ] `EMAIL_PASS` - Your Gmail app password

## Google Cloud Console Configuration

### Required Redirect URIs
Add these to your Google OAuth app:

- [ ] `https://charitystream.vercel.app/api/auth/google/callback`
- [ ] `https://charitystream.vercel.app/auth/google/callback`
- [ ] `http://localhost:3001/api/auth/google/callback` (for local dev)
- [ ] `http://localhost:8081/auth/google/callback` (for Electron app)

## Deployment Steps

### 1. Deploy to Vercel
```bash
# If you haven't already
npm i -g vercel

# Login to Vercel
vercel login

# Deploy
vercel

# For production deployment
vercel --prod
```

### 2. Set Environment Variables
1. Go to Vercel dashboard
2. Select your project
3. Go to Settings → Environment Variables
4. Add all required variables (see list above)

### 3. Test Your Deployment

After deployment, test these features:

#### Core Functionality
- [ ] Homepage loads correctly
- [ ] User registration works
- [ ] User login works
- [ ] Google OAuth works
- [ ] Video player loads and plays videos

#### Static Files
- [ ] Videos load from `/videos/` directory
- [ ] PDFs open from `/Terms and Conditions/` directory
- [ ] CSS and JS files load correctly

#### API Endpoints
- [ ] `/api/auth/register` - User registration
- [ ] `/api/auth/login` - User login
- [ ] `/api/auth/me` - User profile
- [ ] `/api/tracking/*` - Ad tracking (if authenticated)

#### Page Routing
- [ ] `/` - Homepage
- [ ] `/about` - About page
- [ ] `/advertise` - Advertise page
- [ ] `/advertise/company` - Company advertiser page
- [ ] `/advertise/charity` - Charity page
- [ ] `/auth` - Authentication page
- [ ] `/subscribe` - Subscription page (if using Stripe)

## Common Issues & Solutions

### CORS Errors
**Problem**: Browser shows CORS errors
**Solution**: 
- Check that your domain is in the CORS origins list
- Verify `FRONTEND_URL` environment variable

### Database Connection Issues
**Problem**: Database connection fails
**Solution**:
- Verify `DATABASE_URL` is correct
- Check Neon database allows connections from Vercel
- Ensure SSL is enabled in connection string

### Google OAuth Issues
**Problem**: OAuth redirect fails
**Solution**:
- Add production redirect URIs to Google Cloud Console
- Check `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- Verify `GOOGLE_CALLBACK_URL` environment variable

### Static Files Not Loading
**Problem**: Videos, PDFs, or other files don't load
**Solution**:
- Check `vercel.json` routing configuration
- Verify files are in `public/` directory
- Check file paths in HTML are correct

### 404 Errors
**Problem**: Pages return 404
**Solution**:
- Check `vercel.json` routing rules
- Verify HTML files exist in `public/` directory
- Check URL patterns match routing rules

## Post-Deployment

### 1. Monitor Logs
Check Vercel function logs for any errors:
```bash
vercel logs
```

### 2. Test All Features
- User registration and login
- Google OAuth flow
- Video playback
- Database operations
- Static file serving

### 3. Performance Check
- Page load times
- API response times
- Database query performance

## Security Checklist

- [ ] JWT secret is secure and unique
- [ ] Database credentials are secure
- [ ] Google OAuth secrets are protected
- [ ] Stripe keys are production keys (not test keys)
- [ ] Environment variables are set in Vercel (not in code)
- [ ] HTTPS is enabled (automatic with Vercel)

## Backup Plan

If deployment fails:
1. Check environment variables
2. Review Vercel function logs
3. Test database connection
4. Verify all required files are in repository
5. Check Google OAuth configuration

## Support

If you encounter issues:
1. Check Vercel dashboard for deployment logs
2. Review browser console for client-side errors
3. Test individual API endpoints
4. Verify environment variables are set correctly
