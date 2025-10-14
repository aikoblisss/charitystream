# Video Looping, Ad Tracking, and User Ranking Systems

## 🎬 **Video Looping System**

### **How It Works:**
The video player creates an infinite loop by cycling through a predefined playlist of videos.

### **Key Components:**

#### **1. Playlist Generation:**
```javascript
function generatePlaylist() {
  // IMPORTANT: Update this array when you add/remove videos
  // Current videos: video_1.mp4, video_2.mp4, video_3.mp4, video_4.mp4
  // To add more: just add 'video_5', 'video_6', etc. to this array
  // To remove: remove the corresponding entries from this array
  return ['video_1', 'video_2', 'video_3', 'video_4', 'video_5'];
}
```

#### **2. Video Switching Logic:**
```javascript
// Video ended event - completes ad tracking and session
player.on("ended", async function () {
  console.log(`🎬 Video ${currentIndex + 1} (${playlist[currentIndex]}) ended, switching to next video...`);
  
  // Complete ad tracking and session for current video
  if (isAdPlaying && currentAdTrackingId && adStartTime) {
    const currentTime = player.currentTime() || 0;
    const adDurationSeconds = Math.floor(Math.max(currentTime, accumulatedAdTime));
    await completeAdTracking(currentAdTrackingId, adDurationSeconds, true);
    
    // Reset ad tracking state
    isAdPlaying = false;
    currentAdTrackingId = null;
    adStartTime = null;
    accumulatedAdTime = 0;
  }
  
  // Complete current session
  if (currentSessionId && currentVideoStartTime) {
    const durationSeconds = Math.floor((Date.now() - currentVideoStartTime) / 1000);
    await completeWatchSession(currentSessionId, durationSeconds, true, pausedCount);
  }
  
  // Move to next video in playlist (infinite loop)
  const oldIndex = currentIndex;
  currentIndex = (currentIndex + 1) % playlist.length; // Modulo for infinite loop
  console.log(`🔄 Switching from video ${oldIndex + 1} to video ${currentIndex + 1}`);
  
  // Load the next video
  loadVideoWithQuality(currentIndex);
  
  // Start new session AND ad tracking for next video
  if (authToken) {
    const sessionId = await startWatchSession(playlist[currentIndex], "standard");
    if (sessionId) {
      currentSessionId = sessionId;
      currentVideoStartTime = Date.now();
      
      // IMMEDIATELY start ad tracking for the new video
      const adTrackingId = await startAdTracking(sessionId);
      if (adTrackingId) {
        currentAdTrackingId = adTrackingId;
        isAdPlaying = true;
        adStartTime = Date.now();
        accumulatedAdTime = 0;
      }
    }
  }
});
```

#### **3. Video Loading:**
```javascript
function loadVideoWithQuality(index) {
  if (index >= playlist.length) return;
  
  currentIndex = index;
  const source = getCurrentVideoSource();
  console.log(`🎬 Loading video ${index + 1} (${playlist[index]}): ${source.src}`);
  
  player.src(source);
  player.load();
}
```

---

## 📊 **Ad Tracking System**

### **How It Works:**
Tracks when users watch ads (videos) and measures actual viewing time, excluding buffering and loading time.

### **Key Components:**

#### **1. Ad Tracking Start:**
```javascript
// Video play event - starts ad tracking ONLY if not already tracking
player.on('play', function() {
  isPlaying = true;
  
  // Only start ad tracking if we don't already have an active tracking session
  if (currentSessionId && !isAdPlaying && !currentAdTrackingId) {
    isAdPlaying = true;
    adStartTime = Date.now();
    startAdTracking(currentSessionId).then(adTrackingId => {
      if (adTrackingId) {
        currentAdTrackingId = adTrackingId;
        console.log('📺 Ad tracking started for manual play');
      }
    });
  }
});
```

