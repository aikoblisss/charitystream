# 🔄 Desktop Detection Flow Diagram

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        DESKTOP APP (Electron)                        │
│                                                                       │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │ CharityStreamPlayer.tsx                                      │   │
│  │                                                              │   │
│  │  • Generates deviceFingerprint (UUID)                       │   │
│  │  • Sends heartbeat IMMEDIATELY on startup                   │   │
│  │  • Continues heartbeat every 15 SECONDS                     │   │
│  │  • Sends inactive signal on close                           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                              │                                        │
│                              │ POST /api/tracking/desktop-active     │
│                              │ { fingerprint, timestamp }            │
│                              │ Every 15 seconds                      │
└──────────────────────────────┼────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        BACKEND SERVER (Node.js)                      │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Rate Limiter (express-rate-limit)                            │  │
│  │                                                               │  │
│  │  ❌ SKIP these paths (exempted from rate limiting):          │  │
│  │     • /api/tracking/desktop-active                           │  │
│  │     • /api/tracking/desktop-inactive                         │  │
│  │     • /api/tracking/desktop-active-status                    │  │
│  │     • /api/tracking/session-status                           │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Endpoint: POST /api/tracking/desktop-active                  │  │
│  │                                                               │  │
│  │  INSERT INTO desktop_active_sessions (fingerprint, heartbeat)│  │
│  │  ON CONFLICT UPDATE heartbeat = NOW()                        │  │
│  │                                                               │  │
│  │  TTL: 30 seconds (cleaned if no heartbeat)                   │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Endpoint: POST /api/tracking/desktop-active-status           │  │
│  │                                                               │  │
│  │  SELECT FROM desktop_active_sessions                         │  │
│  │  WHERE fingerprint = ? AND heartbeat > NOW() - 10s           │  │
│  │                                                               │  │
│  │  Returns: { isDesktopActive: true/false }                    │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Endpoint: GET /api/tracking/session-status (Fallback)        │  │
│  │                                                               │  │
│  │  SELECT FROM watch_sessions                                  │  │
│  │  WHERE user_id = ? AND device_type = 'desktop_app'           │  │
│  │  AND end_time IS NULL                                        │  │
│  │                                                               │  │
│  │  Returns: { hasDesktopSession: true/false }                  │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
└───────────────────────────────┬───────────────────────────────────────┘
                                │
                                │ Polling every 5 seconds
                                │ (Two detection methods)
                                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        WEBSITE (Browser)                             │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ index.html - Conflict Detection System                       │  │
│  │                                                               │  │
│  │  1. startAggressiveConflictMonitoring()                      │  │
│  │     • Runs IMMEDIATELY on page load                          │  │
│  │     • Checks EVERY 5 SECONDS                                 │  │
│  │     • Runs ALWAYS (even when video paused)                   │  │
│  │                                                               │  │
│  │  2. checkForDesktopApp() - Hybrid Detection                  │  │
│  │     ┌─────────────────────────────────────────────────────┐ │  │
│  │     │ METHOD 1: Device Fingerprint (Primary)              │ │  │
│  │     │  POST /api/tracking/desktop-active-status           │ │  │
│  │     │  • Fast, no auth required                           │ │  │
│  │     │  • Checks fingerprint match                         │ │  │
│  │     └─────────────────────────────────────────────────────┘ │  │
│  │     ┌─────────────────────────────────────────────────────┐ │  │
│  │     │ METHOD 2: Session-based (Fallback)                  │ │  │
│  │     │  GET /api/tracking/session-status                   │ │  │
│  │     │  • Requires authentication                          │ │  │
│  │     │  • Checks database sessions                         │ │  │
│  │     └─────────────────────────────────────────────────────┘ │  │
│  │                                                               │  │
│  │  3. Response to Desktop Detection:                           │  │
│  │     if (isDesktopActive) {                                   │  │
│  │       • player.pause() ⏸️                                     │  │
│  │       • showConflictToast() 🚨                               │  │
│  │       • completeWatchSession() 📊                            │  │
│  │     }                                                         │  │
│  │                                                               │  │
│  │  4. Fail-Safe Mode:                                          │  │
│  │     catch (error) {                                          │  │
│  │       return true; // Assume desktop active, block website  │  │
│  │     }                                                         │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Play Event Handler - Immediate Block                         │  │
│  │                                                               │  │
│  │  player.on('play', async () => {                             │  │
│  │    const isDesktopActive = await checkForDesktopApp();       │  │
│  │    if (isDesktopActive) {                                    │  │
│  │      player.pause(); // BLOCK IMMEDIATELY                    │  │
│  │      showConflictToast();                                    │  │
│  │      return; // Don't start session                          │  │
│  │    }                                                          │  │
│  │  });                                                          │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ Session Start - 409 Conflict Handling                        │  │
│  │                                                               │  │
│  │  if (response.status === 409) {                              │  │
│  │    player.pause();                                           │  │
│  │    showSessionConflictMessage(); // ✅ NOW IMPLEMENTED       │  │
│  │    startSessionConflictMonitoring(); // ✅ NOW IMPLEMENTED   │  │
│  │    return null;                                              │  │
│  │  }                                                            │  │
│  └──────────────────────────────────────────────────────────────┘  │
│                                                                       │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Typical Flow Scenarios

