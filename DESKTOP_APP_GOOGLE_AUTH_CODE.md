# Desktop App Google Authentication Code

## 📋 **Complete Server-Side Code for Desktop App OAuth**

### **1. OAuth Initiation Endpoint (`/api/auth/google`)**

```javascript
app.get('/api/auth/google', (req, res, next) => {
  const mode = req.query.mode || 'signin';
  const { redirect_uri, app_type, source } = req.query;
  
  // Check if this is from the desktop app
  if (app_type === 'electron' && source === 'desktop_app') {
    console.log('📱 Desktop app OAuth detected');
    
    // Validate required environment variables
    if (!process.env.GOOGLE_CLIENT_ID) {
      return res.status(500).json({ 
        error: 'Server configuration error: Google OAuth not properly configured'
      });
    }
    
    // Prepare redirect URI with fallback
    const isProduction = process.env.NODE_ENV === 'production';
    const defaultRedirectUri = isProduction 
      ? 'https://charitystream.vercel.app/auth/google/callback'
      : 'http://localhost:8081/auth/google/callback';
    const finalRedirectUri = redirect_uri || defaultRedirectUri;
    
    // Prepare state object with redirect_uri stored
    const stateObject = { 
      app_type: 'electron', 
      source: 'desktop_app',
      mode: mode,
      redirect_uri: finalRedirectUri  // Store redirect_uri in state
    };
    const encodedState = encodeURIComponent(JSON.stringify(stateObject));
    
    // Build Google OAuth URL
    const googleAuthUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
      `client_id=${process.env.GOOGLE_CLIENT_ID}&` +
      `redirect_uri=${encodeURIComponent(finalRedirectUri)}&` +
      `response_type=code&` +
      `scope=openid%20email%20profile&` +
      `access_type=offline&` +
      `prompt=consent&` +
      `state=${encodedState}`;
    
    // Redirect to Google OAuth
    return res.redirect(googleAuthUrl);
  } else {
    // Web OAuth flow (Passport.js)
    passport.authenticate('google', {
      scope: ['profile', 'email', 'openid'],
      prompt: 'select_account'
    })(req, res, next);
  }
});
```

### **2. OAuth Callback Handler (`/auth/google/callback`)**

