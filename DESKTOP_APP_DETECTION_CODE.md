# 🖥️ Desktop App Detection Code - Complete Reference

## **Overview**
This document contains all the code related to checking if the desktop app is open and detecting session conflicts between the website and desktop app.

---

## **🔧 Backend API Endpoints**

### **1. Session Status Check Endpoint**
**Route:** `GET /api/tracking/session-status`
**Purpose:** Check if desktop app is currently active

```javascript
// backend/server.js
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

### **2. Desktop Session Cleanup Endpoint**
**Route:** `POST /api/tracking/cleanup-desktop-sessions`
**Purpose:** Clean up old/incomplete desktop sessions

```javascript
// backend/server.js
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

### **3. Debug Sessions Endpoint**
**Route:** `GET /api/debug/sessions`
**Purpose:** Debug endpoint to see all sessions for troubleshooting

```javascript
// backend/server.js
app.get('/api/debug/sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Get all sessions for this user from the last hour
    const result = await pool.query(
      `SELECT id, video_name, start_time, end_time, user_agent, user_ip, completed
       FROM watch_sessions 
       WHERE user_id = $1 
       AND start_time > NOW() - INTERVAL '1 hour'
       ORDER BY start_time DESC`,
      [userId]
    );
    
    console.log(`🔍 Debug sessions for ${username}:`, result.rows.length, 'sessions');
    
    res.json({
      username: username,
      sessions: result.rows,
      sessionCount: result.rows.length
    });
    
  } catch (error) {
    console.error('❌ Error in debug sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

### **4. Start Session with Desktop Detection**
**Route:** `POST /api/tracking/start-session`
**Purpose:** Start new session with desktop app precedence logic

```javascript
// backend/server.js (excerpt from start-session endpoint)
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
  
  // If we get here, either:
  // 1. This is a desktop app request (takes precedence)
  // 2. No desktop sessions exist, so web session is allowed
}
```

---

## **🎨 Frontend Detection Code**

### **1. Main Conflict Check Function**
**Purpose:** Check if desktop app is open and return true/false

```javascript
// public/index.html
async function checkForSessionConflicts() {
  if (!authToken) return false;
  
  try {
    const response = await fetch('/api/tracking/session-status', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      },
      // Add timeout to prevent hanging
      signal: AbortSignal.timeout(5000)
    });
    
    if (response.ok) {
      const sessionStatus = await response.json();
      
      // SIMPLIFIED: Block if desktop app is detected in ANY way
      if (sessionStatus.hasDesktopSession === true || 
          sessionStatus.conflictDetected === true) {
        console.log('Desktop app detected - blocking website playback');
        
        // Debug: Show all sessions to understand what's happening
        try {
          await debugSessions();
        } catch (debugError) {
          console.log('Debug request failed (non-critical):', debugError);
        }
        
        // Only cleanup if we actually detect a conflict
        // Don't cleanup on every check - only when blocking is needed
        try {
          console.log('🧹 Desktop session detected - running cleanup...');
          await cleanupOldDesktopSessions();
          
          // Wait a moment for cleanup to complete, then check again
          await new Promise(resolve => setTimeout(resolve, 1000));
          
          // Check if conflicts are resolved after cleanup
          const recheckResponse = await fetch('/api/tracking/session-status', {
            method: 'GET',
            headers: {
              'Authorization': `Bearer ${authToken}`,
              'Content-Type': 'application/json'
            },
            signal: AbortSignal.timeout(3000)
          });
          
          if (recheckResponse.ok) {
            const recheckStatus = await recheckResponse.json();
            if (!recheckStatus.hasDesktopSession && !recheckStatus.conflictDetected) {
              console.log('✅ Cleanup successful - desktop sessions cleared');
              return false; // Conflicts resolved, allow playback
            } else {
              console.log('⚠️ Cleanup completed but conflicts still detected');
            }
          }
        } catch (cleanupError) {
          console.log('Cleanup attempt failed (non-critical):', cleanupError);
        }
        
        return true;
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

### **2. Desktop Session Cleanup Function**
**Purpose:** Clean up old desktop sessions from frontend

```javascript
// public/index.html
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
```

### **3. Debug Sessions Function**
**Purpose:** Debug function to see all sessions

```javascript
// public/index.html
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

### **4. Conflict Toast Notification**
**Purpose:** Show user-friendly notification when desktop app is detected

```javascript
// public/index.html
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
  
  // Auto-remove after 5 seconds (longer to allow manual cleanup)
  setTimeout(() => {
    toast.remove();
  }, 5000);
}
```

### **5. Manual Cleanup Function**
**Purpose:** Allow users to manually trigger cleanup

```javascript
// public/index.html
async function manualCleanup() {
  if (!authToken) return;
  
  try {
    console.log('🧹 Manual cleanup requested by user');
    const response = await fetch('/api/tracking/cleanup-desktop-sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const result = await response.json();
      console.log(`🧹 Manual cleanup completed: ${result.cleanedSessions} sessions cleaned`);
      
      // Show success message
      const toast = document.createElement('div');
      toast.className = 'session-toast';
      toast.style.background = '#27ae60';
      toast.innerHTML = `
        <h4>Cleanup Complete</h4>
        <p>Cleaned up ${result.cleanedSessions} old desktop sessions.</p>
      `;
      
      document.body.appendChild(toast);
      setTimeout(() => toast.remove(), 3000);
      
      // Remove the conflict toast
      const conflictToast = document.querySelector('.session-toast');
      if (conflictToast) conflictToast.remove();
      
    } else {
      console.error('Manual cleanup failed:', response.status);
    }
  } catch (error) {
    console.error('Manual cleanup error:', error);
  }
}
```

### **6. Conflict Monitoring System**
**Purpose:** Continuously monitor for desktop app presence while video is playing

```javascript
// public/index.html
function startConflictMonitoring() {
  if (conflictMonitoringInterval) {
    clearInterval(conflictMonitoringInterval);
  }
  
  console.log('🔍 Starting conflict monitoring (every 5 seconds)');
  
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
  }, 5000); // Check every 5 seconds instead of 1.5
}