### Scenario A: Desktop App Opens While Website Playing

```
Time  Desktop App              Backend                    Website
─────────────────────────────────────────────────────────────────────
0s    [App Opens]              
      → Send heartbeat         INSERT fingerprint         
                              last_heartbeat = NOW()     

5s                                                        → Check status
                              ← isDesktopActive: true
                                                          🚫 PAUSE VIDEO
                                                          📢 Show toast
                                                          📊 Complete session

10s   → Send heartbeat         UPDATE last_heartbeat     

15s   → Send heartbeat         UPDATE last_heartbeat     

20s                                                       → Check status
                              ← isDesktopActive: true
                                                          ⏸️ Still paused
```

### Scenario B: Website Tries to Play While Desktop Active

```
Time  Desktop App              Backend                    Website
─────────────────────────────────────────────────────────────────────
0s    [Already Running]       
      Heartbeat active         fingerprint exists         

1s                                                        User clicks Play
                                                          → Check status
                              ← isDesktopActive: true
                                                          🚫 BLOCK PLAY
                                                          📢 Show toast
                                                          ❌ No session start
```

### Scenario C: Desktop App Closes, Website Recovers

```
Time  Desktop App              Backend                    Website
─────────────────────────────────────────────────────────────────────
0s    [App Closes]            
      → Send inactive          DELETE fingerprint         

5s                                                        → Check status
                              ← isDesktopActive: false
                                                          ✅ Allow playback

10s                                                       User clicks Play
                                                          → Start session
                              ← 200 OK, sessionId: 123
                                                          ▶️ VIDEO PLAYS
```

---

## 🎯 Key Protection Layers

### Layer 1: Heartbeat System (Desktop App)
- ✅ 15-second intervals (faster than 30s backend expiry)
- ✅ Immediate heartbeat on startup
- ✅ Proper cleanup on app close

### Layer 2: Fingerprint Detection (Primary)
- ✅ Fast, no auth required
- ✅ Checked every 5 seconds
- ✅ 10-second cache to prevent spam

### Layer 3: Session Detection (Fallback)
- ✅ Checks database for active desktop sessions
- ✅ Works even if fingerprint fails
- ✅ User-specific (requires auth)

### Layer 4: Play Event Block
- ✅ Immediate check before allowing playback
- ✅ Blocks play button click
- ✅ Shows conflict toast

### Layer 5: Session Start Block (409)
- ✅ Backend refuses to create session
- ✅ Website handles 409 gracefully
- ✅ Pauses video, shows message

### Layer 6: Fail-Safe Mode
- ✅ On API error → assume desktop active
- ✅ On timeout → assume desktop active
- ✅ Safety first: Block website when unsure

---

## 📊 Timing Breakdown

| Event | Timing | Notes |
|-------|--------|-------|
| Desktop heartbeat | Every 15s | Must be < 30s (backend TTL) |
| Website check interval | Every 5s | Always running |
| Detection cache | 10s | Prevents duplicate API calls |
| Backend TTL cleanup | 30s | Removes stale fingerprints |
| API timeout | 3s | Prevents hanging requests |
| Toast display | 8s | Auto-dismisses |
| Session expiry check | 60s | Fallback method window |

---

## 🚫 What Happens on Conflict

```
┌────────────────────────────────────────────────────────────┐
│                     CONFLICT DETECTED                       │
└────────────────────────────────────────────────────────────┘
                            │
            ┌───────────────┼───────────────┐
            │               │               │
            ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │ Pause Video │ │ Show Toast  │ │  Complete   │
    │             │ │             │ │   Session   │
    │ player.     │ │ "Desktop    │ │             │
    │ pause()     │ │  App        │ │ Track:      │
    │             │ │  Detected"  │ │ • Duration  │
    │             │ │             │ │ • Ad views  │
    └─────────────┘ └─────────────┘ └─────────────┘
            │               │               │
            └───────────────┼───────────────┘
                            │
                            ▼
                ┌───────────────────────┐
                │   Keep Monitoring     │
                │   (Every 5 seconds)   │
                │                       │
                │   Wait for desktop    │
                │   app to close...     │
                └───────────────────────┘
```

---

## ✅ All Protection Mechanisms Active

- [x] Desktop heartbeat (15s)
- [x] Device fingerprint detection
- [x] Session-based fallback detection
- [x] Play event blocking
- [x] Session start 409 handling
- [x] Aggressive monitoring (5s)
- [x] Fail-safe error handling
- [x] Rate limit exemptions
- [x] Missing functions implemented
- [x] Video pause at all conflict points

**Result: Desktop app ALWAYS takes precedence** 🎯

