# 🎯 Complete Session Tracking Code

This document contains all the session tracking code from your CharityStream project, including backend endpoints, frontend functions, database helpers, and conflict detection.

---

## 📊 **Backend Session Tracking Endpoints (`backend/server.js`)**

### **1. Start Session Endpoint**
```javascript
// Start watching session
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

### **2. Session Status Endpoint (Conflict Detection)**
```javascript
// Check for session conflicts (used by frontend to detect active desktop sessions)
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
    
    // Find any active sessions for this user
    const activeSessionsResult = await pool.query(
      `SELECT id, video_name, start_time, user_agent, user_ip
       FROM watch_sessions 
       WHERE user_id = $1 AND end_time IS NULL
       ORDER BY start_time DESC`,
      [userId]
    );
    
    if (activeSessionsResult.rows.length === 0) {
      // No active sessions
      return res.json({
        hasActiveSession: false,
        sessionCount: 0,
        message: 'No active sessions'
      });
    }
    
    // Check if any active session is from desktop app (based on user_agent)
    const desktopSessions = activeSessionsResult.rows.filter(session => 
      session.user_agent && (
        session.user_agent.includes('Electron') || 
        session.user_agent.includes('desktop') ||
        session.user_agent.includes('app')
      )
    );
    
    const hasDesktopSession = desktopSessions.length > 0;
    const hasWebSession = activeSessionsResult.rows.length > desktopSessions.length;
    
    console.log(`🔍 Session status for ${username}: ${activeSessionsResult.rows.length} active sessions (${desktopSessions.length} desktop, ${activeSessionsResult.rows.length - desktopSessions.length} web)`);
    
    res.json({
      hasActiveSession: true,
      sessionCount: activeSessionsResult.rows.length,
      hasDesktopSession: hasDesktopSession,
      hasWebSession: hasWebSession,
      desktopSessionCount: desktopSessions.length,
      webSessionCount: activeSessionsResult.rows.length - desktopSessions.length,
      conflictDetected: hasDesktopSession && hasWebSession,
      message: hasDesktopSession ? 'Desktop session active' : 'Web session active'
    });
    
  } catch (error) {
    console.error('❌ Error checking session status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

### **3. Complete Session Endpoint**
```javascript
// Complete watching session
app.post('/api/tracking/complete-session', authenticateToken, async (req, res) => {
  try {
    const { sessionId, durationSeconds, completed, pausedCount } = req.body;
    const minutesWatched = Math.floor(durationSeconds / 60);

    // Complete the session
    const [err] = await dbHelpers.updateWatchSession(sessionId, {
      end_time: new Date(),
      duration_seconds: durationSeconds,
      completed: completed,
      paused_count: pausedCount || 0
    });

    if (err) {
      console.error('Error completing session:', err);
      return res.status(500).json({ error: 'Failed to complete session' });
    }

    // Note: Watch time is now tracked per-ad via updateWatchSeconds, not per-session
    // This prevents double-tracking and ensures immediate minute updates

    res.json({
      message: 'Session completed',
      sessionId: sessionId,
      durationSeconds: durationSeconds,
      minutesWatched: minutesWatched
    });
  } catch (error) {
    console.error('Error in complete-session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

### **4. Start Ad Tracking Endpoint**
```javascript
app.post('/api/tracking/start-ad', authenticateToken, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const [err, adTrackingId] = await dbHelpers.startAdTracking(req.user.userId, sessionId);
    if (err) {
      console.error('Error starting ad tracking:', err);
      return res.status(500).json({ error: 'Failed to start ad tracking' });
    }

    console.log(`📺 Ad tracking started for user ${req.user.userId}, session ${sessionId}`);
    res.json({
      adTrackingId: adTrackingId,
      message: 'Ad tracking started'
    });
  } catch (error) {
    console.error('Error in start-ad:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

### **5. Complete Ad Tracking Endpoint**
```javascript
app.post('/api/tracking/complete-ad', authenticateToken, async (req, res) => {
  try {
    const { adTrackingId, durationSeconds, completed = true } = req.body;
    
    const [err, adTracking] = await dbHelpers.completeAdTracking(adTrackingId, durationSeconds, completed);
    if (err) {
      console.error('Error completing ad tracking:', err);
      return res.status(500).json({ error: 'Failed to complete ad tracking' });
    }

    // Update daily stats and user's monthly minutes if ad was completed
    if (completed && durationSeconds > 0) {
      const [statsErr] = await dbHelpers.updateDailyStats(req.user.userId, 1, durationSeconds);
      if (statsErr) {
        console.error('Error updating daily stats:', statsErr);
      } else {
        console.log(`📊 Updated daily stats for user ${req.user.userId}`);
      }

      // Update user's total and monthly watch time (record seconds every time an ad completes)
      const secondsWatched = parseInt(durationSeconds, 10) || 0;
      console.log('🔍 Backend received ad completion:', {
        userId: req.user.userId,
        username: req.user.username,
        durationSeconds: durationSeconds,
        parsedSeconds: secondsWatched,
        willUpdateMonthly: secondsWatched > 0
      });
      if (secondsWatched > 0) {
        const [watchTimeErr, updatedUser] = await dbHelpers.updateWatchSeconds(req.user.userId, secondsWatched);
        if (watchTimeErr) {
          console.error('Error updating watch seconds:', watchTimeErr);
        } else {
          console.log(`⏱️ ${req.user.username} watched ${secondsWatched} seconds (${durationSeconds} sec) - Total: ${updatedUser.total_seconds_watched}s, Monthly: ${updatedUser.current_month_seconds}s`);
        }
      }
    }

    res.json({
      message: 'Ad tracking completed',
      durationSeconds: durationSeconds
    });
  } catch (error) {
    console.error('Error in complete-ad:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

---

## 🗄️ **Database Helper Functions (`backend/database-postgres.js`)**

### **1. Session Management Functions**
```javascript
// Create watch session
createWatchSession: async (sessionData) => {
  try {
    const result = await pool.query(
      `INSERT INTO watch_sessions (user_id, video_name, quality, user_ip, user_agent) 
       VALUES ($1, $2, $3, $4, $5) 
       RETURNING id`,
      [
        sessionData.userId,
        sessionData.videoName,
        sessionData.quality,
        sessionData.userIP,
        sessionData.userAgent
      ]
    );
    return [null, result.rows[0].id];
  } catch (error) {
    return [error, null];
  }
},

// Update watch session
updateWatchSession: async (sessionId, updateData) => {
  try {
    const setClause = Object.keys(updateData)
      .map((key, index) => `${key} = $${index + 2}`)
      .join(', ');
    
    const values = [sessionId, ...Object.values(updateData)];
    
    const result = await pool.query(
      `UPDATE watch_sessions SET ${setClause} WHERE id = $1 RETURNING *`,
      values
    );
    return [null, result.rows[0]];
  } catch (error) {
    return [error, null];
  }
},
```

### **2. Ad Tracking Functions**
```javascript
startAdTracking: async (userId, sessionId) => {
  try {
    await ensureTablesExist();
    const result = await pool.query(
      'INSERT INTO ad_tracking (user_id, session_id, ad_start_time) VALUES ($1, $2, CURRENT_TIMESTAMP) RETURNING id',
      [userId, sessionId]
    );
    return [null, result.rows[0].id];
  } catch (error) {
    return [error, null];
  }
},

// Complete ad tracking
completeAdTracking: async (adTrackingId, durationSeconds, completed = true) => {
  try {
    await ensureTablesExist();
    const result = await pool.query(
      'UPDATE ad_tracking SET ad_end_time = CURRENT_TIMESTAMP, duration_seconds = $2, completed = $3 WHERE id = $1 RETURNING *',
      [adTrackingId, durationSeconds, completed]
    );
    return [null, result.rows[0]];
  } catch (error) {
    return [error, null];
  }
},
```

### **3. Stats and Watch Time Functions**
```javascript
// Update daily stats for a user
updateDailyStats: async (userId, adsWatched = 1, watchTimeSeconds = 0) => {
  try {
    await ensureTablesExist();
    // Use UTC date to ensure consistency across timezones
    const today = new Date().toISOString().split('T')[0];
    
    console.log(`📊 Updating daily stats for user ${userId}, date: ${today}, ads: ${adsWatched}, seconds: ${watchTimeSeconds}`);
    
    // Try to update existing record
    const updateResult = await pool.query(
      `UPDATE daily_stats 
       SET ads_watched = ads_watched + $3, 
           total_watch_time_seconds = total_watch_time_seconds + $4,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = $1 AND date = $2
       RETURNING *`,
      [userId, today, adsWatched, watchTimeSeconds]
    );

    if (updateResult.rows.length > 0) {
      console.log(`✅ Updated existing daily stats for user ${userId}: ${updateResult.rows[0].ads_watched} ads total`);
      return [null, updateResult.rows[0]];
    }

    // If no existing record, create new one
    console.log(`📝 Creating new daily stats record for user ${userId}`);
    const insertResult = await pool.query(
      `INSERT INTO daily_stats (user_id, date, ads_watched, total_watch_time_seconds, streak_days)
       VALUES ($1, $2, $3, $4, 1)
       RETURNING *`,
      [userId, today, adsWatched, watchTimeSeconds]
    );

    console.log(`✅ Created new daily stats for user ${userId}: ${insertResult.rows[0].ads_watched} ads`);
    return [null, insertResult.rows[0]];
  } catch (error) {
    console.error('❌ Error updating daily stats:', error);
    return [error, null];
  }
},

// Update user's watch seconds (total and monthly)
updateWatchSeconds: async (userId, secondsWatched) => {
  try {
    const result = await pool.query(
      `UPDATE users 
       SET total_seconds_watched = total_seconds_watched + $2,
           current_month_seconds = current_month_seconds + $2
       WHERE id = $1 
       RETURNING total_seconds_watched, current_month_seconds`,
      [userId, secondsWatched]
    );
    return [null, result.rows[0]];
  } catch (error) {
    return [error, null];
  }
},
```

---

## 🎬 **Frontend Session Tracking Functions (`public/index.html`)**

### **1. Session Management Functions**
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

// Complete a watch session
async function completeWatchSession(sessionId, durationSeconds, completed, pausedCount) {
  if (!authToken || !sessionId) return;

  try {
    const response = await fetch('/api/tracking/complete-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        sessionId: sessionId,
        durationSeconds: durationSeconds,
        completed: completed,
        pausedCount: pausedCount || 0
      })
    });

    if (response.ok) {
      const data = await response.json();
      console.log('📺 Session completed successfully:', data);
    } else {
      console.error('Failed to complete session:', response.status);
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('📺 Session completion request timed out (non-critical)');
    } else {
      console.error('Error completing session:', error);
    }
  }
}
```

### **2. Ad Tracking Functions**
```javascript
// Start ad tracking
async function startAdTracking(sessionId) {
  if (!authToken || !sessionId) return null;

  try {
    const response = await fetch('/api/tracking/start-ad', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        sessionId: sessionId
      })
    });

    if (response.ok) {
      const result = await response.json();
      console.log('📺 Ad tracking started:', result.adTrackingId);
      return result.adTrackingId;
    }
  } catch (error) {
    console.error('Error starting ad tracking:', error);
  }
  return null;
}

async function completeAdTracking(adTrackingId, durationSeconds, completed = true) {
  if (!authToken || !adTrackingId) return;

  try {
    const response = await fetch('/api/tracking/complete-ad', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        adTrackingId: adTrackingId,
        durationSeconds: durationSeconds,
        completed: completed
      })
    });

    if (response.ok) {
      console.log('📺 Ad tracking completed:', durationSeconds, 'seconds');
      // Refresh user impact data and leaderboard
      await loadUserImpact(); // Make sure this completes before moving on
      loadLeaderboard();
    }
  } catch (error) {
    console.error('Error completing ad tracking:', error);
  }
}
```

### **3. Session Conflict Detection Functions**
```javascript
// Check for session conflicts and handle desktop app precedence
async function checkForSessionConflicts() {
  if (!authToken) return;
  
  try {
    console.log('🔍 Checking for session conflicts...');
    
    const response = await fetch('/api/tracking/session-status', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${authToken}`,
        'Content-Type': 'application/json'
      }
    });
    
    if (response.ok) {
      const sessionStatus = await response.json();
      console.log('📊 Session status:', sessionStatus);
      
      if (sessionStatus.conflictDetected || sessionStatus.hasDesktopSession) {
        console.log('⚠️ Desktop session detected - pausing video player');
        
        // Pause video if it's playing
        if (player && !player.paused()) {
          player.pause();
        }
        
        // Show conflict message
        showSessionConflictMessage();
        
        // Set up periodic checking
        startSessionConflictMonitoring();
        
        return true; // Conflict detected
      }
    } else {
      console.error('❌ Failed to check session status:', response.status);
    }
  } catch (error) {
    console.error('❌ Error checking session conflicts:', error);
  }
  
  return false; // No conflict
}

