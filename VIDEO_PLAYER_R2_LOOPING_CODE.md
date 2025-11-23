# Video Player R2 Fetching & Looping Code

This document contains all code related to fetching videos from Cloudflare R2 and looping them in the video player.

---

## PART 1: BACKEND - Fetching Videos from R2

### File: `backend/server.js` (lines ~4200-4300)

```javascript
// Get all active videos for looping
// DYNAMIC: Scans charity-stream-videos R2 bucket for all video_X.mp4 files
// Server-side caching for playlist data
const playlistCache = new Map();
const PLAYLIST_CACHE_TTL = 120000; // 2 minutes

app.get('/api/videos/playlist', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const cacheKey = 'playlist_all';
    const now = Date.now();
    
    // Check cache first
    const cached = playlistCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < PLAYLIST_CACHE_TTL) {
      console.log(`📊 Returning cached playlist data`);
      return res.json(cached.data);
    }
    
    const R2_BUCKET_URL = 'https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev';
    const CHARITY_BUCKET = 'charity-stream-videos';
    
    // List all video_X.mp4 files from R2 bucket
    const listCommand = new ListObjectsV2Command({
      Bucket: CHARITY_BUCKET
    });
    
    const response = await r2Client.send(listCommand);
    const allFiles = response.Contents || [];
    
    // Filter for video_X.mp4 pattern and sort numerically
    const videoFiles = allFiles
      .filter(file => /^video_\d+\.mp4$/.test(file.Key))
      .map(file => {
        const match = file.Key.match(/^video_(\d+)\.mp4$/);
        return {
          filename: file.Key,
          number: parseInt(match[1]),
          size: file.Size
        };
      })
      .sort((a, b) => a.number - b.number);
    
    // Get advertiser mappings for videos with video_filename
    const pool = getPool();
    let advertiserMap = new Map();
    
    if (pool) {
      try {
        const advertiserResult = await pool.query(`
          SELECT id, video_filename, approved, completed
          FROM advertisers
          WHERE video_filename IS NOT NULL
            AND approved = true
            AND completed = true
        `);
        
        // Build map: video_filename -> advertiser_id
        advertiserResult.rows.forEach(ad => {
          advertiserMap.set(ad.video_filename, ad.id);
        });
        
        console.log(`📊 Found ${advertiserMap.size} advertisers with video_filename`);
      } catch (adError) {
        console.error('⚠️ Error fetching advertiser mappings (non-critical):', adError.message);
        // Continue without advertiser data - old videos will work fine
      }
    }
    
    // Build playlist with advertiser info
    const playlist = videoFiles.map(video => {
      const advertiserId = advertiserMap.get(video.filename) || null;
      const videoFilename = advertiserId ? video.filename : null;
      
      return {
        videoId: video.number,
        title: video.filename.replace('.mp4', ''),
        videoUrl: `${R2_BUCKET_URL}/${video.filename}`,
        duration: 60,
        advertiserId: advertiserId,
        videoFilename: videoFilename
      };
    });
    
    const playlistData = {
      videos: playlist
    };
    
    // Cache the result
    playlistCache.set(cacheKey, {
      data: playlistData,
      timestamp: now
    });
    
    // Clean up old cache entries
    for (const [key, value] of playlistCache.entries()) {
      if (now - value.timestamp > PLAYLIST_CACHE_TTL) {
        playlistCache.delete(key);
      }
    }
    
    console.log(`✅ Dynamically serving playlist: ${playlist.length} videos from R2 bucket`);
    console.log(`   Videos: ${videoFiles.map(v => v.filename).join(', ')}`);
    
    res.json(playlistData);
  } catch (error) {
    console.error('❌ Error fetching playlist:', error);
    
    // Fallback to static playlist if R2 listing fails
    const R2_BUCKET_URL = 'https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev';
    const fallbackPlaylist = [
      { videoId: 1, title: 'video_1', videoUrl: `${R2_BUCKET_URL}/video_1.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 2, title: 'video_2', videoUrl: `${R2_BUCKET_URL}/video_2.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 3, title: 'video_3', videoUrl: `${R2_BUCKET_URL}/video_3.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 4, title: 'video_4', videoUrl: `${R2_BUCKET_URL}/video_4.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 5, title: 'video_5', videoUrl: `${R2_BUCKET_URL}/video_5.mp4`, duration: 60, advertiserId: null, videoFilename: null },
      { videoId: 6, title: 'video_6', videoUrl: `${R2_BUCKET_URL}/video_6.mp4`, duration: 60, advertiserId: null, videoFilename: null }
    ];
    
    console.log('⚠️ Using fallback playlist (6 videos)');
    res.json({ videos: fallbackPlaylist });
  }
});
```

**Key Points:**
- Uses `ListObjectsV2Command` to scan R2 bucket `charity-stream-videos`
- Filters for files matching pattern `video_\d+\.mp4`
- Sorts videos numerically (video_1, video_2, etc.)
- Caches results for 2 minutes to reduce R2 API calls
- Includes advertiser info for impression tracking
- Falls back to static playlist if R2 scan fails

---

## PART 2: FRONTEND - Fetching Playlist from Backend

