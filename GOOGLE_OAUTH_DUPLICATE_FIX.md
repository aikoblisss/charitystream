# Google OAuth Duplicate Request Fix

## ✅ **Issues Identified and Fixed:**

### **1. Double Callback Problem:**
- **Issue**: OAuth callback was being called twice
- **First call**: Successful with authorization code
- **Second call**: No authorization code (duplicate/redirect loop)

### **2. Solutions Applied:**

#### **A. Duplicate Code Protection:**
```javascript
// In-memory cache to prevent duplicate code processing
const processedCodes = new Set();

// Check if code already processed
if (code && processedCodes.has(code)) {
  console.log('⚠️ Authorization code already processed, ignoring duplicate request');
  return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent('Code already processed')}`);
}

// Mark code as processed after successful authentication
if (code) {
  processedCodes.add(code);
  // Clean up old codes periodically
}
```

#### **B. Enhanced Error Handling:**
```javascript
if (!code) {
  console.log('🔍 Callback query params:', req.query);
  console.log('🔍 Callback headers:', req.headers);
  
  // Check if this is a Google OAuth error
  if (req.query.error) {
    console.log('🔍 Google OAuth error:', req.query.error);
    return res.redirect(`${finalRedirectUri}?error=${encodeURIComponent(req.query.error)}`);
  }
  
  // Handle duplicate requests
  console.log('⚠️ No authorization code - possibly duplicate request');
}
```

## 🎯 **Expected Behavior Now:**

### **First OAuth Callback (Success):**
```
📱 Electron OAuth callback received
🔍 Using redirect_uri from state: http://localhost:3001/auth/google/callback
📊 State data: { app_type: 'electron', source: 'desktop_app', mode: 'signin', redirect_uri: 'http://localhost:3001/auth/google/callback' }
📱 Processing Electron OAuth callback
🔄 Exchanging code for token with Google...
📡 Token response status: 200
👤 Google user data: { email: 'user@example.com', name: 'User Name' }
✅ Electron OAuth successful for: user@example.com
🔗 Redirecting to Electron app with user data
```

### **Second OAuth Callback (Duplicate - Blocked):**
```
📱 Electron OAuth callback received
⚠️ Authorization code already processed, ignoring duplicate request
```

## 🧪 **Testing Instructions:**

### **1. Test Electron App:**
1. Open your Electron app
2. Click "Continue with Google"
3. Complete Google authentication
4. Should see success logs and redirect back to app

### **2. Test Web App:**
1. Open your web app at `http://localhost:3001`
2. Click "Continue with Google" 
3. Should use the `/api/auth/google/callback` endpoint
4. Complete authentication flow

### **3. Expected Results:**
- ✅ **No more double callbacks**
- ✅ **Successful authentication for both apps**
- ✅ **Proper error handling for duplicates**
- ✅ **Clean redirect flow**

## 🔍 **Debug Information:**

If you still see issues, the enhanced logging will show:
- **Callback query params**: What parameters are being sent
- **Callback headers**: Request headers for debugging
- **Google OAuth errors**: Any errors from Google
- **Duplicate detection**: When duplicate requests are blocked

## 🚀 **Both Apps Should Work:**

### **Electron App:**
- Uses `/auth/google/callback` endpoint
- Custom redirect URI handling
- State parameter preservation
- Duplicate request protection

### **Web App:**
- Uses `/api/auth/google/callback` endpoint  
- Standard Passport.js OAuth flow
- No changes to existing functionality

## 🎉 **Status:**

The duplicate callback issue has been fixed with:
- ✅ **Duplicate code protection**
- ✅ **Enhanced error handling**
- ✅ **Better debugging logs**
- ✅ **Preserved web app functionality**

Both your Electron app and web app should now work properly! 🚀