// Show session conflict message
function showSessionConflictMessage() {
  // Create or update conflict overlay
  let conflictOverlay = document.getElementById('sessionConflictOverlay');
  
  if (!conflictOverlay) {
    conflictOverlay = document.createElement('div');
    conflictOverlay.id = 'sessionConflictOverlay';
    conflictOverlay.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.8);
      display: flex;
      justify-content: center;
      align-items: center;
      z-index: 10000;
      color: white;
      font-family: Arial, sans-serif;
    `;
    
    conflictOverlay.innerHTML = `
      <div style="
        background: #2c3e50;
        padding: 2rem;
        border-radius: 12px;
        text-align: center;
        max-width: 400px;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      ">
        <div style="font-size: 2rem; margin-bottom: 1rem;">⚠️</div>
        <h2 style="margin: 0 0 1rem 0; color: #e74c3c;">Multiple Watch Sessions Detected</h2>
        <p style="margin: 0 0 1.5rem 0; line-height: 1.5;">
          Your desktop app is currently active and playing videos. 
          To watch on the website, please close the desktop app first.
        </p>
        <button id="checkAgainBtn" style="
          background: #3498db;
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1rem;
          margin-right: 0.5rem;
        ">Check Again</button>
        <button id="closeConflictBtn" style="
          background: #95a5a6;
          color: white;
          border: none;
          padding: 0.75rem 1.5rem;
          border-radius: 6px;
          cursor: pointer;
          font-size: 1rem;
        ">Close</button>
      </div>
    `;
    
    document.body.appendChild(conflictOverlay);
    
    // Add event listeners
    document.getElementById('checkAgainBtn').addEventListener('click', async () => {
      const hasConflict = await checkForSessionConflicts();
      if (!hasConflict) {
        hideSessionConflictMessage();
      }
    });
    
    document.getElementById('closeConflictBtn').addEventListener('click', hideSessionConflictMessage);
  }
  
  conflictOverlay.style.display = 'flex';
}

// Hide session conflict message
function hideSessionConflictMessage() {
  const conflictOverlay = document.getElementById('sessionConflictOverlay');
  if (conflictOverlay) {
    conflictOverlay.style.display = 'none';
  }
  stopSessionConflictMonitoring();
}

// Start monitoring for session conflicts
let sessionConflictInterval = null;
function startSessionConflictMonitoring() {
  if (sessionConflictInterval) return; // Already monitoring
  
  console.log('🔄 Starting session conflict monitoring...');
  sessionConflictInterval = setInterval(async () => {
    const hasConflict = await checkForSessionConflicts();
    if (!hasConflict) {
      hideSessionConflictMessage();
    }
  }, 5000); // Check every 5 seconds
}

// Stop monitoring for session conflicts
function stopSessionConflictMonitoring() {
  if (sessionConflictInterval) {
    console.log('🛑 Stopping session conflict monitoring...');
    clearInterval(sessionConflictInterval);
    sessionConflictInterval = null;
  }
}
```

---

## 🎮 **Video Player Event Handlers**

### **1. Play Event Handler**
```javascript
// Video play event - starts ad tracking ONLY if not already tracking
player.on('play', function() {
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
  
  // Hide the big play button when playing
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

### **3. Video Ended Event Handler**
```javascript
// Video ended event - completes ad tracking and session
player.on("ended", async function () {
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
      pausedCount: pausedCount,
      videoName: playlist[currentIndex]
    });
    
    if (typeof completeWatchSession === 'function') {
      await completeWatchSession(currentSessionId, durationSeconds, true, pausedCount);
    } else {
      console.error('❌ completeWatchSession function not available!');
    }
    
    currentVideoStartTime = null;
    sessionStartTime = null;
    pausedCount = 0;
    currentSessionId = null;
  } else {
    console.log('📺 Skipping session completion:', {
      isQualitySwitching: isQualitySwitching,
      hasSessionId: !!currentSessionId,
      hasStartTime: !!currentVideoStartTime
    });
  }
  
  if (!isQualitySwitching) {
    // Move to next video in playlist
    const oldIndex = currentIndex;
    currentIndex = (currentIndex + 1) % playlist.length;
    console.log(`🔄 Switching from video ${oldIndex + 1} (${playlist[oldIndex]}) to video ${currentIndex + 1} (${playlist[currentIndex]})`);
    console.log(`🔄 Next video URL: videos/${playlist[currentIndex]}.mp4`);
    
    // Track video completion for popup ads
    if (popupAdManager && typeof popupAdManager.onVideoEnded === 'function') {
      popupAdManager.onVideoEnded();
    }
    
    // Load the next video using the same method as initial load
    loadVideoWithQuality(currentIndex);
    
    // CRITICAL FIX: Start new session AND ad tracking together for next video
    if (authToken) {
      console.log('📺 Starting new session AND ad tracking for video:', playlist[currentIndex]);
      
      try {
        // Start new session
        const sessionId = await startWatchSession(playlist[currentIndex], "standard");
        
        if (sessionId) {
          currentSessionId = sessionId;
          currentVideoStartTime = Date.now();
          sessionStartTime = Date.now();
          pausedCount = 0;
          
          // IMMEDIATELY start ad tracking for the new video (don't wait for play event)
          const adTrackingId = await startAdTracking(sessionId);
          
          if (adTrackingId) {
            currentAdTrackingId = adTrackingId;
            isAdPlaying = true;
            adStartTime = Date.now();
            accumulatedAdTime = 0;
            
            console.log('✅ New session AND ad tracking started for next video:', {
              sessionId: sessionId,
              adTrackingId: adTrackingId,
              videoName: playlist[currentIndex],
              timestamp: new Date().toISOString()
            });
          } else {
            console.error('❌ Failed to start ad tracking for new video');
          }
        } else {
          console.error('❌ Failed to start new session - no sessionId returned');
        }
      } catch (error) {
        console.error('❌ Error starting new session/ad tracking:', error);
      }
    }
  } else {
    console.log('⚠️ Quality switching in progress, skipping video switch');
  }
});
```

---

## 📊 **Database Schema (Tables Used)**

### **1. watch_sessions Table**
```sql
CREATE TABLE IF NOT EXISTS watch_sessions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  video_name VARCHAR(255) NOT NULL,
  quality VARCHAR(50) DEFAULT 'standard',
  start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_time TIMESTAMP NULL,
  duration_seconds INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  paused_count INTEGER DEFAULT 0,
  user_ip INET,
  user_agent TEXT
);
```

### **2. ad_tracking Table**
```sql
CREATE TABLE IF NOT EXISTS ad_tracking (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  session_id INTEGER REFERENCES watch_sessions(id) ON DELETE CASCADE,
  ad_start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ad_end_time TIMESTAMP NULL,
  duration_seconds INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false
);
```

### **3. daily_stats Table**
```sql
CREATE TABLE IF NOT EXISTS daily_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  ads_watched INTEGER DEFAULT 0,
  total_watch_time_seconds INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 1,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, date)
);
```

### **4. users Table (Tracking Columns)**
```sql
-- Additional columns for tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS total_seconds_watched INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS current_month_seconds INTEGER DEFAULT 0;
```

---

## 🔄 **Complete Tracking Flow**

### **1. Video Start Flow:**
1. User clicks play → `player.on('play')` event
2. `startWatchSession()` called → Backend creates session
3. `startAdTracking()` called → Backend creates ad tracking record
4. Video plays with tracking active

### **2. Video End Flow:**
1. Video ends → `player.on('ended')` event
2. `completeAdTracking()` called → Updates ad_tracking, daily_stats, user watch time
3. `completeWatchSession()` called → Updates watch_sessions
4. New session and ad tracking started for next video

### **3. Session Conflict Flow:**
1. Desktop app active → Website blocked (409 response)
2. `checkForSessionConflicts()` called → Detects desktop session
3. Video paused, conflict message shown
4. Periodic monitoring until conflict resolves

### **4. Desktop App Precedence:**
1. Desktop app starts → Web sessions auto-closed
2. Web app starts → Blocked if desktop active
3. Desktop always wins in conflicts

---

## 📝 **Key Variables Used**

### **Frontend Variables:**
```javascript
let currentSessionId = null;           // Current session ID
let currentAdTrackingId = null;       // Current ad tracking ID
let isAdPlaying = false;              // Whether ad is currently playing
let adStartTime = null;               // When current ad started
let accumulatedAdTime = 0;            // Total time accumulated for current ad
let currentVideoStartTime = null;     // When current video started
let sessionStartTime = null;          // When current session started
let pausedCount = 0;                  // Number of times video was paused
let sessionConflictInterval = null;   // Interval for conflict monitoring
```

### **Backend Variables:**
```javascript
const getPool = require('./database-postgres.js').getPool;  // Database connection
const dbHelpers = require('./database-postgres.js').dbHelpers;  // Database helper functions
```

---

## 🎯 **API Endpoints Summary**

| Method | Endpoint | Purpose | Response |
|--------|----------|---------|----------|
| `POST` | `/api/tracking/start-session` | Start new watch session | `{sessionId, message}` or `409` conflict |
| `GET` | `/api/tracking/session-status` | Check for session conflicts | `{hasDesktopSession, conflictDetected, ...}` |
| `POST` | `/api/tracking/complete-session` | Complete watch session | `{message, sessionId, durationSeconds}` |
| `POST` | `/api/tracking/start-ad` | Start ad tracking | `{adTrackingId, message}` |
| `POST` | `/api/tracking/complete-ad` | Complete ad tracking | `{message, durationSeconds}` |

---

This is the complete session tracking system for your CharityStream project! 🚀

