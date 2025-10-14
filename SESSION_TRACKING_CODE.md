# Complete Session Tracking & Desktop App Detection System

## Overview

This document contains ALL code related to:
- Session tracking (watch_sessions table)
- Desktop app detection (Electron app)
- Video player pausing when desktop app is detected
- Device fingerprinting
- Session conflict resolution

---

## Database Tables

### 1. `watch_sessions` Table
```sql
CREATE TABLE IF NOT EXISTS watch_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  video_name VARCHAR(255) NOT NULL,
  quality VARCHAR(50) NOT NULL,
  start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_time TIMESTAMP,
  duration_seconds INTEGER,
  completed BOOLEAN DEFAULT FALSE,
  paused_count INTEGER DEFAULT 0,
  user_ip VARCHAR(45),
  user_agent TEXT  -- Used to detect Electron app (contains "Electron")
)
```

### 2. `desktop_active_sessions` Table
```sql
CREATE TABLE IF NOT EXISTS desktop_active_sessions (
  fingerprint TEXT PRIMARY KEY,
  last_heartbeat TIMESTAMP NOT NULL
)
```

### 3. `ad_tracking` Table
```sql
CREATE TABLE IF NOT EXISTS ad_tracking (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  session_id INTEGER REFERENCES watch_sessions(id),
  ad_start_time TIMESTAMP NOT NULL,
  ad_end_time TIMESTAMP,
  duration_seconds INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)
```

---

## Backend API Endpoints

### 1. POST `/api/tracking/start-session`

**Purpose**: Start a new watch session, auto-close any previous sessions

**Key Logic**:
- Detects if request is from Electron app (user-agent contains "Electron")
- Blocks website if desktop app is active
- Auto-closes previous incomplete sessions
- Creates new session

