# R2 Bucket Connection & Video Looping Code - Website

This document contains all the code related to Cloudflare R2 bucket connections and video looping for the website.

---

## 1. R2 CLIENT CONFIGURATION (server.js)

### Location: `charitystream/backend/server.js` (Lines 1783-1795)

```javascript
// ===== CLOUDFLARE R2 CONFIGURATION =====

// Configure Cloudflare R2 (S3-compatible)
const { ListObjectsV2Command } = require('@aws-sdk/client-s3');

const r2Client = new S3Client({
  region: 'auto',
  endpoint: 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '9eeb17f20eafece615e6b3520faf05c0',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4'
  }
});
```

**Key Details:**
- Uses AWS S3 SDK for Cloudflare R2 compatibility
- Endpoint: Cloudflare R2 storage endpoint
- Credentials: Access key and secret for R2 bucket access
- Region set to `'auto'` for R2 compatibility

---

## 2. DYNAMIC VIDEO PLAYLIST ENDPOINT (server.js)

### Location: `charitystream/backend/server.js` (Lines 2921-2977)

```javascript
// Get all active videos for looping
// DYNAMIC: Scans charity-stream-videos R2 bucket for all video_X.mp4 files
app.get('/api/videos/playlist', async (req, res) => {
  try {
    const R2_BUCKET_URL = 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev';
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
    
    // Build playlist
    const playlist = videoFiles.map(video => ({
      videoId: video.number,
      title: video.filename.replace('.mp4', ''),
      videoUrl: `${R2_BUCKET_URL}/${video.filename}`,
      duration: 60
    }));
    
    console.log(`✅ Dynamically serving playlist: ${playlist.length} videos from R2 bucket`);
    console.log(`   Videos: ${videoFiles.map(v => v.filename).join(', ')}`);
    
    res.json({
      videos: playlist
    });
  } catch (error) {
    console.error('❌ Error fetching playlist:', error);
    
    // Fallback to static playlist if R2 listing fails
    const R2_BUCKET_URL = 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev';
    const fallbackPlaylist = [
      { videoId: 1, title: 'video_1', videoUrl: `${R2_BUCKET_URL}/video_1.mp4`, duration: 60 },
      { videoId: 2, title: 'video_2', videoUrl: `${R2_BUCKET_URL}/video_2.mp4`, duration: 60 },
      { videoId: 3, title: 'video_3', videoUrl: `${R2_BUCKET_URL}/video_3.mp4`, duration: 60 },
      { videoId: 4, title: 'video_4', videoUrl: `${R2_BUCKET_URL}/video_4.mp4`, duration: 60 },
      { videoId: 5, title: 'video_5', videoUrl: `${R2_BUCKET_URL}/video_5.mp4`, duration: 60 }
    ];
    
    console.log('⚠️ Using fallback playlist (5 videos)');
    res.json({ videos: fallbackPlaylist });
  }
});
```

**Key Features:**
- Dynamically scans `charity-stream-videos` R2 bucket
- Filters for `video_X.mp4` pattern (e.g., `video_1.mp4`, `video_2.mp4`)
- Sorts videos numerically by number
- Returns playlist with video URLs pointing to R2 public URL
- Has fallback playlist if R2 listing fails

---

## 3. CURRENT VIDEO ENDPOINT (server.js)

### Location: `charitystream/backend/server.js` (Lines 2895-2917)

```javascript
// Get current active video for the player
// Updated to use first video from R2 bucket (matching desktop app behavior)
app.get('/api/videos/current', async (req, res) => {
  try {
    // R2 bucket URL for charity-stream-videos
    const R2_BUCKET_URL = 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev';
    
    // Return first video from R2 bucket as the current/starting video
    const currentVideo = {
      videoId: 1,
      title: 'video_1',
      videoUrl: `${R2_BUCKET_URL}/video_1.mp4`,
      duration: 60
    };
    
    console.log('✅ Serving current video from R2 bucket:', currentVideo.title);
    
    res.json(currentVideo);
  } catch (error) {
    console.error('❌ Error fetching current video:', error);
    res.status(500).json({ error: 'Failed to fetch video', details: error.message });
  }
});
```

**Key Features:**
- Returns the starting video (`video_1.mp4`) from R2 bucket
- Uses public R2 URL for direct video access

---

## 4. ADVERTISER INFO ENDPOINT (server.js)

### Location: `charitystream/backend/server.js` (Lines 2979-3002)

