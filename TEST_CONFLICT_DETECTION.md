# 🧪 Conflict Detection Testing Guide

## Quick Test Checklist

### ✅ Pre-Test Setup

1. **Backend Running:**
   ```bash
   cd charitystream/backend
   node server.js
   ```
   - Look for: `✅ Database connected`
   - Look for: `Server running on port 3001`

2. **Website Open:**
   - Navigate to: `http://localhost:3001` (or your domain)
   - Login with valid credentials
   - Open browser console (F12)

3. **Desktop App Ready:**
   - Build/run the desktop app
   - Keep it closed initially

---

## 🎯 Test 1: Desktop Opens While Website Playing

**Objective:** Verify website pauses when desktop app opens

### Steps:
1. ✅ Open website, login
2. ✅ Click play on video
3. ✅ Wait for video to start playing (should see playback)
4. ✅ Open desktop app
5. ✅ Wait 5-10 seconds

### Expected Results:
- [ ] Website video **pauses automatically** within 5 seconds
- [ ] Toast notification appears: "Desktop App Detected"
- [ ] Console shows: `🚫 Desktop app detected - taking action`
- [ ] Console shows: `🚫 PAUSE VIDEO`

### Console Messages to Look For (Website):
```
🚨 Starting AGGRESSIVE conflict monitoring (5s intervals, always active)
🎬 Video play event - immediate conflict check
▶️ Video started playing
[... 5 seconds later ...]
🚫 Desktop app detected - taking action
⏸️ Video paused due to desktop conflict
📺 Session completed successfully
```

### Console Messages to Look For (Desktop App):
```
✅ Fetched playlist: 5 videos
💓 Desktop heartbeat sent
📺 Desktop session started: 123
▶️ Video playing: [video title]
```

### Backend Logs to Look For:
```
🔍 Desktop status check for fingerprint xxx: ACTIVE
⚠️ Desktop app detected for this user - blocking website session
```

---

## 🎯 Test 2: Website Blocked When Desktop Already Active

**Objective:** Verify website can't play while desktop is active

### Steps:
1. ✅ Open desktop app first
2. ✅ Wait 5 seconds (let heartbeat register)
3. ✅ Open website, login
4. ✅ Try to click play on video

### Expected Results:
- [ ] Video **does not play** (blocked immediately)
- [ ] Toast notification appears immediately
- [ ] Console shows: `🚫 Desktop app active - blocking playback immediately`
- [ ] No session starts (no session ID in console)

### Console Messages (Website):
```
🚨 Starting AGGRESSIVE conflict monitoring (5s intervals, always active)
User clicks play...
🎬 Video play event - immediate conflict check
🚫 Desktop app active - blocking playback immediately
🚫 Session conflict - showing conflict message
```

### What Should NOT Happen:
- ❌ Video should NOT start playing
- ❌ Should NOT see: "📺 Session started"
- ❌ Should NOT see: "▶️ Video started playing"

---

## 🎯 Test 3: No Rate Limiting (429 Errors)

**Objective:** Verify no 429 errors during normal operation

### Steps:
1. ✅ Desktop app running
2. ✅ Website open and checking status
3. ✅ Let it run for 2 minutes
4. ✅ Watch console for errors

### Expected Results:
- [ ] **Zero** 429 errors in console
- [ ] Detection continues smoothly every 5 seconds
- [ ] Backend logs show no rate limit warnings

### Console Should Show (Every 5s):
```
🔍 Checking desktop status...
🚫 Desktop app detected - taking action
[Repeats every 5 seconds with no errors]
```

### Console Should NOT Show:
- ❌ `⚠️ Rate limit exceeded`
- ❌ `429 Too Many Requests`
- ❌ `Error: HTTP 429`

---

## 🎯 Test 4: Recovery When Desktop Closes

**Objective:** Verify website can play again after desktop closes

### Steps:
1. ✅ Desktop app running (website blocked)
2. ✅ Close desktop app **completely**
3. ✅ Wait 30-40 seconds (for heartbeat to expire)
4. ✅ Try to play video on website

### Expected Results:
- [ ] After ~30 seconds, website detects desktop is inactive
- [ ] Video plays normally on website
- [ ] Console shows: `✅ No desktop conflict detected`
- [ ] Session starts successfully

### Console Messages (Website):
```
🚫 Desktop app detected - taking action
[Desktop app closes]
[30 seconds pass...]
🔍 Checking desktop status...
✅ No desktop conflict detected
User clicks play...
📺 Watch session started: 456
▶️ Video started playing
```

### Backend Logs:
```
🔍 Desktop status check for fingerprint xxx: ACTIVE
[Desktop closes]
💤 Desktop app deactivated for fingerprint: xxx
[30 seconds pass, TTL cleanup runs]
🔍 Desktop status check for fingerprint xxx: INACTIVE
```

---

## 🎯 Test 5: 409 Conflict Response

**Objective:** Verify proper handling of 409 session conflicts

### Steps:
1. ✅ Desktop app running
2. ✅ Website open
3. ✅ Try to play video (triggers session start)
4. ✅ Watch for 409 error handling

### Expected Results:
- [ ] Backend returns 409 status
- [ ] Website handles it gracefully (no crash)
- [ ] `showSessionConflictMessage()` is called
- [ ] Video pauses immediately
- [ ] No JavaScript errors in console

### Console Messages (Website):
```
🎬 Video play event - starting session...
POST /api/tracking/start-session → 409 Conflict
🚫 Session conflict detected: Desktop app is active
🚫 Session conflict - showing conflict message
⏸️ Video paused
```