```javascript
app.post('/api/tracking/start-session', authenticateToken, async (req, res) => {
  try {
    const { videoName, quality } = req.body;
    const userId = req.user.userId;
    const username = req.user.username;
    const userIP = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');

    console.log(`🔍 Checking for active sessions for user ${username} (ID: ${userId})`);
    
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Find any incomplete sessions for this user
    const activeSessionsResult = await pool.query(
      'SELECT id, video_name, start_time FROM watch_sessions WHERE user_id = $1 AND end_time IS NULL',
      [userId]
    );
    
    // Check for desktop app precedence - only treat as desktop app if user agent explicitly contains "Electron"
    const currentUserAgent = userAgent || '';
    const isDesktopApp = currentUserAgent.toLowerCase().includes('electron');
    
    if (activeSessionsResult.rows.length > 0) {
      // Check if there's an active desktop session - only sessions with "Electron" in user agent
      const desktopSessions = activeSessionsResult.rows.filter(session => 
        session.user_agent && session.user_agent.toLowerCase().includes('electron')
      );
      
      const hasDesktopSession = desktopSessions.length > 0;
      
      // Desktop app precedence rule
      if (hasDesktopSession && !isDesktopApp) {
        // Desktop session exists, but this is a web request - BLOCK IT
        console.log(`🚫 Blocking web session for ${username} - desktop session active`);
        return res.status(409).json({ 
          error: 'Multiple watch sessions detected',
          message: 'Desktop app is currently active. Please close the desktop app to watch on the website.',
          conflictType: 'desktop_active',
          hasActiveDesktopSession: true
        });
      }
      
      console.log(`⚠️ Found ${activeSessionsResult.rows.length} active session(s) for ${username}, closing them`);
      
      for (const session of activeSessionsResult.rows) {
        // Ensure duration is never negative (handles timezone issues)
        const duration = Math.max(0, Math.floor((Date.now() - new Date(session.start_time).getTime()) / 1000));
        console.log(`🔚 Auto-completing session ${session.id} (${session.video_name}) - ${duration}s`);
        
        // Complete the old session
        await pool.query(
          `UPDATE watch_sessions 
           SET end_time = CURRENT_TIMESTAMP, 
               duration_seconds = $2, 
               completed = false 
           WHERE id = $1`,
          [session.id, duration]
        );
        
        // Also close any active ad tracking for this session
        await pool.query(
          `UPDATE ad_tracking 
           SET ad_end_time = CURRENT_TIMESTAMP, 
               duration_seconds = $2,
               completed = false 
           WHERE session_id = $1 AND ad_end_time IS NULL`,
          [session.id, duration]
        );
      }
      
      console.log(`✅ All previous sessions closed for ${username}`);
    }
    
    // Now create the new session
    const sessionData = {
      userId: userId,
      videoName: videoName,
      quality: quality,
      userIP: userIP,
      userAgent: userAgent
    };

    const [err, sessionId] = await dbHelpers.createWatchSession(sessionData);
    if (err) {
      console.error('❌ Failed to create session:', err);
      return res.status(500).json({ error: 'Failed to start session' });
    }

    console.log(`✅ New session ${sessionId} started for ${username}`);
    res.json({
      sessionId: sessionId,
      message: 'Session started'
    });
  } catch (error) {
    console.error('❌ Error in start-session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

### 2. GET `/api/tracking/session-status`

**Purpose**: Check if user has active desktop sessions

**Console Output**: 
```
🔍 Session status for branden: {
  totalActiveSessions: 1,
  activeDesktopSessions: 0,
  userAgents: [ 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWeb' ]
}
```

```javascript
app.get('/api/tracking/session-status', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Find all active sessions (end_time IS NULL)
    const activeSessionsResult = await pool.query(
      `SELECT id, video_name, start_time, user_agent, user_ip
       FROM watch_sessions 
       WHERE user_id = $1 AND end_time IS NULL
       ORDER BY start_time DESC`,
      [userId]
    );
    
    // CRITICAL: Only flag as desktop if user_agent explicitly contains "Electron"
    // Regular browsers (Chrome, Firefox, Safari) will NOT match this
    const activeDesktopSessions = activeSessionsResult.rows.filter(session => 
      session.user_agent && session.user_agent.toLowerCase().includes('electron')
    );
    
    const hasActiveDesktopSession = activeDesktopSessions.length > 0;
    
    console.log(`🔍 Session status for ${username}:`, {
      totalActiveSessions: activeSessionsResult.rows.length,
      activeDesktopSessions: activeDesktopSessions.length,
      userAgents: activeSessionsResult.rows.map(s => s.user_agent?.substring(0, 50))
    });
    
    res.json({
      hasActiveSession: activeSessionsResult.rows.length > 0,
      sessionCount: activeSessionsResult.rows.length,
      hasDesktopSession: hasActiveDesktopSession,
      hasWebSession: activeSessionsResult.rows.length > activeDesktopSessions.length,
      desktopSessionCount: activeDesktopSessions.length,
      webSessionCount: activeSessionsResult.rows.length - activeDesktopSessions.length,
      conflictDetected: hasActiveDesktopSession,
      message: hasActiveDesktopSession ? 'Desktop app detected' : 'No desktop app detected'
    });
    
  } catch (error) {
    console.error('❌ Error checking session status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

### 3. POST `/api/tracking/cleanup-desktop-sessions`

**Purpose**: Manually cleanup old Electron app sessions

```javascript
app.post('/api/tracking/cleanup-desktop-sessions', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    console.log(`🧹 Cleaning up old Electron app sessions for ${username}`);
    
    // ONLY close sessions that have "Electron" in the user agent
    const result = await pool.query(
      `UPDATE watch_sessions 
       SET end_time = CURRENT_TIMESTAMP, 
           duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - start_time))::INTEGER),
           completed = false
       WHERE user_id = $1 
       AND user_agent ILIKE '%electron%'
       AND end_time IS NULL
       RETURNING id, video_name, duration_seconds, user_agent`,
      [userId]
    );
    
    console.log(`✅ Cleaned up ${result.rowCount} Electron app sessions`);
    if (result.rowCount > 0) {
      console.log('Closed sessions:', result.rows.map(r => ({
        id: r.id,
        video: r.video_name,
        userAgent: r.user_agent?.substring(0, 50)
      })));
    }
    
    res.json({
      success: true,
      cleanedSessions: result.rowCount,
      message: `Cleaned up ${result.rowCount} Electron app sessions`
    });
    
  } catch (error) {
    console.error('❌ Error cleaning up sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

### 4. Device Fingerprint Endpoints

#### POST `/api/tracking/desktop-active`
**Purpose**: Desktop app sends heartbeat every few seconds

```javascript
app.post('/api/tracking/desktop-active', async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) {
      return res.status(400).json({ error: 'Missing fingerprint' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    await pool.query(`
      INSERT INTO desktop_active_sessions (fingerprint, last_heartbeat)
      VALUES ($1, NOW())
      ON CONFLICT (fingerprint) DO UPDATE SET last_heartbeat = NOW()
    `, [fingerprint]);

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error in desktop-active:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

#### POST `/api/tracking/desktop-inactive`
**Purpose**: Desktop app calls this on shutdown

```javascript
app.post('/api/tracking/desktop-inactive', async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) {
      return res.status(400).json({ error: 'Missing fingerprint' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    await pool.query(`DELETE FROM desktop_active_sessions WHERE fingerprint = $1`, [fingerprint]);
    
    console.log(`🔚 Desktop app deactivated for fingerprint: ${fingerprint}`);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error in desktop-inactive:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

#### POST `/api/tracking/desktop-active-status`
**Purpose**: Website checks if desktop app is active on this device

**Console Output**:
```
🔍 Desktop status check for fingerprint f651017d-feec-4a85-bafb-09b56db9834f: INACTIVE
```

```javascript
app.post('/api/tracking/desktop-active-status', async (req, res) => {
  try {
    const { fingerprint } = req.body;
    if (!fingerprint) {
      return res.status(400).json({ error: 'Missing fingerprint' });
    }

    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }

    // Clean up old desktop sessions (> 30 seconds old) before checking
    await pool.query(`
      DELETE FROM desktop_active_sessions 
      WHERE last_heartbeat < NOW() - INTERVAL '30 seconds'
    `);

    const result = await pool.query(`
      SELECT 1 FROM desktop_active_sessions
      WHERE fingerprint = $1 AND last_heartbeat > NOW() - INTERVAL '10 seconds'
    `, [fingerprint]);

    const isDesktopActive = result.rowCount > 0;
    
    console.log(`🔍 Desktop status check for fingerprint ${fingerprint}: ${isDesktopActive ? 'ACTIVE' : 'INACTIVE'}`);
    
    res.json({ isDesktopActive });
  } catch (error) {
    console.error('❌ Error in desktop-active-status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

### 5. Rate Limiting Middleware

```javascript
// Track request counts per user
const requestCounts = new Map();
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const MAX_REQUESTS = 100; // Max requests per minute

// Rate limiting middleware for tracking endpoints
function trackingRateLimit(req, res, next) {
  const userId = req.user?.userId;
  if (!userId) return next();
  
  const now = Date.now();
  const userRequests = requestCounts.get(userId) || { count: 0, resetTime: now + RATE_LIMIT_WINDOW };
  
  // Reset if window expired
  if (now > userRequests.resetTime) {
    userRequests.count = 0;
    userRequests.resetTime = now + RATE_LIMIT_WINDOW;
  }
  
  userRequests.count++;
  requestCounts.set(userId, userRequests);
  
  if (userRequests.count > MAX_REQUESTS) {
    return res.status(429).json({ 
      error: 'Too many requests', 
      message: 'Please slow down your requests',
      retryAfter: Math.ceil((userRequests.resetTime - now) / 1000)
    });
  }
  
  next();
}
```

---

## Frontend Code (public/index.html)

### 1. Device Fingerprint Generation

```javascript
// Generate and persist device fingerprint for desktop detection
if (!localStorage.getItem('deviceFingerprint')) {
  const fingerprint = crypto.randomUUID();
  localStorage.setItem('deviceFingerprint', fingerprint);
  console.log('🔑 Generated device fingerprint:', fingerprint);
}
```

### 2. Check for Session Conflicts Function (IMPROVED VERSION)

**Key Changes**:
- ✅ NO automatic cleanup of active desktop sessions
- ✅ Immediately shows conflict toast without cleanup attempts
- ✅ More reliable detection without race conditions
- ✅ Cleanup only happens via manual user action

```javascript
async function checkForSessionConflicts() {
  if (!authToken) return false;
  
  try {
    // First check: JWT-based session conflict detection
    const response = await fetch('/api/tracking/session-status', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });
    
    if (response.ok) {
      const sessionStatus = await response.json();
      
      // CRITICAL FIX: Only block if desktop sessions exist, BUT don't auto-cleanup
      if (sessionStatus.hasDesktopSession === true || 
          sessionStatus.conflictDetected === true) {
        console.log('🚫 Desktop app detected - blocking website playback');
        
        // DO NOT call cleanupOldDesktopSessions() here - that's the bug!
        // Instead, show the conflict notification immediately
        showConflictToast();
        
        // Add a more specific debug log
        console.log('Desktop session detected - showing conflict toast without cleanup');
        
        return true; // Block playback
      }
    }

    // Second check: Device fingerprint-based desktop detection (keep this as backup)
    const fingerprint = localStorage.getItem('deviceFingerprint');
    if (fingerprint) {
      try {
        const fingerprintResponse = await fetch('/api/tracking/desktop-active-status', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ fingerprint: fingerprint }),
          signal: AbortSignal.timeout(3000)
        });

        if (fingerprintResponse.ok) {
          const { isDesktopActive } = await fingerprintResponse.json();
          if (isDesktopActive) {
            console.log('🚫 Desktop app active on this machine - blocking playback');
            showConflictToast();
            if (player) {
              player.pause();
            }
            return true;
          }
        }
      } catch (fingerprintError) {
        // Ignore fingerprint check errors - non-critical
        console.log('Fingerprint check failed (non-critical):', fingerprintError.message);
      }
    }
    
  } catch (error) {
    // Ignore timeout errors - they're non-critical
    if (error.name !== 'TimeoutError' && error.name !== 'AbortError') {
      console.error('Error checking session conflicts:', error);
    }
  }
  
  return false;
}
```

**What Changed**:
- ❌ REMOVED automatic cleanup on conflict detection
- ❌ REMOVED debug session calls
- ❌ REMOVED recheck logic after cleanup
- ✅ ADDED immediate conflict toast display
- ✅ ADDED clearer logging

### 3. Cleanup Functions

```javascript
// Clean up old desktop sessions
async function cleanupOldDesktopSessions() {
  if (!authToken) return;
  
  try {
    const response = await fetch('/api/tracking/cleanup-desktop-sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(3000)
    });
    
    if (response.ok) {
      const result = await response.json();
      if (result.cleanedSessions > 0) {
        console.log(`🧹 Cleaned up ${result.cleanedSessions} old desktop sessions`);
      }
    }
  } catch (error) {
    // Non-critical - just log and continue
    console.log('Cleanup request failed (non-critical):', error.message);
  }
}

// Debug function to see all sessions
async function debugSessions() {
  if (!authToken) return;
  
  try {
    const response = await fetch('/api/debug/sessions', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log('🔍 Debug - All sessions:', result);
      return result;
    }
  } catch (error) {
    console.error('Debug request failed:', error);
  }
}
```

### 4. Manual Cleanup Function (IMPROVED VERSION)

**Key Changes**:
- ✅ Only cleans up OLD desktop sessions (not active ones)
- ✅ Reloads page after successful cleanup
- ✅ Shows helpful message if no old sessions found
- ✅ Includes timeout protection

```javascript
// Manual cleanup function for users
async function manualCleanup() {
  if (!authToken) return;
  
  try {
    console.log('🧹 Manual cleanup triggered - only cleaning OLD desktop sessions');
    const response = await fetch('/api/tracking/cleanup-desktop-sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(3000)
    });
    
    if (response.ok) {
      const result = await response.json();
      if (result.cleanedSessions > 0) {
        console.log(`🧹 Manually cleaned up ${result.cleanedSessions} old desktop sessions`);
        // After manual cleanup, refresh the page or restart video
        location.reload();
      } else {
        console.log('✅ No old desktop sessions to clean up');
        alert('No old desktop sessions found. The desktop app might still be running.');
      }
    }
  } catch (error) {
    console.error('Manual cleanup failed:', error);
    alert('Cleanup failed. Please try again.');
  }
}
```

### 5. Toast Notification

```javascript
// Show toast notification for session conflicts
function showConflictToast() {
  // Remove any existing toasts
  const existingToast = document.querySelector('.session-toast');
  if (existingToast) {
    existingToast.remove();
  }

  // Create new toast with manual cleanup button
  const toast = document.createElement('div');
  toast.className = 'session-toast';
  toast.innerHTML = `
    <h4>Desktop App Detected</h4>
    <p>Close the desktop app completely to watch on the website.</p>
    <button onclick="manualCleanup()" style="margin-top: 8px; padding: 4px 8px; background: white; color: #e74c3c; border: none; border-radius: 4px; cursor: pointer; font-size: 12px;">
      Clear Old Sessions
    </button>
  `;
  
  document.body.appendChild(toast);
  
  // Auto-remove after 5 seconds
  setTimeout(() => {
    toast.remove();
  }, 5000);
}
```

### 5. Conflict Monitoring

```javascript
let conflictMonitoringInterval = null;

function startConflictMonitoring() {
  // Clear any existing interval
  if (conflictMonitoringInterval) {
    clearInterval(conflictMonitoringInterval);
  }
  
  console.log('Starting aggressive conflict monitoring');
  
  conflictMonitoringInterval = setInterval(async () => {
    // Check for desktop app presence regardless of video state
    const hasDesktopSession = await checkForSessionConflicts();
    
    if (hasDesktopSession) {
      console.log('Desktop app detected - stopping website playback');
      
      // Pause video if it's playing
      if (player && !player.paused()) {
        player.pause();
        showConflictToast();
      }
      
      // Complete current session since desktop app is present
      if (currentSessionId) {
        const duration = Math.floor((Date.now() - (currentVideoStartTime || Date.now())) / 1000);
        await completeWatchSession(currentSessionId, duration, false, pausedCount);
        currentSessionId = null;
      }
      
      // Complete ad tracking
      if (currentAdTrackingId) {
        const adDuration = Math.floor(player.currentTime() || 0);
        await completeAdTracking(currentAdTrackingId, adDuration, false);
        currentAdTrackingId = null;
      }
    }
  }, 5000); // Check every 5 seconds
}

function stopConflictMonitoring() {
  if (conflictMonitoringInterval) {
    clearInterval(conflictMonitoringInterval);
    conflictMonitoringInterval = null;
    console.log('Stopped conflict monitoring');
  }
}
```

### 6. Video Player Play Event Handler

```javascript
player.on('play', async function() {
  console.log('🎬 Video play event triggered');
  
  // CRITICAL: Check for desktop app before allowing playback
  const hasDesktopSession = await checkForSessionConflicts();
  if (hasDesktopSession) {
    console.log('🚫 Desktop app detected - pausing video immediately');
    player.pause();
    showConflictToast();
    return;
  }
  
  // Start conflict monitoring
  startConflictMonitoring();
  
  // ... rest of play handler
});
```

---

## How It Works

### Desktop Detection Flow:

1. **User Agent Check** (Primary Method)
   - Electron app sends user-agent containing "Electron"
   - Backend checks `user_agent` column in `watch_sessions` table
   - Only sessions with "Electron" in user agent are considered desktop sessions

2. **Device Fingerprint Check** (Secondary Method)
   - Desktop app sends heartbeat to `/api/tracking/desktop-active` every few seconds
   - Stores fingerprint + timestamp in `desktop_active_sessions` table
   - Website checks `/api/tracking/desktop-active-status` with same fingerprint
   - Active if heartbeat within last 10 seconds

### Session Conflict Resolution:

1. Website calls `checkForSessionConflicts()` before playing video
2. If desktop session detected → pause video, show toast
3. Continuous monitoring every 5 seconds
4. If desktop detected during playback → pause video, complete session
5. Manual cleanup button allows users to clear old sessions

### Console Output Meaning:

```
🔍 Session status for branden: {
  totalActiveSessions: 1,           // Total active sessions (website + desktop)
  activeDesktopSessions: 0,         // Sessions with "Electron" in user_agent
  userAgents: [ 'Mozilla/5.0...' ]  // List of user agents (truncated to 50 chars)
}
```

```
🔍 Desktop status check for fingerprint f651017d-feec-4a85-bafb-09b56db9834f: INACTIVE
```
- Checks if desktop app has sent heartbeat within last 10 seconds
- ACTIVE = desktop app is running
- INACTIVE = desktop app is closed or hasn't sent heartbeat

---

## Key Detection Rules

✅ **Desktop App Detected IF**:
- User agent contains "Electron" (case-insensitive)
- OR device fingerprint has heartbeat within 10 seconds

❌ **Website Blocked IF**:
- Any active desktop session exists
- OR device fingerprint shows desktop active

🔑 **Critical Check**:
```javascript
const isDesktopApp = userAgent.toLowerCase().includes('electron');
```

This is the ONLY way to identify Electron app vs browser.

---

## Files Containing This Code

### Backend:
- `backend/server.js` - All API endpoints
- `backend/database-postgres.js` - Table schemas

### Frontend:
- `public/index.html` - All session tracking and conflict detection

### Database:
- `watch_sessions` table - Stores all sessions with user_agent
- `desktop_active_sessions` table - Stores device fingerprints
- `ad_tracking` table - Linked to sessions for ad completion

---

## Summary

The system uses **two detection methods**:
1. **User-Agent matching** (primary) - checks for "Electron" string
2. **Device fingerprinting** (secondary) - checks for recent heartbeat

Both methods work together to ensure the website pauses when the desktop app is running on the same computer, preventing simultaneous playback.