function stopConflictMonitoring() {
  if (conflictMonitoringInterval) {
    clearInterval(conflictMonitoringInterval);
    conflictMonitoringInterval = null;
    console.log('🛑 Stopped conflict monitoring');
  }
}
```

### **7. Video Play Event with Desktop Check**
**Purpose:** Check for desktop app before allowing video to play

```javascript
// public/index.html
player.on('play', async function() {
  // CRITICAL: Check for desktop session before allowing play
  const hasDesktopSession = await checkForSessionConflicts();
  
  if (hasDesktopSession) {
    console.log('Play blocked - desktop app is active');
    player.pause();
    showConflictToast();
    return; // Stop execution completely
  }
  
  // If we get here, no conflict detected - start monitoring
  startConflictMonitoring();
  
  // ... rest of play logic
});
```

---

## **🎨 CSS for Toast Notifications**

```css
/* public/index.html */
/* Session Conflict Toast Notifications */
.session-toast {
  position: fixed;
  top: 20px;
  right: 20px;
  background: #e74c3c;
  color: white;
  padding: 1rem 1.5rem;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  z-index: 10000;
  animation: slideIn 0.3s ease-out, fadeOut 0.3s ease-in 2.7s;
  font-family: Arial, sans-serif;
  max-width: 350px;
}

.session-toast h4 {
  margin: 0 0 0.5rem 0;
  font-size: 1rem;
  font-weight: bold;
}

.session-toast p {
  margin: 0;
  font-size: 0.875rem;
  opacity: 0.95;
}

@keyframes slideIn {
  from {
    transform: translateX(400px);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@keyframes fadeOut {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}
```

---

## **🔍 How It Works**

### **Detection Logic:**
1. **User Agent Check:** Only sessions with `user_agent` containing "electron" are considered desktop sessions
2. **Active Session Check:** Looks for sessions with `end_time IS NULL` (still active)
3. **Conflict Detection:** If desktop session exists, blocks website playback
4. **Cleanup:** Automatically cleans up old desktop sessions when conflicts detected

### **Flow:**
1. **User tries to play video** → `checkForSessionConflicts()` called
2. **Frontend calls** `/api/tracking/session-status`
3. **Backend checks** for active Electron sessions
4. **If desktop detected** → Block playback, show toast, cleanup old sessions
5. **If no desktop** → Allow playback, start monitoring
6. **Continuous monitoring** → Check every 5 seconds while playing

### **Key Features:**
- ✅ **Precise Detection:** Only "Electron" user agents flagged as desktop
- ✅ **Automatic Cleanup:** Old sessions cleaned when conflicts detected
- ✅ **User-Friendly:** Toast notifications with manual cleanup option
- ✅ **Rate Limited:** Prevents excessive API calls
- ✅ **Error Handling:** Graceful degradation on API failures
- ✅ **Debug Support:** Debug endpoint for troubleshooting

**This system ensures only one device can watch videos at a time, with desktop app taking precedence over website.**