#### **2. Ad Tracking Completion:**
```javascript
// When video ends, complete ad tracking with actual video time
if (isAdPlaying && currentAdTrackingId && adStartTime) {
  // Use the video's current time for accurate tracking (excludes loading/buffering time)
  const currentTime = player.currentTime() || 0;
  const adDurationSeconds = Math.floor(Math.max(currentTime, accumulatedAdTime));
  
  await completeAdTracking(currentAdTrackingId, adDurationSeconds, true);
  
  // Reset ad tracking state
  isAdPlaying = false;
  currentAdTrackingId = null;
  adStartTime = null;
  accumulatedAdTime = 0;
}
```

#### **3. Backend Ad Tracking Functions:**
```javascript
// Start tracking an ad
startAdTracking: async (userId, sessionId) => {
  try {
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
    const result = await pool.query(
      'UPDATE ad_tracking SET ad_end_time = CURRENT_TIMESTAMP, duration_seconds = $2, completed = $3 WHERE id = $1 RETURNING *',
      [adTrackingId, durationSeconds, completed]
    );
    return [null, result.rows[0]];
  } catch (error) {
    return [error, null];
  }
}
```

---

## ⏱️ **Minutes Watched Tracking**

### **How It Works:**
Tracks total watch time in both minutes and seconds, with separate counters for current month.

### **Key Components:**

