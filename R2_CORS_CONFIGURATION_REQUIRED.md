# R2 CORS Configuration Required - CRITICAL FIX

**Date**: October 13, 2025  
**Issue**: Videos won't load from R2 bucket  
**Error**: `MEDIA_ERR_SRC_NOT_SUPPORTED (CODE:4)`  
**Status**: ⚠️ R2 BUCKET CONFIGURATION NEEDED

---

## 🔍 PROBLEM IDENTIFIED

### Error Message:
```
VIDEOJS: ERROR: (CODE:4 MEDIA_ERR_SRC_NOT_SUPPORTED) 
The media could not be loaded, either because the server or network failed 
or because the format is not supported.
```

### What's Wrong:
Your videos are trying to load from R2, but the R2 bucket is either:
1. **Missing CORS configuration** (most likely)
2. **Not publicly accessible**
3. **Videos don't exist in the bucket**

---

## 🎯 SOLUTION: Configure R2 Bucket CORS

### Step 1: Check if Videos Exist in R2

**Test the R2 URL directly**:
```
Open in browser: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4
```

**Expected Results:**

✅ **If Video Plays/Downloads**: R2 is accessible, CORS is the issue  
❌ **If 404 Error**: Videos don't exist in R2  
❌ **If 403 Forbidden**: R2 bucket isn't public  
❌ **If CORS Error**: R2 needs CORS configuration  

---

## 🔧 FIX 1: Configure CORS on R2 Bucket (REQUIRED)

### Access Cloudflare Dashboard:
1. Go to https://dash.cloudflare.com
2. Navigate to R2
3. Select bucket: `charity-stream-videos`
4. Go to Settings → CORS Policy

### Add This CORS Configuration:

```json
[
  {
    "AllowedOrigins": [
      "http://localhost:3001",
      "http://localhost:8081",
      "https://charitystream.vercel.app",
      "https://charitystream.com",
      "https://www.charitystream.com"
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

**Repeat for**: `advertiser-media` bucket (if used)

---

## 🔧 FIX 2: Make R2 Bucket Public (If Not Already)

### In Cloudflare R2 Dashboard:
1. Select bucket: `charity-stream-videos`
2. Go to Settings
3. Enable: **Public Access**
4. Note the public URL: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev`

---

## 🔧 FIX 3: Verify Videos Exist in R2

### Check Bucket Contents:
1. In R2 Dashboard, open `charity-stream-videos`
2. Verify these files exist:
   - `video_1.mp4`
   - `video_2.mp4`
   - `video_3.mp4`
   - `video_4.mp4`
   - `video_5.mp4`

### If Videos Don't Exist:
Upload them to the R2 bucket:

```bash
# Using Wrangler CLI:
wrangler r2 object put charity-stream-videos/video_1.mp4 --file=./path/to/video_1.mp4

# Or use Cloudflare Dashboard upload
```

---

## 🧪 TESTING AFTER CORS CONFIGURATION

### Test 1: Direct R2 Access
```
Open in browser: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4
```
**Expected**: Video plays or downloads

### Test 2: Check CORS Headers
```bash
# Using curl:
curl -I https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4

# Look for these headers:
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, HEAD
```

### Test 3: Website Video Player
1. Refresh website (Ctrl+Shift+R)
2. Open console (F12)
3. Look for:
   ```
   ✅ Dynamic playlist loaded from R2
   ✅ Video loading started
   ```
4. Video should play!

---

## 🚨 ALTERNATIVE SOLUTION: Proxy Through Backend

If you can't configure CORS on R2, proxy videos through your backend:

### Add Video Proxy Endpoint to server.js:

```javascript
// Add this to server.js:

// Video proxy endpoint to avoid CORS issues
app.get('/api/proxy-video/:videoName', async (req, res) => {
  try {
    const { videoName } = req.params;
    const R2_BUCKET_URL = 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev';
    const videoUrl = `${R2_BUCKET_URL}/${videoName}`;
    
    // Fetch video from R2
    const response = await fetch(videoUrl);
    
    if (!response.ok) {
      return res.status(404).json({ error: 'Video not found' });
    }
    
    // Set proper headers
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Pipe video stream to response
    response.body.pipe(res);
    
  } catch (error) {
    console.error('❌ Error proxying video:', error);
    res.status(500).json({ error: 'Failed to load video' });
  }
});
```

### Update Frontend to Use Proxy:

In `index.html`, update `getVideoUrl()`:

```javascript
function getVideoUrl(videoName) {
  // Use backend proxy instead of direct R2 URL
  return `/api/proxy-video/${videoName}.mp4`;
}
```

**Pros**: No CORS issues  
**Cons**: Backend bandwidth usage increases

---

## 🎯 RECOMMENDED APPROACH

**Best Solution**: Configure CORS on R2 bucket (Fix 1)
- ✅ Direct CDN delivery
- ✅ Better performance
- ✅ Lower backend load
- ✅ Scalable