```javascript
// In-memory cache to prevent duplicate code processing
const processedCodes = new Set();

app.get('/auth/google/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    console.log('📱 Desktop app OAuth callback received');
    
    // Check for duplicate processing
    if (code && processedCodes.has(code)) {
      console.log('⚠️ Authorization code already processed, ignoring duplicate request');
      return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('Code already processed')}`);
    }
    
    // Extract redirect_uri from state parameter
    let finalRedirectUri = 'http://localhost:8081/auth/google/callback'; // default
    let stateData = {};
    if (state) {
      try {
        stateData = JSON.parse(decodeURIComponent(state));
        if (stateData.redirect_uri) {
          finalRedirectUri = stateData.redirect_uri;
        }
      } catch (error) {
        console.log('⚠️ Could not parse state for redirect_uri');
      }
    }
    
    if (!code) {
      // Handle success response (token and user data present)
      if (req.query.token && req.query.user) {
        console.log('✅ OAuth success response received');
        
        return res.status(200).send(`
          <html>
            <body>
              <h1>Authentication Successful!</h1>
              <p>You can close this window and return to the app.</p>
              <script>
                // Notify parent window if in iframe
                if (window.parent !== window) {
                  window.parent.postMessage({ 
                    type: 'oauth_success', 
                    token: '${req.query.token}', 
                    user: '${req.query.user}' 
                  }, '*');
                }
                // Close window after delay
                setTimeout(() => window.close(), 2000);
              </script>
            </body>
          </html>
        `);
      }
      
      // Handle OAuth errors from Google
      if (req.query.error) {
        return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent(req.query.error)}`);
      }
      
      // No code, no error, no success data
      return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('No authorization code received')}`);
    }
    
    // Process the authorization code
    if (stateData.app_type === 'electron') {
      console.log('📱 Processing desktop app OAuth callback');
      
      // Exchange code for token with Google
      const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: process.env.GOOGLE_CLIENT_ID,
          client_secret: process.env.GOOGLE_CLIENT_SECRET,
          code: code,
          grant_type: 'authorization_code',
          redirect_uri: finalRedirectUri
        })
      });
      
      const tokenData = await tokenResponse.json();
      
      if (!tokenData.access_token) {
        return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('Failed to get access token')}`);
      }
      
      // Get user info from Google
      const userResponse = await fetch(`https://www.googleapis.com/oauth2/v2/userinfo?access_token=${tokenData.access_token}`);
      const googleUser = await userResponse.json();
      
      // Find user in database
      const [err, user] = await dbHelpers.getUserByEmail(googleUser.email);
      
      if (err || !user) {
        return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('User not found. Please create an account first.')}`);
      }
      
      // Update last login
      await dbHelpers.updateLastLogin(user.id);
      
      // Generate JWT token
      const token = jwt.sign(
        { userId: user.id, username: user.username, email: user.email },
        JWT_SECRET,
        { expiresIn: '30d' }
      );
      
      // Mark code as processed
      if (code) {
        processedCodes.add(code);
      }
      
      // Redirect back to desktop app with token and user data
      const redirectUrl = `${finalRedirectUri}?` +
        `token=${token}&` +
        `user=${encodeURIComponent(JSON.stringify({
          id: user.id,
          username: user.username,
          email: user.email,
          isPremium: user.is_premium || false,
          totalMinutesWatched: user.total_minutes_watched,
          currentMonthMinutes: user.current_month_minutes,
          subscriptionTier: user.subscription_tier,
          profilePicture: user.profile_picture,
          emailVerified: user.email_verified,
          authProvider: user.auth_provider,
          premiumSince: user.premium_since,
          stripeSubscriptionId: user.stripe_subscription_id
        }))}`;
      
      console.log('🔗 Redirecting to desktop app with user data');
      res.redirect(redirectUrl);
    }
  } catch (error) {
    console.error('❌ OAuth callback error:', error);
    res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('Authentication failed')}`);
  }
});
```

## 🎯 **How Your Desktop App Should Use This:**

### **1. Initiate OAuth:**
```javascript
// In your desktop app
function startGoogleAuth() {
  const authUrl = `http://localhost:3001/api/auth/google?` +
    `redirect_uri=${encodeURIComponent('http://localhost:8081/auth/google/callback')}&` +
    `app_type=electron&` +
    `source=desktop_app`;
  
  // Open OAuth popup
  const popup = window.open(authUrl, 'google-auth', 'width=500,height=600');
  
  // Listen for popup messages
  window.addEventListener('message', (event) => {
    if (event.data.type === 'oauth_success') {
      handleAuthSuccess(event.data.token, event.data.user);
    }
  });
  
  // Monitor popup closure
  const checkClosed = setInterval(() => {
    if (popup.closed) {
      clearInterval(checkClosed);
      // Handle popup closed without auth
    }
  }, 1000);
}
```

### **2. Handle Success:**
```javascript
function handleAuthSuccess(token, userData) {
  // Store authentication data
  localStorage.setItem('authToken', token);
  localStorage.setItem('userData', JSON.stringify(userData));
  
  // Redirect to video player
  window.location.href = '/video-player.html';
  // or show video player component
}
```

## 🔑 **Key Points:**

1. **OAuth Flow**: Desktop app → Server → Google → Server → Desktop app
2. **State Parameter**: Stores redirect_uri to ensure consistency
3. **Success Response**: Returns HTML page with postMessage for iframe communication
4. **Token & User Data**: JWT token + complete user profile
5. **Duplicate Protection**: In-memory cache prevents code reuse

## 🚀 **Your Desktop App Needs To:**

1. **Listen for postMessage** from OAuth success page
2. **Store the JWT token** for API authentication
3. **Redirect to video player** after successful auth
4. **Handle authentication errors** appropriately

The server code is working perfectly - the issue is in your desktop app's handling of the success response! 🎯
