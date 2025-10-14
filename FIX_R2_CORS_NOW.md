# Fix R2 CORS - Step by Step (5 Minutes)

## 🎯 What You Need to Do

Your R2 bucket needs CORS configured so browsers can load videos from it.

---

## 📋 Step-by-Step Fix

### Step 1: Open Cloudflare Dashboard
1. Go to: https://dash.cloudflare.com
2. Log in with your Cloudflare account

### Step 2: Navigate to R2
1. Click **R2** in the left sidebar
2. You should see your buckets listed

### Step 3: Select Your Video Bucket
1. Click on: **charity-stream-videos**
2. Go to the **Settings** tab

### Step 4: Add CORS Policy
1. Find **CORS Policy** section
2. Click **Add CORS Policy** or **Edit**
3. Paste this configuration:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3001",
      "http://localhost:8081",
      "https://charitystream.vercel.app"
    ],
    "AllowedMethods": [
      "GET",
      "HEAD"
    ],
    "AllowedHeaders": [
      "*"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

4. Click **Save**

### Step 5: Verify Public Access
1. Still in Settings
2. Find **Public Access** section
3. Make sure it's **Enabled**
4. Note the public URL: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev`

### Step 6: Test It
1. Open new browser tab
2. Go to: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4`
3. Video should play or download

### Step 7: Test Your Website
1. Refresh your website (Ctrl+Shift+R)
2. Open console (F12)
3. Click play on video
4. Video should load and play!

---

## ✅ Success Checklist

- [ ] Logged into Cloudflare Dashboard
- [ ] Found R2 section
- [ ] Opened charity-stream-videos bucket
- [ ] Added CORS policy (copied from above)
- [ ] Saved CORS policy
- [ ] Verified Public Access is enabled
- [ ] Tested direct R2 URL - video plays
- [ ] Tested website - video plays
- [ ] No CORS errors in console

---

## 🚨 If You Don't Have Access to Cloudflare

### Alternative: Ask Admin to Configure CORS

Send this to your Cloudflare admin:

```
Subject: Need CORS Configuration for R2 Bucket

Hi,

Please add CORS policy to the "charity-stream-videos" R2 bucket:

Bucket: charity-stream-videos
CORS Policy:
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]

Also verify Public Access is enabled.

Thanks!
```

---

## 🔄 Alternative Quick Fix (No Cloudflare Access Needed)

If you can't access Cloudflare right now, temporarily serve videos from your backend:

### Add to `charitystream/backend/server.js` (after line 220):

```javascript
// Temporary: Proxy videos from R2 to avoid CORS
app.get('/videos/:videoName', async (req, res) => {
  try {
    const videoName = req.params.videoName;
    const R2_URL = `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${videoName}`;
    
    const response = await fetch(R2_URL);
    if (!response.ok) {
      return res.status(404).send('Video not found');
    }
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    response.body.pipe(res);
  } catch (error) {
    console.error('Video proxy error:', error);
    res.status(500).send('Error loading video');
  }
});
```

### Update `charitystream/public/index.html` `getVideoUrl()`:

```javascript
function getVideoUrl(videoName) {
  // Use backend proxy (temporary)
  return `/videos/${videoName}.mp4`;
}
```

**Restart backend, refresh browser, videos should work!**

⚠️ **Note**: This is temporary. Configure CORS properly for production.

---

## 🎉 That's It!

**Time**: 5 minutes  
**Difficulty**: Easy  
**Result**: Videos work!

Once CORS is configured, your videos will load from R2 CDN properly! 🚀

---

## 📞 Still Having Issues?

Run the diagnostic:
```bash
# In browser console:
fetch('https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4')
  .then(r => console.log('Status:', r.status, 'CORS:', r.headers.get('access-control-allow-origin')))
  .catch(e => console.error('Error:', e));
```

**Expected**: `Status: 200 CORS: http://localhost:3001`

If you see this, CORS is working!

---

**Priority**: 🔴 CRITICAL  
**Impact**: Videos won't play without this  
**Solution Time**: 5 minutes