```javascript
// GET endpoint to fetch advertiser info for a specific video
app.get('/api/videos/:videoFilename/advertiser', async (req, res) => {
  try {
    const { videoFilename } = req.params;
    
    const result = await pool.query(`
      SELECT company_name, website_url, video_filename
      FROM video_advertiser_mappings
      WHERE video_filename = $1 AND is_active = true
      LIMIT 1
    `, [videoFilename]);

    if (result.rows.length > 0) {
      res.json({
        hasAdvertiser: true,
        advertiser: result.rows[0]
      });
    } else {
      res.json({
        hasAdvertiser: false,
        advertiser: null
      });
    }
  } catch (error) {
    console.error('❌ Error fetching video advertiser:', error);
    res.status(500).json({ error: 'Failed to fetch advertiser information' });
  }
});
```

**Key Features:**
- Fetches advertiser info for specific video from database
- Returns company name, website URL, and video filename

---

## 5. WEBSITE PLAYLIST GENERATION (index.html)

### Location: `charitystream/public/index.html` (Lines 2878-2912)

```javascript
// Dynamic playlist generation - only include videos that actually exist
function generatePlaylist() {
  // IMPORTANT: Update this array when you add/remove videos
  // Current videos: video_1.mp4, video_2.mp4, video_3.mp4, video_4.mp4
  // To add more: just add 'video_5', 'video_6', etc. to this array
  // To remove: remove the corresponding entries from this array
  return ['video_1', 'video_2', 'video_3', 'video_4', 'video_5'];
}

const playlist = generatePlaylist();
let currentIndex = 0;
let currentQuality = "standard";
let isQualitySwitching = false;
let sessionStartTime = null;
let pausedCount = 0;
let currentVideoStartTime = null;
let isInitialLoad = true;
let isPlaying = false;
let currentAdTrackingId = null;
let adStartTime = null;
let isAdPlaying = false;
let accumulatedAdTime = 0;

function getVideoUrl(videoName) {
  return `videos/${videoName}.mp4`;
}

function getCurrentVideoSource() {
  const videoName = playlist[currentIndex];
  return {
    src: getVideoUrl(videoName),
    type: "video/mp4"
  };
}
```

**Key Features:**
- `generatePlaylist()` returns array of video names
- Playlist is hardcoded but easy to update
- Video URLs are constructed using `videos/${videoName}.mp4` pattern

---

## 6. VIDEO LOADING FUNCTION (index.html)

### Location: `charitystream/public/index.html` (Lines 2918-2971)

```javascript
function loadVideoWithQuality(index) {
  if (index >= playlist.length) {
    console.log(`⚠️ Index ${index} is out of bounds for playlist length ${playlist.length}`);
    return;
  }
  
  console.log(`🎬 loadVideoWithQuality called with index: ${index}`);
  console.log(`🎬 Current playlist:`, playlist);
  
  currentIndex = index;
  const source = getCurrentVideoSource();
  console.log(`🎬 Loading video ${index + 1} (${playlist[index]}): ${source.src}`);
  console.log(`🎬 Full video path: videos/${playlist[index]}.mp4`);
  
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
  
  // Don't start session automatically - only start when user actually plays video
  console.log('🎬 Video player initialized - session will start when user plays video');
}
```

**Key Features:**
- Loads video by index from playlist
- Fetches advertiser info when video changes
- Handles auto-play logic
- Integrates with session tracking

---

## 7. VIDEO LOOPING LOGIC (index.html)

### Location: `charitystream/public/index.html` (Lines 3137-3265)

```javascript
// Video ended event - completes ad tracking and session
player.on("ended", async function () {
  const now = Date.now();
  if (now - lastEndedEvent < ENDED_EVENT_DEBOUNCE) {
    return; // Skip duplicate ended events
  }
  lastEndedEvent = now;
  
  // Stop conflict monitoring when video ends
  stopConflictMonitoring();
  
  console.log(`🎬 Video ${currentIndex + 1} (${playlist[currentIndex]}) ended, switching to next video...`);
  console.log(`🎬 Current player state:`, {
    readyState: player.readyState(),
    paused: player.paused(),
    ended: player.ended(),
    currentSrc: player.currentSrc()
  });
  
  // Complete ad tracking if ad was playing
  if (isAdPlaying && currentAdTrackingId && adStartTime) {
    const currentTime = player.currentTime() || 0;
    const adDurationSeconds = Math.floor(Math.max(currentTime, accumulatedAdTime));
    
    await completeAdTracking(currentAdTrackingId, adDurationSeconds, true);
    
    // Reset ad tracking state
    isAdPlaying = false;
    currentAdTrackingId = null;
    adStartTime = null;
    accumulatedAdTime = 0;
    console.log('📺 Ad tracking completed on video end:', adDurationSeconds, 'seconds');
  }
  
  // Complete current session if exists
  if (!isQualitySwitching && currentSessionId && currentVideoStartTime) {
    const durationSeconds = Math.floor((Date.now() - currentVideoStartTime) / 1000);
    
    await completeWatchSession(currentSessionId, durationSeconds, true, pausedCount);
    
    currentVideoStartTime = null;
    sessionStartTime = null;
    pausedCount = 0;
    currentSessionId = null;
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
    
    // Start new session AND ad tracking for next video
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
          
          // Start ad tracking for the new video
          const adTrackingId = await startAdTracking(sessionId);
          
          if (adTrackingId) {
            currentAdTrackingId = adTrackingId;
            isAdPlaying = true;
            adStartTime = Date.now();
            accumulatedAdTime = 0;
            
            console.log('✅ New session AND ad tracking started for next video:', {
              sessionId: sessionId,
              adTrackingId: adTrackingId,
              videoName: playlist[currentIndex]
            });
          }
        } else {
          console.log('❌ Failed to start new session - no sessionId returned (desktop conflict)');
        }
      } catch (error) {
        console.log('❌ Error starting new session/ad tracking:', error);
      }
    }
  }
});
```

