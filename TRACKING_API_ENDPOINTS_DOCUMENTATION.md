# 📊 Tracking API Endpoints Documentation

## 1. 🎯 All Tracking Endpoints

### **Session Tracking Endpoints**

#### **Start Watching Session**
```http
POST /api/tracking/start-session
```

**Headers:**
- `Authorization: Bearer YOUR_JWT_TOKEN` (Required)
- `Content-Type: application/json` (Required)

**Request Body:**
```json
{
  "videoName": "video_1",
  "quality": "standard"
}
```

**Response (200):**
```json
{
  "sessionId": 123,
  "message": "Session started"
}
```

**Database Updates:**
- **Table:** `watch_sessions`
- **Columns:** `user_id`, `video_name`, `quality`, `start_time`, `user_ip`, `user_agent`

---

#### **Complete Watching Session**
```http
POST /api/tracking/complete-session
```

**Headers:**
- `Authorization: Bearer YOUR_JWT_TOKEN` (Required)
- `Content-Type: application/json` (Required)

**Request Body:**
```json
{
  "sessionId": 123,
  "durationSeconds": 180,
  "completed": true,
  "pausedCount": 2
}
```

**Response (200):**
```json
{
  "message": "Session completed",
  "minutesWatched": 3
}
```

**Database Updates:**
- **Table:** `watch_sessions`
- **Columns:** `end_time`, `duration_seconds`, `completed`, `paused_count`

---

### **Ad Tracking Endpoints**

#### **Start Ad Tracking**
```http
POST /api/tracking/start-ad
```

**Headers:**
- `Authorization: Bearer YOUR_JWT_TOKEN` (Required)
- `Content-Type: application/json` (Required)

**Request Body:**
```json
{
  "sessionId": 123
}
```

**Response (200):**
```json
{
  "adTrackingId": 456,
  "message": "Ad tracking started"
}
```

**Database Updates:**
- **Table:** `ad_tracking`
- **Columns:** `user_id`, `session_id`, `ad_start_time`

---

#### **Complete Ad Tracking**
```http
POST /api/tracking/complete-ad
```

**Headers:**
- `Authorization: Bearer YOUR_JWT_TOKEN` (Required)
- `Content-Type: application/json` (Required)

**Request Body:**
```json
{
  "adTrackingId": 456,
  "durationSeconds": 120,
  "completed": true
}
```

**Response (200):**
```json
{
  "message": "Ad tracking completed",
  "durationSeconds": 120
}
```

**Database Updates:**
- **Table:** `ad_tracking` → `ad_end_time`, `duration_seconds`, `completed`
- **Table:** `daily_stats` → `ads_watched`, `total_watch_time_seconds`
- **Table:** `users` → `total_seconds_watched`, `current_month_seconds`

---

### **User Impact & Analytics Endpoints**

#### **Get User Impact Data**
```http
GET /api/user/impact
```

**Headers:**
- `Authorization: Bearer YOUR_JWT_TOKEN` (Required)

**Response (200):**
```json
{
  "impact": {
    "adsWatchedToday": 15,
    "totalAdsWatched": 450,
    "currentRank": 3,
    "overallRank": 12,
    "totalUsers": 1250,
    "watchTimeMinutes": 180,
    "totalWatchTimeMinutes": 5400,
    "streakDays": 7,
    "accountAgeDays": 45,
    "donationsGenerated": 4.50
  }
}
```

---

#### **Get Monthly Leaderboard**
```http
GET /api/leaderboard/monthly
```

**Headers:** None required

**Response (200):**
```json
[
  {
    "id": 1,
    "username": "topuser",
    "current_month_minutes": 360,
    "current_month_seconds": 21600,
    "profile_picture": "https://example.com/avatar.jpg",
    "ads_watched_today": 25,
    "rank": 1
  }
]
```

---

#### **Get User's Rank**
```http
GET /api/leaderboard/my-rank
```

**Headers:**
- `Authorization: Bearer YOUR_JWT_TOKEN` (Required)

**Response (200):**
```json
{
  "monthlyRank": 5,
  "totalUsers": 1250,
  "currentMonthMinutes": 120
}
```

---

## 2. ⏱️ Time Accumulation Logic

### **How Watch Time Accumulates:**

#### **Database Columns:**
- `total_seconds_watched` - Cumulative seconds across all time
- `current_month_seconds` - Seconds in current calendar month
- `total_minutes_watched` - Total minutes (calculated from seconds)
- `current_month_minutes` - Current month minutes (calculated from seconds)

#### **Accumulation Process:**
1. **Per-Ad Completion:** When an ad completes (`/api/tracking/complete-ad`), seconds are added directly
2. **Automatic Calculation:** Minutes are calculated as `Math.floor(seconds / 60)`
3. **No Rollover Logic:** System tracks raw seconds, minutes are derived values
4. **Monthly Reset:** `current_month_seconds` resets at calendar month boundary

#### **Example:**
```
User watches: 56 seconds + 20 seconds + 45 seconds = 121 seconds total
Minutes calculation: Math.floor(121 / 60) = 2 minutes
Remainder: 121 % 60 = 1 second carried forward
```

