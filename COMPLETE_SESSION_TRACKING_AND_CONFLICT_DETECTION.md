# 📊 Complete Session Tracking & Conflict Detection Code

This document contains all the code related to tracking sessions and preventing website video playback when the desktop app is running.

---

## **🔧 Backend API Endpoints**

### **1. Start Session Endpoint**
**Route:** `POST /api/tracking/start-session`

```javascript
app.post('/api/tracking/start-session', authenticateToken, async (req, res) => {
  try {
    const { videoName, quality } = req.body;
    const userId = req.user.userId;
    const username = req.user.username;
    const userIP = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');
    
    console.log(`🔍 Checking for active sessions for user ${username} (ID: ${userId})`);
    
    // Get database pool for direct queries
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
    
    // Check for desktop app precedence
    const currentUserAgent = userAgent || '';
    const isDesktopApp = currentUserAgent.includes('Electron') || 
                        currentUserAgent.includes('desktop') || 
                        currentUserAgent.includes('app');
    
    if (activeSessionsResult.rows.length > 0) {
      // Check if there's an active desktop session
      const desktopSessions = activeSessionsResult.rows.filter(session => 
        session.user_agent && (
          session.user_agent.includes('Electron') || 
          session.user_agent.includes('desktop') ||
          session.user_agent.includes('app')
        )
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
      
      console.log(`⚠️ Found ${activeSessionsResult.rows.length} active session(s) for ${username}, closing them`);
      
      for (const session of activeSessionsResult.rows) {
        const duration = Math.floor((Date.now() - new Date(session.start_time).getTime()) / 1000);
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

### **2. Session Status Endpoint**
**Route:** `GET /api/tracking/session-status`

```javascript
app.get('/api/tracking/session-status', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    // Get database pool for direct queries
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Find ONLY ACTIVE desktop sessions (end_time IS NULL)
    // We'll also check for recently ended desktop sessions to catch recently closed apps
    const desktopSessionsResult = await pool.query(
      `SELECT id, video_name, start_time, end_time, user_agent, user_ip
       FROM watch_sessions 
       WHERE user_id = $1 
       AND user_agent IS NOT NULL 
       AND (
         user_agent ILIKE '%electron%' OR 
         user_agent ILIKE '%desktop%' OR 
         user_agent ILIKE '%app%'
       )
       AND (
         (end_time IS NULL) OR 
         (end_time IS NOT NULL AND end_time > NOW() - INTERVAL '2 minutes')
       )
       ORDER BY start_time DESC`,
      [userId]
    );
    
    // Find any active sessions for this user
    const activeSessionsResult = await pool.query(
      `SELECT id, video_name, start_time, user_agent, user_ip
       FROM watch_sessions 
       WHERE user_id = $1 AND end_time IS NULL
       ORDER BY start_time DESC`,
      [userId]
    );
    
    // Check if any active session is from desktop app
    const activeDesktopSessions = activeSessionsResult.rows.filter(session => 
      session.user_agent && (
        session.user_agent.toLowerCase().includes('electron') || 
        session.user_agent.toLowerCase().includes('desktop') ||
        session.user_agent.toLowerCase().includes('app')
      )
    );
    
    const hasActiveDesktopSession = activeDesktopSessions.length > 0;
    
    // Separate active and recent desktop sessions
    const activeDesktopSessionsFromQuery = desktopSessionsResult.rows.filter(session => 
      session.end_time === null
    );
    
    const recentDesktopSessions = desktopSessionsResult.rows.filter(session => 
      session.end_time !== null && 
      (new Date() - new Date(session.end_time)) < 120000 // 2 minutes from END time, not start time
    );
    
    const hasRecentDesktopSession = recentDesktopSessions.length > 0;
    const hasWebSession = activeSessionsResult.rows.length > activeDesktopSessions.length;
    
    console.log(`🔍 Session status for ${username}: ${activeSessionsResult.rows.length} active sessions (${activeDesktopSessions.length} active desktop, ${recentDesktopSessions.length} recent desktop)`);
    console.log(`🔍 Desktop sessions breakdown: ${activeDesktopSessionsFromQuery.length} active, ${recentDesktopSessions.length} recent`);
    
    // SIMPLIFIED LOGIC: Block if ANY desktop session exists (active OR recent)
    const shouldBlock = hasActiveDesktopSession || hasRecentDesktopSession;
    
    res.json({
      hasActiveSession: activeSessionsResult.rows.length > 0,
      sessionCount: activeSessionsResult.rows.length,
      hasDesktopSession: shouldBlock, // Simplified - any desktop presence blocks
      hasWebSession: hasWebSession,
      desktopSessionCount: activeDesktopSessions.length,
      webSessionCount: activeSessionsResult.rows.length - activeDesktopSessions.length,
      conflictDetected: shouldBlock,
      hasActiveDesktopSession: hasActiveDesktopSession,
      hasRecentDesktopSession: hasRecentDesktopSession,
      message: shouldBlock ? 'Desktop app detected' : 'No desktop app detected'
    });
    
  } catch (error) {
    console.error('❌ Error checking session status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

### **3. Desktop Session Cleanup Endpoint**
**Route:** `POST /api/tracking/cleanup-desktop-sessions`

```javascript
app.post('/api/tracking/cleanup-desktop-sessions', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const username = req.user.username;
    
    // Get database pool for direct queries
    const pool = getPool();
    if (!pool) {
      console.error('❌ Database pool not available');
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    console.log(`🧹 Cleaning up old desktop sessions for ${username} (ID: ${userId})`);
    
    // First, let's see what desktop sessions exist
    const debugResult = await pool.query(
      `SELECT id, video_name, start_time, end_time, user_agent, user_ip
       FROM watch_sessions 
       WHERE user_id = $1 
       AND user_agent IS NOT NULL 
       AND (
         user_agent ILIKE '%electron%' OR 
         user_agent ILIKE '%desktop%' OR 
         user_agent ILIKE '%app%'
       )
       ORDER BY start_time DESC`,
      [userId]
    );
    
    console.log(`🔍 Debug: Found ${debugResult.rowCount} desktop sessions for ${username}:`, debugResult.rows);
    
    // Find and close ALL desktop sessions (incomplete AND recent completed ones)
    // This is more aggressive - closes any desktop session that might be blocking the website
    const result = await pool.query(
      `UPDATE watch_sessions 
       SET end_time = CURRENT_TIMESTAMP, 
           duration_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - start_time))::INTEGER,
           completed = false
       WHERE user_id = $1 
       AND user_agent IS NOT NULL 
       AND (
         user_agent ILIKE '%electron%' OR 
         user_agent ILIKE '%desktop%' OR 
         user_agent ILIKE '%app%'
       )
       AND (
         end_time IS NULL OR 
         (end_time IS NOT NULL AND start_time > NOW() - INTERVAL '10 minutes')
       )
       RETURNING id, video_name, duration_seconds, start_time, end_time`,
      [userId]
    );
    
    console.log(`✅ Cleaned up ${result.rowCount} old desktop sessions for ${username}`);
    
    // Also close any active ad tracking for these sessions
    if (result.rowCount > 0) {
      const sessionIds = result.rows.map(row => row.id);
      await pool.query(
        `UPDATE ad_tracking 
         SET ad_end_time = CURRENT_TIMESTAMP, 
             duration_seconds = EXTRACT(EPOCH FROM (CURRENT_TIMESTAMP - ad_start_time))::INTEGER,
             completed = false
         WHERE session_id = ANY($1) AND ad_end_time IS NULL`,
        [sessionIds]
      );
      console.log(`✅ Also cleaned up ad tracking for ${sessionIds.length} sessions`);
    }
    
    res.json({
      success: true,
      cleanedSessions: result.rowCount,
      message: `Cleaned up ${result.rowCount} old desktop sessions`
    });
    
  } catch (error) {
    console.error('❌ Error cleaning up desktop sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

### **4. Debug Sessions Endpoint**
**Route:** `GET /api/debug/sessions`

```javascript
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
    
    console.log(`🔍 Debug: All sessions for ${username}:`, result.rows);
    
    res.json({
      username: username,
      userId: userId,
      sessions: result.rows,
      sessionCount: result.rows.length
    });
    
  } catch (error) {
    console.error('❌ Error in debug sessions:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

## **🎬 Frontend Session Tracking Code**

### **1. Start Watch Session Function**

```javascript
// Start a watch session
async function startWatchSession(videoName, quality) {
  if (!authToken) return null;

  try {
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 second timeout

    const response = await fetch('/api/tracking/start-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        videoName: videoName,
        quality: quality
      }),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const result = await response.json();
      currentSessionId = result.sessionId;
      console.log('📺 Watch session started:', result.sessionId);
      return result.sessionId;
    } else if (response.status === 409) {
      // Session conflict detected (desktop app active)
      const errorData = await response.json();
      console.log('🚫 Session conflict detected:', errorData.message);
      
      // Pause video if playing
      if (player && !player.paused()) {
        player.pause();
      }
      
      // Show conflict message
      showSessionConflictMessage();
      
      // Set up monitoring
      startSessionConflictMonitoring();
      
      return null; // Session not started due to conflict
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('📺 Watch session request timed out (non-critical)');
    } else {
      console.error('Error starting watch session:', error);
    }
  }
  return null;
}
```

### **2. Session Conflict Detection Function**

```javascript
// Check for session conflicts - returns true if desktop app is present (simplified)
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
        
        // Aggressive cleanup - clean up ALL desktop sessions that might be blocking
        try {
          console.log('🧹 Running aggressive desktop session cleanup...');
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

### **3. Cleanup Functions**

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

### **4. Manual Cleanup Function**

```javascript
// Manual cleanup function for users
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

### **5. Conflict Monitoring**

```javascript
// Monitor for desktop app starting while website is playing
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
  }, 1500); // Check every 1.5 seconds for faster detection
}

function stopConflictMonitoring() {
  if (conflictMonitoringInterval) {
    clearInterval(conflictMonitoringInterval);
    conflictMonitoringInterval = null;
    console.log('Stopped conflict monitoring');
  }
}
```

---

## **🎨 UI Components**

### **1. Toast Notification CSS**

```css
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

### **2. Toast Notification Function**

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
  
  // Auto-remove after 5 seconds (longer to allow manual cleanup)
  setTimeout(() => {
    toast.remove();
  }, 5000);
}
```

---

## **🎯 Video Player Integration**

### **1. Play Event Handler with Conflict Check**

```javascript
// Video play event - starts ad tracking ONLY if not already tracking
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
  
  isPlaying = true;
  console.log('▶️ Video started playing');
  
  if (!sessionStartTime && currentSessionId) {
    sessionStartTime = Date.now();
    console.log('▶️ Video started playing, tracking begins');
  }
  
  // Only start ad tracking if we don't already have an active tracking session
  // (This prevents duplicate tracking when video autoplays after ended event)
  if (currentSessionId && !isAdPlaying && !currentAdTrackingId) {
    isAdPlaying = true;
    adStartTime = Date.now();
    startAdTracking(currentSessionId).then(adTrackingId => {
      if (adTrackingId) {
        currentAdTrackingId = adTrackingId;
        console.log('📺 Ad tracking started for manual play');
      }
    });
  } else if (isAdPlaying && currentAdTrackingId) {
    // Resume tracking the same ad (e.g., after pause)
    console.log('📺 Ad tracking resumed (same ad, ID:', currentAdTrackingId, ')');
  } else {
    console.log('📺 Play event - ad tracking already active, skipping duplicate');
  }
  
  // Hide the big play button when playing - try multiple times to ensure it works
  const hidePlayButton = () => {
    const bigPlayButton = player.el().querySelector('.vjs-big-play-button');
    if (bigPlayButton) {
      console.log('🎯 Hiding play button');
      bigPlayButton.style.display = 'none';
      bigPlayButton.style.visibility = 'hidden';
      bigPlayButton.style.opacity = '0';
      bigPlayButton.style.pointerEvents = 'none';
    }
  };
  
  // Try immediately and with delays
  hidePlayButton();
  setTimeout(hidePlayButton, 50);
  setTimeout(hidePlayButton, 100);
  setTimeout(hidePlayButton, 200);
  setTimeout(hidePlayButton, 500);
});
```

### **2. Pause Event Handler**

```javascript
player.on('pause', () => {
  isPlaying = false;
  pausedCount++;
  console.log('⏸️ Video paused, pause count:', pausedCount);
  
  // Stop conflict monitoring when paused
  stopConflictMonitoring();
  
  // Accumulate actual playback time if ad was playing
  if (isAdPlaying && adStartTime) {
    const currentTime = player.currentTime() || 0;
    accumulatedAdTime = currentTime;
    console.log('📺 Ad tracking paused - Current video time:', Math.floor(currentTime), 'seconds');
  }
  
  // Don't complete ad tracking on pause - just pause the tracking
  // The ad is still playing, just paused
  console.log('📺 Ad tracking paused (not completed)');
  
  // Show the big play button when paused
  const showPlayButton = () => {
    const bigPlayButton = player.el().querySelector('.vjs-big-play-button');
    if (bigPlayButton) {
      console.log('🎯 Showing play button');
      bigPlayButton.style.display = 'flex';
      bigPlayButton.style.visibility = 'visible';
      bigPlayButton.style.opacity = '1';
      bigPlayButton.style.pointerEvents = 'auto';
    }
  };
  
  showPlayButton();
  setTimeout(showPlayButton, 50);
  setTimeout(showPlayButton, 100);
});
```

### **3. Video End Event Handler**

```javascript
// Video ended event - completes ad tracking and session
player.on("ended", async function () {
  // Stop conflict monitoring when video ends
  stopConflictMonitoring();
  
  console.log(`🎬 Video ${currentIndex + 1} (${playlist[currentIndex]}) ended, switching to next video...`);
  console.log(`🎬 Current player state:`, {
    readyState: player.readyState(),
    paused: player.paused(),
    ended: player.ended(),
    currentSrc: player.currentSrc()
  });
  
  // Complete ad tracking if ad was playing (only when video actually ends)
  if (isAdPlaying && currentAdTrackingId && adStartTime) {
    // Use the video's current time for accurate tracking (excludes loading/buffering time)
    const currentTime = player.currentTime() || 0;
    const adDurationSeconds = Math.floor(Math.max(currentTime, accumulatedAdTime));
    console.log('🔍 Ad duration calculation:', {
      currentTime: currentTime,
      accumulatedAdTime: accumulatedAdTime,
      finalDuration: adDurationSeconds,
      videoDuration: player.duration()
    });
    
    await completeAdTracking(currentAdTrackingId, adDurationSeconds, true);
    
    // CRITICAL: Reset ad tracking state AFTER completion
    isAdPlaying = false;
    currentAdTrackingId = null;
    adStartTime = null;
    accumulatedAdTime = 0;
    console.log('📺 Ad tracking completed on video end:', adDurationSeconds, 'seconds (actual video time)');
  }
  
  // Complete current session if exists
  if (!isQualitySwitching && currentSessionId && currentVideoStartTime) {
    const durationSeconds = Math.floor((Date.now() - currentVideoStartTime) / 1000);
    console.log('📺 Completing session:', {
      sessionId: currentSessionId,
      durationSeconds: durationSeconds,
      completed: true,
      pausedCount: pausedCount
    });
    
    await completeWatchSession(currentSessionId, durationSeconds, true, pausedCount);
    currentSessionId = null;
    currentVideoStartTime = null;
    pausedCount = 0;
    console.log('📺 Session completed successfully');
  }
  
  // Move to next video in playlist
  currentIndex = (currentIndex + 1) % playlist.length;
  console.log(`🔄 Switching to video ${currentIndex + 1}/${playlist.length}: ${playlist[currentIndex]}`);
  
  // Load next video
  await loadVideoWithQuality(currentIndex, currentQuality);
  
  // CRITICAL: Start new session and ad tracking immediately for the next video
  // This ensures tracking begins as soon as the next video loads
  if (authToken) {
    try {
      // Start new session for the next video
      const sessionId = await startWatchSession(playlist[currentIndex], "standard");
      
      if (sessionId) {
        currentSessionId = sessionId;
        currentVideoStartTime = Date.now();
        pausedCount = 0;
        console.log('📺 New session started for next video:', sessionId);
        
        // Start ad tracking immediately for the next video
        isAdPlaying = true;
        adStartTime = Date.now();
        accumulatedAdTime = 0;
        
        const adTrackingId = await startAdTracking(sessionId);
        if (adTrackingId) {
          currentAdTrackingId = adTrackingId;
          console.log('📺 New ad tracking started for next video:', adTrackingId);
        }
      }
    } catch (error) {
      console.error('Error starting session for next video:', error);
    }
  }
});
```

---

## **🔍 How It Works**

### **Session Tracking Flow:**
1. **User clicks play** → `startWatchSession()` called
2. **Backend checks for conflicts** → Desktop app detection
3. **If conflict detected** → Returns 409 error, blocks playback
4. **If no conflict** → Creates new session, allows playback
5. **Video plays** → Ad tracking starts
6. **Video ends** → Session and ad tracking completed
7. **Next video loads** → New session starts automatically

### **Conflict Detection:**
1. **Frontend calls** `/api/tracking/session-status`
2. **Backend queries database** → Looks for desktop sessions
3. **Desktop app detection** → User agent contains "Electron", "desktop", or "app"
4. **Time window check** → Active sessions OR sessions ended within 2 minutes
5. **Response sent** → `hasDesktopSession: true/false`
6. **Frontend blocks playback** → If desktop app detected

### **Cleanup System:**
1. **Automatic cleanup** → Runs when conflicts detected
2. **Manual cleanup** → User clicks "Clear Old Sessions" button
3. **Aggressive cleanup** → Closes ALL desktop sessions (active + recent)
4. **Recheck** → After cleanup, checks if conflicts resolved
5. **Allow playback** → If no conflicts remain

This system ensures that only one platform (website OR desktop app) can play videos at a time, with the desktop app taking precedence when both are active.

