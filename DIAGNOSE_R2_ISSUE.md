# Quick R2 Diagnostic - Find The Problem

## 🔍 Run These Tests (2 Minutes)

### Test 1: Can You Access R2 Directly?

**Open this URL in a new browser tab**:
```
https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4
```

**Results**:

✅ **Video plays or downloads** → R2 is accessible, CORS is the issue  
❌ **404 Not Found** → Videos don't exist in R2 bucket  
❌ **403 Forbidden** → R2 bucket isn't public  
❌ **Access Denied** → R2 bucket permissions issue  

---

### Test 2: Check CORS Headers

**Open browser console (F12) and run**:
```javascript
fetch('https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4', {
  method: 'HEAD'
})
.then(response => {
  console.log('Status:', response.status);
  console.log('CORS Header:', response.headers.get('access-control-allow-origin'));
  if (response.status === 200) {
    console.log('✅ R2 is accessible!');
    if (response.headers.get('access-control-allow-origin')) {
      console.log('✅ CORS is configured!');
    } else {
      console.log('❌ CORS NOT configured - This is your problem!');
    }
  } else {
    console.log('❌ R2 Error - Status:', response.status);
  }
})
.catch(error => {
  console.error('❌ Cannot reach R2:', error.message);
});
```

**Expected Output (Working)**:
```
Status: 200
CORS Header: http://localhost:3001
✅ R2 is accessible!
✅ CORS is configured!
```

**Expected Output (Broken)**:
```
Status: 200
CORS Header: null
✅ R2 is accessible!
❌ CORS NOT configured - This is your problem!
```

---

### Test 3: Check Backend Playlist API

**Run in console**:
```javascript
fetch('/api/videos/playlist')
  .then(r => r.json())
  .then(data => {
    console.log('Playlist:', data.videos);
    console.log('First video URL:', data.videos[0]?.videoUrl);
  });
```

**Expected Output**:
```
Playlist: [{videoId: 1, title: 'video_1', videoUrl: 'https://...', ...}, ...]
First video URL: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4
```

---

## 🎯 DIAGNOSIS RESULTS

### Scenario A: Test 1 Works, Test 2 Shows No CORS
**Problem**: R2 bucket needs CORS configuration  
**Solution**: Configure CORS in Cloudflare R2 Dashboard  
**See**: `R2_CORS_CONFIGURATION_REQUIRED.md`

### Scenario B: Test 1 Shows 404
**Problem**: Videos don't exist in R2 bucket  
**Solution**: Upload videos to R2 bucket  
**Files Needed**: `video_1.mp4`, `video_2.mp4`, `video_3.mp4`, `video_4.mp4`, `video_5.mp4`

### Scenario C: Test 1 Shows 403
**Problem**: R2 bucket isn't public  
**Solution**: Enable public access in Cloudflare R2 Dashboard

### Scenario D: Test 1 Works, Test 2 Shows CORS
**Problem**: Something else (rare)  
**Solution**: Check browser console for other errors

---

## 🔧 MOST LIKELY FIX

### 90% of cases: CORS Not Configured

**Go to**:
1. Cloudflare Dashboard → R2
2. Select bucket: `charity-stream-videos`
3. Settings → CORS Policy
4. Add this:

```json
[
  {
    "AllowedOrigins": ["http://localhost:3001", "*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

**Save and test again!**

---

## ⚡ TEMPORARY FIX (While You Configure CORS)

If you need videos working NOW while fixing CORS:

### Use Local Videos Temporarily

Create `charitystream/backend/public/videos/` folder and put videos there.

Then update `getVideoUrl()` in `index.html`:

```javascript
function getVideoUrl(videoName) {
  // Temporary: Use local videos
  return `/videos/${videoName}.mp4`;
}
```

Restart backend, videos will work locally while you fix R2 CORS.

---

## 📞 QUICK HELP

**Test 1 Result**: ________________  
**Test 2 Result**: ________________  
**Test 3 Result**: ________________  

Based on results, your issue is: **__________**

---

**Most Common Issue**: CORS not configured on R2 bucket  
**Fix Time**: 5 minutes in Cloudflare dashboard  
**See Full Guide**: `R2_CORS_CONFIGURATION_REQUIRED.md`