#### **1. Watch Session Tracking:**
```javascript
// Start watching session
async function startWatchSession(videoName, quality) {
  if (!authToken) return null;
  
  try {
    const response = await fetch('/api/tracking/start-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ videoName, quality })
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('📺 Watch session started:', data.sessionId);
      return data.sessionId;
    }
  } catch (error) {
    console.error('Error starting watch session:', error);
  }
  return null;
}

// Complete watching session
async function completeWatchSession(sessionId, durationSeconds, completed, pausedCount) {
  if (!authToken || !sessionId) return;
  
  try {
    const response = await fetch('/api/tracking/complete-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${authToken}` },
      body: JSON.stringify({ sessionId, durationSeconds, completed, pausedCount: pausedCount || 0 })
    });
    
    if (response.ok) {
      const data = await response.json();
      console.log('📺 Session completed successfully:', data);
    }
  } catch (error) {
    console.error('Error completing session:', error);
  }
}
```

#### **2. Backend Session Tracking:**
```javascript
// Start watching session
app.post('/api/tracking/start-session', authenticateToken, async (req, res) => {
  try {
    const { videoName, quality } = req.body;
    const userId = req.user.userId;
    
    const [err, sessionId] = await dbHelpers.createWatchSession({
      userId,
      videoName,
      quality,
      userIP: req.ip,
      userAgent: req.get('User-Agent')
    });
    
    if (err) {
      return res.status(500).json({ error: 'Failed to start session' });
    }
    
    res.json({ sessionId, message: 'Session started' });
  } catch (error) {
    console.error('Error in start-session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Complete watching session
app.post('/api/tracking/complete-session', authenticateToken, async (req, res) => {
  try {
    const { sessionId, durationSeconds, completed, pausedCount } = req.body;
    
    const [err, session] = await dbHelpers.updateWatchSession(sessionId, {
      end_time: new Date(),
      duration_seconds: durationSeconds,
      completed: completed,
      paused_count: pausedCount
    });
    
    if (err) {
      return res.status(500).json({ error: 'Failed to complete session' });
    }
    
    // Update user's total watch time
    const minutesWatched = Math.floor(durationSeconds / 60);
    await dbHelpers.updateWatchTime(req.user.userId, minutesWatched);
    
    res.json({ 
      sessionId, 
      durationSeconds, 
      minutesWatched,
      message: 'Session completed' 
    });
  } catch (error) {
    console.error('Error in complete-session:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});
```

#### **3. Database Schema:**
```sql
-- Users table tracks total and monthly watch time
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  total_minutes_watched INTEGER DEFAULT 0,
  current_month_minutes INTEGER DEFAULT 0,
  total_seconds_watched INTEGER DEFAULT 0,
  current_month_seconds INTEGER DEFAULT 0,
  -- ... other fields
);

-- Watch sessions table tracks individual viewing sessions
CREATE TABLE watch_sessions (
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
  user_agent TEXT
);
```

---

## 🏆 **User Ranking System**

### **How It Works:**
Ranks users based on their current month watch time and displays a leaderboard.

### **Key Components:**

#### **1. Leaderboard Query:**
```javascript
// Get monthly leaderboard (top 5 users by current month minutes)
getMonthlyLeaderboard: async (limit = 5) => {
  try {
    const result = await pool.query(
      `SELECT 
        u.id,
        u.username,
        FLOOR(u.current_month_seconds::numeric / 60) AS current_month_minutes,
        u.current_month_seconds,
        u.profile_picture,
        u.created_at,
        COALESCE(ds.ads_watched, 0) as ads_watched_today,
        0 as streak_days,
        ROW_NUMBER() OVER (
          ORDER BY u.current_month_seconds DESC, 
          u.id ASC
        ) as rank_number
      FROM users u
      LEFT JOIN daily_stats ds ON u.id = ds.user_id AND ds.date = CURRENT_DATE
      WHERE u.is_active = true 
        AND u.current_month_seconds >= 60
      ORDER BY u.current_month_seconds DESC, u.id ASC
      LIMIT $1`,
      [limit]
    );
    
    return [null, result.rows];
  } catch (error) {
    return [error, null];
  }
}
```

#### **2. User Rank Calculation:**
```javascript
// Get user's rank in monthly leaderboard
getUserMonthlyRank: async (userId) => {
  try {
    const result = await pool.query(
      `SELECT COUNT(*) + 1 as rank
       FROM users 
       WHERE current_month_seconds > (
         SELECT current_month_seconds 
         FROM users 
         WHERE id = $1
       ) AND is_active = true`,
      [userId]
    );
    
    return [null, parseInt(result.rows[0]?.rank || 1)];
  } catch (error) {
    return [error, 1];
  }
}
```

#### **3. Frontend Leaderboard Display:**
```javascript
// Load leaderboard data
async function loadLeaderboard() {
  try {
    const response = await fetch('/api/leaderboard/monthly');
    if (response.ok) {
      const leaderboard = await response.json();
      
      // Display leaderboard
      const leaderboardContainer = document.getElementById('leaderboardList');
      if (leaderboardContainer) {
        leaderboardContainer.innerHTML = '';
        
        leaderboard.forEach((user, index) => {
          const item = document.createElement('li');
          item.className = 'leaderboard-item';
          item.innerHTML = `
            <div class="leaderboard-left">
              <span class="rank">#${user.rank}</span>
              <span class="username">${user.username}</span>
            </div>
            <span class="minutes">${user.minutesWatched} mins</span>
          `;
          leaderboardContainer.appendChild(item);
        });
      }
    }
  } catch (error) {
    console.error('Error loading leaderboard:', error);
  }
}
```

#### **4. Daily Stats Tracking:**
```javascript
// Update daily stats for a user
updateDailyStats: async (userId, adsWatched = 1, watchTimeSeconds = 0) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    
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
      return [null, updateResult.rows[0]];
    }

    // If no existing record, create new one
    const insertResult = await pool.query(
      `INSERT INTO daily_stats (user_id, date, ads_watched, total_watch_time_seconds, streak_days)
       VALUES ($1, $2, $3, $4, 1)
       RETURNING *`,
      [userId, today, adsWatched, watchTimeSeconds]
    );

    return [null, insertResult.rows[0]];
  } catch (error) {
    return [error, null];
  }
}
```

---

## 🔄 **Complete Flow Summary**

1. **Video Starts** → Session tracking begins → Ad tracking starts
2. **Video Plays** → Actual video time tracked (excludes buffering)
3. **Video Pauses** → Tracking pauses but doesn't complete
4. **Video Ends** → Ad tracking completes with actual video time → Session completes → Next video loads
5. **New Video Loads** → New session starts → New ad tracking begins
6. **Daily Stats Updated** → Ads watched incremented → Watch time added
7. **Leaderboard Updated** → Users ranked by current month watch time

This creates a comprehensive tracking system that accurately measures user engagement while providing competitive rankings! 🎉