**Key Features:**
- Completes ad tracking when video ends
- Completes watch session
- Advances to next video using modulo operator `(currentIndex + 1) % playlist.length`
- Loops back to first video when reaching the end
- Starts new session and ad tracking for next video

---

## 8. ADVERTISER INFO SYSTEM (index.html)

### Location: `charitystream/public/index.html` (Lines 2731-2823)

```javascript
// ========== ADVERTISER INFO SYSTEM ==========

let currentAdvertiserInfo = null;

// Function to fetch advertiser info for current video
async function fetchAdvertiserInfo(videoFilename) {
  try {
    const response = await fetch(`/api/videos/${videoFilename}/advertiser`);
    const data = await response.json();
    
    if (data.hasAdvertiser) {
      currentAdvertiserInfo = data.advertiser;
      console.log(`📢 Advertiser found: ${data.advertiser.company_name}`);
      showInfoButton();
    } else {
      currentAdvertiserInfo = null;
      hideInfoButton();
    }
  } catch (error) {
    console.log('Error fetching advertiser info:', error);
    hideInfoButton();
  }
}

// Function to create and show info button
function showInfoButton() {
  hideInfoButton();
  
  if (!currentAdvertiserInfo) return;
  
  const infoButton = document.createElement('button');
  infoButton.id = 'advertiser-info-btn';
  infoButton.innerHTML = 'ℹ️';
  infoButton.title = `Learn about ${currentAdvertiserInfo.company_name}`;
  infoButton.style.cssText = `
    position: absolute;
    top: 10px;
    right: 10px;
    z-index: 1000;
    background: rgba(0,0,0,0.7);
    color: white;
    border: none;
    border-radius: 50%;
    width: 30px;
    height: 30px;
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all 0.2s ease;
  `;
  
  infoButton.addEventListener('click', () => {
    if (currentAdvertiserInfo && currentAdvertiserInfo.website_url) {
      console.log(`🔗 Opening advertiser website: ${currentAdvertiserInfo.website_url}`);
      window.open(currentAdvertiserInfo.website_url, '_blank', 'noopener,noreferrer');
    }
  });
  
  const videoContainer = document.getElementById('video-container') || document.querySelector('.video-js');
  if (videoContainer) {
    videoContainer.style.position = 'relative';
    videoContainer.appendChild(infoButton);
  }
}

function hideInfoButton() {
  const existingBtn = document.getElementById('advertiser-info-btn');
  if (existingBtn) {
    existingBtn.remove();
  }
}

// Call this when video changes
function onVideoChanged(videoFilename) {
  fetchAdvertiserInfo(videoFilename);
}

// ========== END ADVERTISER INFO SYSTEM ==========
```

**Key Features:**
- Fetches advertiser info from API
- Shows/hides info button (ℹ️) based on whether video has advertiser
- Opens advertiser website in new tab when clicked
- Integrated into video loading process

---

## 9. PROCESS APPROVED ADVERTISERS SCRIPT

### Location: `charitystream/backend/scripts/process-approved-advertisers.js` (Lines 1-52)

