# Quick Test Guide - Dynamic Playlist Fix

## 🧪 Test in 3 Minutes

### Step 1: Check Console Logs (30 seconds)
```bash
# Start server
cd charitystream/backend
npm start

# Open website in browser: http://localhost:3001
# Open browser console (F12)
# Look for these logs:
```

**Expected Output**:
```
🔄 Fetching dynamic playlist from backend...
✅ Dynamic playlist loaded from R2: ['video_1', 'video_2', 'video_3', 'video_4', 'video_5']
✅ Video URLs mapped: {video_1: 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4', ...}
✅ Playlist loaded, starting first video
```

✅ **PASS**: You see these logs  
❌ **FAIL**: You see errors or no logs

---

### Step 2: Verify R2 URLs (30 seconds)
In browser console, type:
```javascript
console.log(playlist);
console.log(videoUrls);
```

**Expected Output**:
```javascript
// playlist
['video_1', 'video_2', 'video_3', 'video_4', 'video_5']

// videoUrls
{
  video_1: 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4',
  video_2: 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_2.mp4',
  video_3: 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_3.mp4',
  video_4: 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_4.mp4',
  video_5: 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_5.mp4'
}
```

✅ **PASS**: URLs are R2 public URLs (pub-83596556bc864db7aa93479e13f45deb.r2.dev)  
❌ **FAIL**: URLs are local paths (videos/video_1.mp4)

---

### Step 3: Test Video Playback (1 minute)
1. Click play on the video player
2. Let first video play to completion
3. Watch it automatically switch to next video

**Expected Behavior**:
- Videos play from R2 (check Network tab - requests to pub-83596556bc864db7aa93479e13f45deb.r2.dev)
- Automatic transition to next video when one ends
- Loop back to first video after last one

✅ **PASS**: Videos play smoothly from R2  
❌ **FAIL**: Videos don't play or show errors

---

### Step 4: Test Dynamic Discovery (1 minute)
Check backend logs for this line:
```
✅ Dynamically serving playlist: 5 videos from R2 bucket
   Videos: video_1.mp4, video_2.mp4, video_3.mp4, video_4.mp4, video_5.mp4
```

✅ **PASS**: Backend is scanning R2 bucket dynamically  
❌ **FAIL**: Backend is using hardcoded playlist

---

## 🎯 Quick Win Test: Add New Video

### The Ultimate Test (Optional - 2 minutes)
This proves the system is truly dynamic:

1. **Upload a new video** to R2 bucket `charity-stream-videos`:
   - Name it: `video_6.mp4`
   - Or use any `video_X.mp4` pattern

2. **Refresh the website** (no code changes!)

3. **Check console**:
   ```
   ✅ Dynamic playlist loaded from R2: ['video_1', 'video_2', 'video_3', 'video_4', 'video_5', 'video_6']
   ```

4. **Wait for videos to loop** - `video_6` will now play!

✅ **PASS**: New video appears without code changes  
❌ **FAIL**: New video doesn't appear

---

## 🚨 Troubleshooting

### Issue: "Failed to load dynamic playlist"
**Fix**: Check backend server is running on port 3001

### Issue: Videos show local paths instead of R2 URLs
**Fix**: Clear browser cache and hard refresh (Ctrl+Shift+R)

### Issue: Videos don't play
**Fix**: Check R2 bucket is publicly accessible

### Issue: Console shows empty playlist
**Fix**: Verify R2 bucket has video_X.mp4 files

---

## ✅ All Tests Pass = Fix Successful!

If all 4 steps pass, your system is now:
- ✅ Dynamically discovering videos from R2
- ✅ Using R2 public URLs directly
- ✅ Ready for automatic advertiser video integration
- ✅ Scalable to unlimited videos

**No more manual playlist updates needed!** 🎉

---

**Time to Complete**: ~3 minutes  
**Difficulty**: Easy  
**Required**: Browser console + Backend running

