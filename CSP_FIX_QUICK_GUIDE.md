# CSP Fix - Quick Guide (1 Minute)

## ⚡ Problem
Videos won't load, console shows:
```
Refused to load media from 'https://pub-83596...r2.dev/video_1.mp4'
because it violates the following Content Security Policy directive
```

## ✅ Solution (Already Applied)

The fix has been applied to `server.js` line 208-214.

## 🔧 What You Need to Do

### Step 1: Restart Backend (Required!)
```bash
# Stop current backend (Ctrl+C)
cd charitystream/backend
npm start
```

**⚠️ CRITICAL**: CSP changes only take effect after server restart!

### Step 2: Hard Refresh Browser
```bash
# Windows/Linux: Ctrl + Shift + R
# Mac: Cmd + Shift + R
```

### Step 3: Verify It Works
Open browser console (F12) and look for:

**✅ SUCCESS** (What you should see):
```
✅ Dynamic playlist loaded from R2: ['video_1', 'video_2', ...]
✅ Video URLs mapped: {...}
✅ Video loading started
```

**❌ STILL BROKEN** (If you see this):
```
❌ Refused to load media from 'https://pub-8359...'
```

**Fix**: Make sure you restarted the backend!

### Step 4: Play Video
Click play - video should load and play normally.

---

## 🎯 That's It!

**Total Time**: 1 minute  
**Steps**: Restart backend → Refresh browser → Test

---

## 🔍 What Was Changed

**File**: `charitystream/backend/server.js`  
**Line**: 208-214

**Before**:
```javascript
mediaSrc: ["'self'", "data:", "blob:"],
```

**After**:
```javascript
mediaSrc: [
  "'self'", 
  "data:", 
  "blob:",
  "https://pub-83596556bc864db7aa93479e13f45deb.r2.dev", // R2 bucket
  "https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev"  // R2 bucket
],
```

---

## 🚨 Troubleshooting

### Videos Still Won't Load?

**Check 1**: Did you restart the backend?
```bash
# You MUST restart - CSP is set at startup
npm start
```

**Check 2**: Did you hard refresh the browser?
```bash
# Ctrl+Shift+R or Cmd+Shift+R
```

**Check 3**: Check console for errors
```bash
# F12 → Console tab
# Look for CSP or video errors
```

**Check 4**: Verify R2 URLs in console
```javascript
// In console, type:
console.log(videoUrls);

// Should show:
{
  video_1: 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4',
  ...
}
```

**Check 5**: Test R2 URL directly
```bash
# Open in new tab:
https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4

# Should: Play the video or download it
```

---

## ✅ Success Indicators

You know it's working when:
- ✅ No CSP errors in console
- ✅ Videos load and play
- ✅ Console shows "Dynamic playlist loaded from R2"
- ✅ Video transitions work
- ✅ No red errors in console

---

## 📚 Need More Details?

See `CSP_R2_VIDEO_FIX.md` for complete documentation.

---

**Fix Applied**: ✅  
**Restart Required**: ⚠️ YES  
**Expected Result**: Videos play from R2