### File: `public/index.html` (lines ~3348-3396)

```javascript
// DYNAMIC PLAYLIST FROM BACKEND
let playlist = [];
let playlistData = []; // Full playlist data with advertiser info
let videoUrls = {}; // Map video names to R2 URLs
let currentIndex = 0;

// Fetch playlist from backend dynamically
async function initializePlaylist() {
  try {
    console.log('🔄 Fetching dynamic playlist from backend...');
    const response = await trackedFetch('/api/videos/playlist', {
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });
    const data = await response.json();
    
    // Store full playlist data (includes advertiserId and videoFilename)
    playlistData = data.videos;
    
    // Extract video names and URLs from backend response
    playlist = data.videos.map(video => {
      const videoName = video.title; // e.g., "video_1"
      videoUrls[videoName] = video.videoUrl; // Store the full R2 URL
      return videoName;
    });
    
    console.log('✅ Dynamic playlist loaded from R2:', playlist);
    console.log('✅ Video URLs mapped:', videoUrls);
    console.log('✅ Playlist data with advertiser info:', playlistData);
    
    return true;
  } catch (error) {
    console.error('❌ Failed to load dynamic playlist, using fallback:', error);
    // Fallback to hardcoded playlist
    playlist = ['video_1', 'video_2', 'video_3', 'video_4', 'video_5'];
    playlistData = playlist.map((name, index) => ({
      videoId: index + 1,
      title: name,
      videoUrl: `https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev/${name}.mp4`,
      duration: 60,
      advertiserId: null,
      videoFilename: null
    }));
    
    // Initialize fallback URLs for hardcoded playlist
    playlist.forEach(videoName => {
      videoUrls[videoName] = `https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev/${videoName}.mp4`;
    });
    
    console.log('⚠️ Using fallback playlist:', playlist);
    return false;
  }
}
```

**Key Points:**
- Calls `/api/videos/playlist` endpoint
- Stores both simplified `playlist` array and full `playlistData` array
- Maps video names to R2 URLs
- Falls back to hardcoded playlist if API fails

---

## PART 3: FRONTEND - Loading Videos from R2

### File: `public/index.html` (lines ~3398-3478)

```javascript
function getVideoUrl(videoName) {
  // Use direct R2 URLs for better performance and reliability
  const R2_BASE_URL = 'https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev';
  const directUrl = `${R2_BASE_URL}/${videoName}.mp4`;
  
  console.log(`🎬 Using direct R2 URL for video: ${videoName}`);
  console.log(`🎬 Direct URL: ${directUrl}`);
  
  return directUrl;
}

function getCurrentVideoSource() {
  const videoName = playlist[currentIndex];
  return {
    src: getVideoUrl(videoName),
    type: "video/mp4"
  };
}

function loadVideoWithQuality(index) {
  if (index >= playlist.length) {
    console.log(`⚠️ Index ${index} is out of bounds for playlist length ${playlist.length}`);
    return;
  }
  
  console.log(`🎬 loadVideoWithQuality called with index: ${index}`);
  console.log(`🎬 Current playlist:`, playlist);
  
  currentIndex = index;
  
  // Reset impression flag when loading new video
  hasSentImpression = false;
  
  const source = getCurrentVideoSource();
  console.log(`🎬 Loading video ${index + 1} (${playlist[index]}): ${source.src}`);
  
  // Load the video
  player.src(source);
  updateQualityDisplay();
  
  // Fetch advertiser info for this video
  const videoFilename = `${playlist[index]}.mp4`;
  onVideoChanged(videoFilename);
  
  player.one('loadeddata', () => {
    console.log('✅ Video loaded successfully');
    
    // Auto-play when video loads (both initial and subsequent videos)
    setTimeout(() => {
      if (window.isTutorialActive) {
        console.log('⏸ Video auto-play blocked until tutorial dismissed');
      } else {
        // Check if this is a new user who hasn't manually started playback yet
        const isNewUser = localStorage.getItem('charityStream_newUser') === 'true';
        const hasUserStartedPlayback = localStorage.getItem('charityStream_userStartedPlayback') === 'true';
        
        if (isNewUser && !hasUserStartedPlayback) {
          console.log('⏸ New user - video stays paused until user clicks play');
        } else {
          console.log('🎬 Attempting to auto-play video...');
          player.play().catch(error => {
            console.log('Auto-play prevented:', error);
          });
        }
      }
    }, 100);
    
    // Mark initial load as complete
    if (isInitialLoad) {
      isInitialLoad = false;
    }
  });
  
  console.log('🎬 Video player initialized - session will start when user plays video');
}
```

**Key Points:**
- Constructs direct R2 URLs: `https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev/video_X.mp4`
- Uses Video.js `player.src()` to load video
- Auto-plays after loading (unless blocked by tutorial/new user)
- Resets impression tracking flag for new video

---

## PART 4: FRONTEND - Video Looping Logic

### File: `public/index.html` (lines ~3739-3853)