```javascript
const { Pool } = require('pg');
const { S3Client, CopyObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');

// Load environment variables from the correct .env file location
const envPath = path.join(__dirname, '..', '..', '.env');
if (fs.existsSync(envPath)) {
  require('dotenv').config({ path: envPath });
}

// Database connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

// Configure Cloudflare R2 client for bucket operations
const R2_CONFIG = {
  accessKeyId: '9eeb17f20eafece615e6b3520faf05c0',
  secretAccessKey: '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4',
  endpoint: 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com',
  accountId: 'e94c5ecbf3e438d402b3fe2ad136c0fc'
};

const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_CONFIG.endpoint,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey
  }
});

// Bucket names
const SOURCE_BUCKET = 'advertiser-media';
const DESTINATION_BUCKET = 'charity-stream-videos';
const R2_PUBLIC_URL = 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev';

// Check if file exists in a bucket
async function checkFileExistsInBucket(bucketName, key) {
  try {
    const headCommand = new HeadObjectCommand({
      Bucket: bucketName,
      Key: key
    });
    await r2Client.send(headCommand);
    return true;
  } catch (error) {
    if (error.name === 'NotFound' || error.$metadata?.httpStatusCode === 404) {
      return false;
    }
    throw error;
  }
}
```

**Key Features:**
- Connects to both buckets: `advertiser-media` (source) and `charity-stream-videos` (destination)
- Uses same R2 credentials as server.js
- Copies videos from advertiser bucket to main video bucket
- Renames videos to `video_X.mp4` pattern for automatic loop integration

---

## KEY ARCHITECTURE NOTES

### R2 Bucket Structure:
- **charity-stream-videos**: Main video bucket (public URL: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev`)
  - Contains: `video_1.mp4`, `video_2.mp4`, `video_3.mp4`, etc.
  - Videos loop in numerical order
  
- **advertiser-media**: Submitted advertiser videos
  - Contains: Original uploaded advertiser videos
  - Videos are copied to `charity-stream-videos` when approved

### Video Naming Convention:
- All videos in rotation follow `video_X.mp4` pattern
- X is a sequential number (1, 2, 3, 4, 5, etc.)
- Advertiser videos are renamed to this pattern when copied

### Dynamic Discovery:
- Backend scans R2 bucket for all `video_X.mp4` files
- No manual playlist updates needed
- New videos automatically appear in rotation when added to bucket

### Fallback System:
- If R2 listing fails, uses hardcoded playlist of 5 videos
- Ensures system continues working even if R2 is temporarily unavailable

### Integration Points:
1. **Server.js**: R2 client, playlist endpoints, advertiser API
2. **Index.html**: Playlist generation, video loading, looping logic, advertiser info UI
3. **Process script**: Copies approved advertiser videos to main bucket with correct naming

---

## TESTING THE SYSTEM

### Test R2 Connection:
```bash
# Test playlist endpoint
curl http://localhost:3001/api/videos/playlist

# Test current video endpoint
curl http://localhost:3001/api/videos/current

# Test advertiser info
curl http://localhost:3001/api/videos/video_1.mp4/advertiser
```

### Add New Video:
1. Upload `video_6.mp4` to `charity-stream-videos` R2 bucket
2. Video automatically appears in rotation (no code changes needed)
3. Check logs: "Dynamically serving playlist: 6 videos from R2 bucket"

### Add Advertiser Video:
1. Advertiser submits video (stored in `advertiser-media` bucket)
2. Approve advertiser in admin panel
3. Run: `npm run process-advertisers`
4. Video is copied to `charity-stream-videos` as `video_X.mp4`
5. Mapping created in database
6. Info button (ℹ️) appears on video player

---

## IMPORTANT URLS

- **R2 Endpoint**: `https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com`
- **Public R2 URL**: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev`
- **Main Video Bucket**: `charity-stream-videos`
- **Advertiser Media Bucket**: `advertiser-media`

---

## COMPLETE DATA FLOW

```
1. USER VISITS WEBSITE
   ↓
2. BROWSER REQUESTS PLAYLIST
   → GET /api/videos/playlist
   ↓
3. SERVER SCANS R2 BUCKET
   → ListObjectsV2Command on 'charity-stream-videos'
   ↓
4. SERVER RETURNS VIDEO LIST
   → [{videoId:1, title:'video_1', videoUrl:'https://pub-...r2.dev/video_1.mp4'}, ...]
   ↓
5. WEBSITE LOADS FIRST VIDEO
   → player.src({src: 'videos/video_1.mp4', type: 'video/mp4'})
   ↓
6. WEBSITE FETCHES ADVERTISER INFO
   → GET /api/videos/video_1.mp4/advertiser
   ↓
7. SERVER QUERIES DATABASE
   → SELECT from video_advertiser_mappings
   ↓
8. INFO BUTTON APPEARS (if advertiser exists)
   → ℹ️ button in top-right of video player
   ↓
9. VIDEO PLAYS TO END
   → player.on('ended')
   ↓
10. WEBSITE ADVANCES TO NEXT VIDEO
    → currentIndex = (currentIndex + 1) % playlist.length
    ↓
11. LOOP BACK TO STEP 5
```

---

**Last Updated**: October 13, 2025  
**System Version**: Dynamic R2 Discovery with Automatic Advertiser Integration