#### **Database Helper Function:**
```javascript
updateWatchSeconds: async (userId, secondsWatched) => {
  const result = await pool.query(
    `UPDATE users 
     SET total_seconds_watched = total_seconds_watched + $2,
         current_month_seconds = current_month_seconds + $2
     WHERE id = $1 
     RETURNING *`,
    [userId, secondsWatched]
  );
  return [null, result.rows[0]];
}
```

---

## 3. 🗄️ Database Schema for Tracking

### **Users Table**
```sql
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(255),
  email VARCHAR(255) UNIQUE NOT NULL,
  -- Time Tracking Columns:
  total_minutes_watched INTEGER DEFAULT 0,
  current_month_minutes INTEGER DEFAULT 0,
  total_seconds_watched INTEGER DEFAULT 0,
  current_month_seconds INTEGER DEFAULT 0,
  -- Other columns...
)
```

### **Watch Sessions Table**
```sql
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
)
```

### **Ad Tracking Table**
```sql
CREATE TABLE ad_tracking (
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

### **Daily Stats Table**
```sql
CREATE TABLE daily_stats (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),
  date DATE NOT NULL,
  ads_watched INTEGER DEFAULT 0,
  total_watch_time_seconds INTEGER DEFAULT 0,
  streak_days INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id, date)
)
```

---

## 4. 📋 Complete Request/Response Examples

### **Complete Tracking Flow Example:**

#### **1. Start Session**
```bash
curl -X POST "http://localhost:3001/api/tracking/start-session" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d '{
    "videoName": "video_1",
    "quality": "standard"
  }'
```

**Response:**
```json
{
  "sessionId": 123,
  "message": "Session started"
}
```

#### **2. Start Ad Tracking**
```bash
curl -X POST "http://localhost:3001/api/tracking/start-ad" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d '{
    "sessionId": 123
  }'
```

**Response:**
```json
{
  "adTrackingId": 456,
  "message": "Ad tracking started"
}
```

#### **3. Complete Ad Tracking**
```bash
curl -X POST "http://localhost:3001/api/tracking/complete-ad" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d '{
    "adTrackingId": 456,
    "durationSeconds": 120,
    "completed": true
  }'
```

**Response:**
```json
{
  "message": "Ad tracking completed",
  "durationSeconds": 120
}
```

#### **4. Complete Session**
```bash
curl -X POST "http://localhost:3001/api/tracking/complete-session" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." \
  -d '{
    "sessionId": 123,
    "durationSeconds": 120,
    "completed": true,
    "pausedCount": 0
  }'
```

**Response:**
```json
{
  "message": "Session completed",
  "minutesWatched": 2
}
```

#### **5. Get User Impact**
```bash
curl -X GET "http://localhost:3001/api/user/impact" \
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
```

**Response:**
```json
{
  "impact": {
    "adsWatchedToday": 5,
    "totalAdsWatched": 150,
    "currentRank": 3,
    "overallRank": 12,
    "totalUsers": 1250,
    "watchTimeMinutes": 120,
    "totalWatchTimeMinutes": 3600,
    "streakDays": 3,
    "accountAgeDays": 30,
    "donationsGenerated": 1.50
  }
}
```

---

## 5. 🔄 Tracking Flow Summary

### **Complete Video Tracking Flow:**

#### **When Video Starts:**
1. Call `POST /api/tracking/start-session` with `videoName` and `quality`
2. Store returned `sessionId` for later use
3. Call `POST /api/tracking/start-ad` with the `sessionId`
4. Store returned `adTrackingId` for later use

#### **While Video Plays:**
- **No periodic updates needed** - tracking is event-based only
- Video player should track actual playback time (exclude buffering/loading)

#### **When Video Pauses:**
- **No API call needed** - just pause your internal timer
- Resume tracking when video resumes

#### **When Video Ends:**
1. Call `POST /api/tracking/complete-ad` with:
   - `adTrackingId` from step 3
   - `durationSeconds` (actual video playback time)
   - `completed: true`
2. Call `POST /api/tracking/complete-session` with:
   - `sessionId` from step 1
   - `durationSeconds` (same as above)
   - `completed: true`
   - `pausedCount` (number of times video was paused)

#### **How "Ads Watched" Increments:**
- **Automatic:** Each completed ad tracking call increments `ads_watched` in `daily_stats`
- **Trigger:** When `completed: true` in `/api/tracking/complete-ad`
- **Update:** `daily_stats.ads_watched = ads_watched + 1`

#### **How Watch Time Accumulates:**
- **Per-Ad Basis:** Each completed ad adds seconds to user totals
- **Automatic:** Seconds are added to both `total_seconds_watched` and `current_month_seconds`
- **Minutes Calculation:** `Math.floor(seconds / 60)` for display purposes
- **No Manual Calculation:** Database handles all accumulation

### **Key Points for Desktop App:**
1. **Always use actual video playback time** (exclude loading/buffering)
2. **Track sessions and ads separately** - they serve different purposes
3. **No periodic updates needed** - only call APIs on start/end events
4. **Handle network failures gracefully** - tracking should be resilient
5. **Store session/ad IDs** - needed for completion calls

### **Error Handling:**
- All endpoints return appropriate HTTP status codes
- Include error details in response body
- Network timeouts should be handled gracefully
- Failed tracking calls shouldn't break video playback

This documentation provides everything needed to implement identical tracking behavior in your desktop app! 🎉