```javascript
// Video ended event - completes ad tracking and session
player.on("ended", async function () {
  const now = Date.now();
  if (now - lastEndedEvent < ENDED_EVENT_DEBOUNCE) {
    return; // Skip duplicate ended events
  }
  lastEndedEvent = now;
  
  console.log(`🎬 Video ${currentIndex + 1} (${playlist[currentIndex]}) ended, switching to next video...`);
  console.log(`🎬 Current player state:`, {
    readyState: player.readyState(),
    paused: player.paused(),
    ended: player.ended(),
    currentSrc: player.currentSrc()
  });
  
  // Complete ad tracking if ad was playing (only when video actually ends)
  if (currentAdTrackingId) {
    // ... ad tracking completion code ...
    await completeAdTracking(trackingIdToComplete, adDurationSeconds, true);
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
    }
    
    currentVideoStartTime = null;
    sessionStartTime = null;
    pausedCount = 0;
    currentSessionId = null;
  }
  
  if (!isQualitySwitching) {
    // Move to next video in playlist
    const oldIndex = currentIndex;
    currentIndex = (currentIndex + 1) % playlist.length;  // ← LOOPING LOGIC
    console.log(`🔄 Switching from video ${oldIndex + 1} (${playlist[oldIndex]}) to video ${currentIndex + 1} (${playlist[currentIndex]})`);
    console.log(`🔄 Next video URL: videos/${playlist[currentIndex]}.mp4`);
    
    // Track video completion for popup ads
    if (popupAdManager && typeof popupAdManager.onVideoEnded === 'function') {
      popupAdManager.onVideoEnded();
    }
    
    // Load the next video using the same method as initial load
    loadVideoWithQuality(currentIndex);  // ← LOADS NEXT VIDEO
    
    // No automatic session start - wait for user to click play to start session
    console.log('📺 Video loaded - waiting for user to click play to start session');
  } else {
    console.log('⚠️ Quality switching in progress, skipping video switch');
  }
});
```

**Key Points:**
- Listens for `player.on("ended")` event
- Uses modulo operator `(currentIndex + 1) % playlist.length` to loop back to start
- Calls `loadVideoWithQuality(currentIndex)` to load next video
- Completes tracking and session before switching
- Handles edge cases (quality switching, duplicate events)

---

## PART 5: FRONTEND - Initial Playlist Initialization

### File: `public/index.html` (lines ~3950-3970)

```javascript
// Initialize playlist and load first video
initializePlaylist().then(() => {
  loadVideoWithQuality(0);  // Load first video (index 0)
});
```

**Key Points:**
- Calls `initializePlaylist()` to fetch from backend
- Once playlist is loaded, calls `loadVideoWithQuality(0)` to start with first video
- Videos then loop automatically when each one ends

---

## COMPLETE FLOW DIAGRAM

```
1. User loads page
   ↓
2. Frontend calls initializePlaylist()
   ↓
3. Frontend fetches GET /api/videos/playlist
   ↓
4. Backend scans R2 bucket (charity-stream-videos)
   ↓
5. Backend filters video_X.mp4 files, sorts numerically
   ↓
6. Backend returns playlist with R2 URLs
   ↓
7. Frontend stores playlist array
   ↓
8. Frontend calls loadVideoWithQuality(0) - loads first video
   ↓
9. Video loads from R2 URL: https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev/video_1.mp4
   ↓
10. Video plays
    ↓
11. Video ends → player.on("ended") fires
    ↓
12. currentIndex = (currentIndex + 1) % playlist.length
    ↓
13. loadVideoWithQuality(currentIndex) - loads next video
    ↓
14. Loop continues (back to step 9)
```

---

## R2 CONFIGURATION

### Backend R2 Client Setup (from server.js)

```javascript
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '9eeb17f20eafece615e6b3520faf05c0',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4'
  }
});
```

### R2 Bucket URLs

- **Bucket Name:** `charity-stream-videos`
- **Public URL:** `https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev`
- **Video Pattern:** `video_X.mp4` (e.g., `video_1.mp4`, `video_2.mp4`)

---

## KEY FUNCTIONS SUMMARY

### Backend:
- `GET /api/videos/playlist` - Scans R2 bucket, returns playlist with R2 URLs

### Frontend:
- `initializePlaylist()` - Fetches playlist from backend API
- `getVideoUrl(videoName)` - Constructs R2 URL for a video
- `loadVideoWithQuality(index)` - Loads a specific video from R2
- `player.on("ended")` - Handles video end, loops to next video

---

## LOOPING MECHANISM

The looping is achieved through:

1. **Modulo operator:** `currentIndex = (currentIndex + 1) % playlist.length`
   - When `currentIndex` reaches `playlist.length`, it wraps to 0
   - Example: If playlist has 5 videos (0-4), after video 4 ends, it goes to video 0

2. **Automatic loading:** When video ends, `loadVideoWithQuality(currentIndex)` is called
   - This loads the next video from R2
   - Video auto-plays (unless blocked)
   - Process repeats when that video ends

3. **Infinite loop:** Videos continue looping until user leaves page or pauses

---

## ERROR HANDLING

- **R2 scan fails:** Falls back to static playlist
- **Video load fails:** Error logged, player continues
- **Network errors:** Cached playlist used if available
- **Missing videos:** Skips to next video in playlist

