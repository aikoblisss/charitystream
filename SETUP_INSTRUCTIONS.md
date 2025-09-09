# LetsWatchAds Google OAuth Setup Instructions

## Prerequisites
- Node.js installed
- Gmail account with 2FA enabled
- Google Cloud Console access

## Step 1: Google OAuth Setup

### 1.1 Create Google Cloud Project
1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click "Select a project" → "New Project"
3. Name: "LetsWatchAds"
4. Click "Create"

### 1.2 Enable Google+ API
1. In the left sidebar, go to "APIs & Services" → "Library"
2. Search for "Google+ API"
3. Click on it and press "Enable"

### 1.3 Create OAuth Credentials
1. Go to "APIs & Services" → "Credentials"
2. Click "Create Credentials" → "OAuth client ID"
3. If prompted, configure OAuth consent screen:
   - User Type: External
   - App name: "LetsWatchAds"
   - User support email: Your email
   - Developer contact: Your email
   - Add scopes: `../auth/userinfo.email`, `../auth/userinfo.profile`
4. Application type: "Web application"
5. Name: "LetsWatchAds Web Client"
6. Authorized redirect URIs: `http://localhost:3001/api/auth/google/callback`
7. Click "Create"
8. **Copy the Client ID and Client Secret** - you'll need these!

## Step 2: Email Configuration

### 2.1 Enable 2FA on Gmail
1. Go to [Google Account Security](https://myaccount.google.com/security)
2. Enable "2-Step Verification" if not already enabled

### 2.2 Generate App Password
1. In Google Account Security, click "App passwords"
2. Select "Mail" → "Other (Custom name)"
3. Enter "LetsWatchAds Backend"
4. Click "Generate"
5. **Copy the 16-character password** (format: `abcd efgh ijkl mnop`)

## Step 3: Configure Application

### 3.1 Update Configuration File
Edit `backend/config.js` and replace the placeholder values:

```javascript
module.exports = {
  google: {
    clientId: 'YOUR_ACTUAL_CLIENT_ID_HERE',
    clientSecret: 'YOUR_ACTUAL_CLIENT_SECRET_HERE',
    callbackUrl: 'http://localhost:3001/api/auth/google/callback'
  },
  email: {
    host: 'smtp.gmail.com',
    port: 587,
    user: 'your-actual-email@gmail.com',
    pass: 'your-actual-16-char-app-password'
  },
  // ... rest of config
};
```

### 3.2 Test Email Configuration
1. Update the email credentials in `backend/test-email.js`
2. Run: `node test-email.js`
3. Check your inbox for the test email

## Step 4: Test the Complete Flow

### 4.1 Start the Server
```bash
cd backend
npm start
```

### 4.2 Test Google OAuth
1. Open http://localhost:3001/auth.html
2. Click "Continue with Google"
3. Complete Google OAuth flow
4. Check your email for verification link
5. Click the verification link
6. You should be redirected back and logged in

### 4.3 Verify Everything Works
- ✅ Google OAuth login works
- ✅ Verification email is sent
- ✅ Email verification link works
- ✅ User is logged in after verification
- ✅ Video player is accessible

## Troubleshooting

### Common Issues:

**"Invalid client" error:**
- Double-check Client ID and Secret
- Ensure redirect URI matches exactly

**"Email sending failed":**
- Verify 2FA is enabled
- Check app password is correct (16 characters)
- Ensure Gmail address is correct

**"Verification link doesn't work":**
- Check that the frontend URL in config matches your server
- Verify the token in the URL is not corrupted

**"Database errors":**
- Make sure SQLite database file exists
- Check file permissions

## Production Deployment

For production, you'll need to:
1. Update redirect URIs to your production domain
2. Set up proper environment variables
3. Use HTTPS (required for production OAuth)
4. Update frontend URL in config
5. Set up a proper email service (SendGrid, etc.)

## Security Notes

- Never commit your `config.js` file to version control
- Use environment variables in production
- Rotate your JWT secret regularly
- Enable HTTPS in production
- Consider rate limiting for OAuth endpoints