### What Should NOT Happen:
- ❌ `Uncaught ReferenceError: showSessionConflictMessage is not defined`
- ❌ `Uncaught ReferenceError: startSessionConflictMonitoring is not defined`
- ❌ JavaScript errors or crashes

---

## 🎯 Test 6: Fail-Safe Mode

**Objective:** Verify system blocks website on API errors

### Steps:
1. ✅ Website running, video playing
2. ✅ Stop the backend server (simulate API failure)
3. ✅ Wait for next detection check (5 seconds)

### Expected Results:
- [ ] API calls timeout/fail
- [ ] Website **assumes conflict exists** (fail-safe)
- [ ] Video pauses as a safety precaution
- [ ] Console shows: "Detection check failed, failing safe"

### Console Messages:
```
🔍 Checking desktop status...
❌ API timeout or error
Detection check failed, failing safe
🚫 Desktop app detected - taking action (fail-safe mode)
⏸️ Video paused
```

---

## 🎯 Test 7: Multiple Rapid Switches

**Objective:** Verify system handles rapid desktop/website switching

### Steps:
1. ✅ Open website, start video
2. ✅ Open desktop app (website pauses)
3. ✅ Close desktop app
4. ✅ Wait 30s, play on website
5. ✅ Open desktop app again (website pauses)
6. ✅ Repeat 2-3 times

### Expected Results:
- [ ] Each time desktop opens → website pauses within 5s
- [ ] Each time desktop closes → website can play after 30s
- [ ] No errors or crashes
- [ ] No rate limiting issues
- [ ] Clean state transitions

---

## 📊 Success Criteria Summary

All tests should pass with these outcomes:

| Test | Key Metric | Target | Pass/Fail |
|------|-----------|--------|-----------|
| Test 1 | Detection time | < 5 seconds | ⬜ |
| Test 2 | Immediate block | < 1 second | ⬜ |
| Test 3 | 429 errors | 0 errors | ⬜ |
| Test 4 | Recovery time | ~30 seconds | ⬜ |
| Test 5 | 409 handling | No JS errors | ⬜ |
| Test 6 | Fail-safe | Blocks website | ⬜ |
| Test 7 | Rapid switching | No crashes | ⬜ |

---

## 🐛 Troubleshooting

### Problem: Website doesn't pause when desktop opens

**Check:**
- [ ] Desktop app sending heartbeats? (Look for `💓 Desktop heartbeat sent`)
- [ ] Website monitoring active? (Look for `🚨 Starting AGGRESSIVE conflict monitoring`)
- [ ] Backend receiving heartbeats? (Check backend logs)
- [ ] Fingerprint matching? (Same device fingerprint on both)

**Debug:**
```javascript
// In browser console:
localStorage.getItem('deviceFingerprint')
// Should return a UUID

// Check if monitoring is running:
console.log(conflictMonitoringInterval)
// Should NOT be null
```

### Problem: 429 errors appearing

**Check:**
- [ ] Rate limiter exemptions in place? (Check server.js)
- [ ] Correct path matching? (Paths must match exactly)
- [ ] Multiple tabs open? (Each tab will check independently)

**Debug:**
```javascript
// In backend server.js, add logging:
skip: (req) => {
  console.log('Rate limiter checking:', req.path);
  // Should show exempted paths being skipped
}
```

### Problem: Functions undefined errors

**Check:**
- [ ] `showSessionConflictMessage` defined?
- [ ] `startSessionConflictMonitoring` defined?
- [ ] Functions defined before being called?

**Debug:**
```javascript
// In browser console:
typeof showSessionConflictMessage
// Should return "function", not "undefined"

typeof startSessionConflictMonitoring
// Should return "function", not "undefined"
```

### Problem: Desktop app not detected

**Check:**
- [ ] Desktop app using correct API URL? (Check `getApiUrl()`)
- [ ] Desktop app heartbeat interval correct? (Should be 15s)
- [ ] Backend database connected? (Check for connection errors)

**Debug:**
```javascript
// In desktop app console:
// Should see every 15 seconds:
💓 Desktop heartbeat sent

// In backend logs:
// Should see:
INSERT INTO desktop_active_sessions...
```

---

## 📝 Test Report Template

After running all tests, fill out this report:

```markdown
## Test Results - [Date]

### Environment:
- Backend: [URL]
- Website: [URL]
- Desktop App: [Version]

### Test Results:
- [ ] Test 1: Desktop Opens While Playing - PASS/FAIL
- [ ] Test 2: Website Blocked When Desktop Active - PASS/FAIL
- [ ] Test 3: No Rate Limiting - PASS/FAIL
- [ ] Test 4: Recovery After Desktop Closes - PASS/FAIL
- [ ] Test 5: 409 Conflict Response - PASS/FAIL
- [ ] Test 6: Fail-Safe Mode - PASS/FAIL
- [ ] Test 7: Multiple Rapid Switches - PASS/FAIL

### Issues Found:
[List any problems]

### Notes:
[Any observations]

### Status:
✅ READY FOR PRODUCTION
⚠️ NEEDS FIXES
❌ CRITICAL ISSUES
```

---

## 🚀 Quick Smoke Test (30 seconds)

Don't have time for full tests? Run this quick check:

1. Open website, login
2. Start playing video
3. Open desktop app
4. **Expected:** Website pauses within 5 seconds ✅

If this works, 80% of the system is functioning correctly!

---

## 🎉 All Tests Passing?

**Congratulations!** Your conflict detection system is working perfectly.

**Next steps:**
1. Deploy to production
2. Monitor logs for first 24 hours
3. Verify no user reports of issues

**System is production-ready!** 🚀