**Backup Solution**: Proxy through backend (Alternative)
- ✅ Works immediately
- ❌ Backend bandwidth usage
- ❌ Potential bottleneck

---

## 📝 DETAILED CORS POLICY EXPLANATION

### What This CORS Policy Does:

```json
{
  "AllowedOrigins": [
    "http://localhost:3001",           // Local development
    "http://localhost:8081",           // Electron app
    "https://charitystream.vercel.app", // Production
    "https://charitystream.com",       // Custom domain
    "https://www.charitystream.com"    // Custom domain (www)
  ],
```
**Allows**: Requests from your websites/apps only

```json
  "AllowedMethods": [
    "GET",      // Download video
    "HEAD"      // Check video exists
  ],
```
**Allows**: Read-only operations (secure)

```json
  "AllowedHeaders": ["*"],
```
**Allows**: All request headers (needed for range requests)

```json
  "ExposeHeaders": ["ETag"],
```
**Exposes**: ETag header for caching

```json
  "MaxAgeSeconds": 3600
```
**Caches**: CORS preflight for 1 hour (reduces requests)

---

## 🔐 SECURITY CONSIDERATIONS

### Is This CORS Policy Safe?
✅ **YES** - It's properly restrictive:

1. **Limited Origins**: Only your domains allowed
2. **Read-Only**: Only GET/HEAD methods (no uploads)
3. **No Wildcards**: Specific origins (not `*`)
4. **HTTPS Enforced**: Production uses HTTPS

### What's Still Protected:
❌ No file uploads via browser  
❌ No file deletion via browser  
❌ No unauthorized access  
❌ Only specified origins allowed  

---

## 🎯 TROUBLESHOOTING CHECKLIST

### Videos Still Won't Load?

- [ ] R2 bucket has CORS policy configured
- [ ] R2 bucket is set to public access
- [ ] Videos exist in R2 bucket with correct names
- [ ] Video files are valid MP4 format
- [ ] Backend server restarted
- [ ] Browser cache cleared (Ctrl+Shift+R)
- [ ] No console errors about CSP
- [ ] Direct R2 URL works in browser

---

## 📊 QUICK DIAGNOSIS

### Run This in Browser Console:

```javascript
// Test if R2 is accessible
fetch('https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4', {
  method: 'HEAD'
})
.then(response => {
  console.log('✅ R2 Response:', response.status);
  console.log('CORS headers:', response.headers.get('access-control-allow-origin'));
})
.catch(error => {
  console.error('❌ R2 Error:', error);
});
```

**Expected Output**:
```
✅ R2 Response: 200
CORS headers: http://localhost:3001
```

**If You See**:
- `❌ NetworkError` → CORS is blocking
- `❌ 404` → Video doesn't exist
- `❌ 403` → Bucket not public
- `✅ 200` but no CORS headers → CORS not configured

---

## 🚀 DEPLOYMENT CHECKLIST

Before going live:

1. **R2 CORS Configuration**:
   - [ ] CORS policy added to charity-stream-videos bucket
   - [ ] CORS policy added to advertiser-media bucket
   - [ ] AllowedOrigins includes production domain

2. **R2 Public Access**:
   - [ ] Both buckets set to public
   - [ ] Public URLs working

3. **Videos**:
   - [ ] All videos uploaded to R2
   - [ ] Filenames follow video_X.mp4 pattern
   - [ ] Videos are valid MP4 format

4. **Testing**:
   - [ ] Direct R2 URLs work
   - [ ] Videos play on website
   - [ ] No CORS errors in console
   - [ ] Video transitions work

---

## 📚 ADDITIONAL RESOURCES

### Cloudflare R2 CORS Documentation:
https://developers.cloudflare.com/r2/buckets/cors/

### Wrangler CLI for R2:
```bash
# Install Wrangler
npm install -g wrangler

# Configure CORS via CLI
wrangler r2 bucket cors put charity-stream-videos --cors-policy=cors.json
```

### Example cors.json:
```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

---

## 🎉 SUCCESS INDICATORS

You know it's working when:

- ✅ No CORS errors in console
- ✅ Videos load and play
- ✅ Direct R2 URLs work in browser
- ✅ Console shows "Dynamic playlist loaded from R2"
- ✅ Video transitions work smoothly
- ✅ No 404 or 403 errors

---

## 💡 SUMMARY

**Problem**: Videos won't load from R2  
**Root Cause**: R2 bucket needs CORS configuration  
**Solution**: Add CORS policy to R2 bucket in Cloudflare dashboard  
**Alternative**: Proxy videos through backend  
**Time to Fix**: 5 minutes  

**Configure CORS on R2 and your videos will play!** 🚀

---

**Last Updated**: October 13, 2025  
**Priority**: 🔴 CRITICAL  
**Difficulty**: Easy (just needs R2 config)

