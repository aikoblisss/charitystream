# System Architecture - Dynamic Video Playlist

## 🏗️ Complete System Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                        CLOUDFLARE R2 STORAGE                         │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────────────────┐        ┌──────────────────────┐         │
│  │  advertiser-media    │        │ charity-stream-videos│         │
│  │  ────────────────    │        │ ──────────────────── │         │
│  │  • Submitted videos  │        │  • video_1.mp4       │         │
│  │  • Awaiting approval │   ──>  │  • video_2.mp4       │         │
│  │                      │ copy   │  • video_3.mp4       │         │
│  │  Upload → Approve    │        │  • video_4.mp4       │         │
│  │  Run script          │        │  • video_5.mp4       │         │
│  └──────────────────────┘        │  • video_N.mp4       │         │
│                                   │                      │         │
│                                   │  Public URL:         │         │
│                                   │  pub-8359...r2.dev   │         │
│                                   └──────────────────────┘         │
│                                            ↑                        │
└────────────────────────────────────────────┼────────────────────────┘
                                             │
                                             │ ListObjectsV2Command
                                             │ Scans for video_X.mp4
                                             │
┌────────────────────────────────────────────┼────────────────────────┐
│                         BACKEND (server.js)                         │
├────────────────────────────────────────────┼────────────────────────┤
│                                             │                        │
│  ┌─────────────────────────────────────────┴─────────────────────┐ │
│  │                    R2 Client Connection                        │ │
│  │  • S3Client with R2 endpoint                                  │ │
│  │  • Access Key: 9eeb17f20ea...                                 │ │
│  │  • Secret Key: 86716ae11...                                   │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │              GET /api/videos/playlist                          │ │
│  │  ┌──────────────────────────────────────────────────────────┐ │ │
│  │  │ 1. List all files in charity-stream-videos bucket        │ │ │
│  │  │ 2. Filter for video_X.mp4 pattern                        │ │ │
│  │  │ 3. Sort numerically by number                            │ │ │
│  │  │ 4. Build JSON response with URLs                         │ │ │
│  │  │ 5. Return:                                               │ │ │
│  │  │    {                                                     │ │ │
│  │  │      videos: [                                           │ │ │
│  │  │        {videoId: 1, title: 'video_1',                   │ │ │
│  │  │         videoUrl: 'https://...r2.dev/video_1.mp4'},     │ │ │
│  │  │        ...                                               │ │ │
│  │  │      ]                                                   │ │ │
│  │  │    }                                                     │ │ │
│  │  └──────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │         GET /api/videos/:videoFilename/advertiser             │ │
│  │  • Queries video_advertiser_mappings table                    │ │
│  │  • Returns company name, website URL                          │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────┬───────────────────────┘
                                              │
                                              │ HTTP/JSON Response
                                              │
┌─────────────────────────────────────────────┼───────────────────────┐
│                     FRONTEND (index.html)                           │
├─────────────────────────────────────────────┼───────────────────────┤
│                                              │                       │
│  ┌──────────────────────────────────────────┴─────────────────────┐ │
│  │                  async initializePlaylist()                    │ │
│  │  ┌──────────────────────────────────────────────────────────┐ │ │
│  │  │ 1. Fetch /api/videos/playlist                            │ │ │
│  │  │ 2. Parse JSON response                                   │ │ │
│  │  │ 3. Extract video names → playlist[]                      │ │ │
│  │  │ 4. Map video URLs → videoUrls{}                          │ │ │
│  │  │ 5. Console log results                                   │ │ │
│  │  │ 6. Return success                                        │ │ │
│  │  └──────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                    getVideoUrl(videoName)                      │ │
│  │  • Returns videoUrls[videoName] (R2 URL)                      │ │
│  │  • Fallback: Constructs R2 URL if needed                      │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                  loadVideoWithQuality(index)                   │ │
│  │  • Gets video name from playlist[index]                       │ │
│  │  • Gets R2 URL from getVideoUrl()                             │ │
│  │  • Loads video into player                                    │ │
│  │  • Fetches advertiser info                                    │ │
│  │  • Shows info button (ℹ️) if advertiser exists               │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                              ↓                                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │                   VIDEO PLAYBACK & LOOPING                     │ │
│  │  ┌──────────────────────────────────────────────────────────┐ │ │
│  │  │ Play video from R2 URL                                   │ │ │
│  │  │         ↓                                                │ │ │
│  │  │ Track watch session                                      │ │ │
│  │  │         ↓                                                │ │ │
│  │  │ Track ad view                                            │ │ │
│  │  │         ↓                                                │ │ │
│  │  │ Video ends                                               │ │ │
│  │  │         ↓                                                │ │ │
│  │  │ Complete session & ad                                    │ │ │
│  │  │         ↓                                                │ │ │
│  │  │ currentIndex = (currentIndex + 1) % playlist.length      │ │ │
│  │  │         ↓                                                │ │ │
│  │  │ Load next video                                          │ │ │
│  │  │         ↓                                                │ │ │
│  │  │ Loop back to step 1                                      │ │ │
│  │  └──────────────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 🔄 Complete Data Flow

### 1. SYSTEM STARTUP
```
User Opens Website
       ↓
Video Player Initializes
       ↓
initializePlaylist() called
       ↓
Fetch /api/videos/playlist
       ↓
Backend scans R2 bucket
       ↓
Returns video list + URLs
       ↓
Frontend stores playlist & videoUrls
       ↓
Load first video (video_1)
       ↓
Fetch advertiser info
       ↓
Show info button if advertiser exists
       ↓
Video ready to play
```

### 2. VIDEO PLAYBACK LOOP
```
Video 1 Playing
       ↓
Track session & ad view
       ↓
Video 1 Ends
       ↓
Complete tracking
       ↓
Advance index: 1 → 2
       ↓
Load Video 2
       ↓
Fetch advertiser info
       ↓
Video 2 Playing
       ↓
... continues ...
       ↓
Video N Ends
       ↓
Advance index: N → 0 (loop back)
       ↓
Load Video 1 again
       ↓
Infinite loop continues
```

### 3. ADDING NEW VIDEO
```
Admin Uploads video_6.mp4 to R2
       ↓
User Refreshes Website
       ↓
initializePlaylist() runs
       ↓
Backend scans R2 bucket
       ↓
Finds: video_1.mp4 ... video_6.mp4
       ↓
Returns 6 videos to frontend
       ↓
Frontend updates playlist[]
       ↓
Video 6 now in rotation
       ↓
No code changes needed! ✅
```

### 4. ADVERTISER VIDEO WORKFLOW
```
Advertiser Submits Video
       ↓
Stored in advertiser-media bucket
       ↓
Admin Approves Advertiser
       ↓
Run: npm run process-advertisers
       ↓
Script scans charity-stream-videos
       ↓
Finds highest number (e.g., video_5)
       ↓
Calculates next number (e.g., 6)
       ↓
Copies video to charity-stream-videos
       ↓
Renames to video_6.mp4
       ↓
Creates database mapping
       ↓
Users Refresh Website
       ↓
Backend finds video_6.mp4
       ↓
Frontend loads it automatically
       ↓
Info button (ℹ️) appears
       ↓
Click opens advertiser website
       ↓
Complete automated integration! ✅
```

---

## 🎯 Key Components

### R2 Storage Layer
- **advertiser-media**: Temporary storage for submissions
- **charity-stream-videos**: Production video bucket
- **ListObjectsV2Command**: Scans bucket for files
- **Public URL**: Direct CDN access

### Backend API Layer
- **R2 Client**: Connects to Cloudflare R2
- **/api/videos/playlist**: Dynamic video discovery
- **/api/videos/current**: Starting video
- **/api/videos/:videoFilename/advertiser**: Advertiser info
- **process-approved-advertisers.js**: Video copying script

### Frontend Player Layer
- **initializePlaylist()**: Fetches videos from API
- **getVideoUrl()**: Returns R2 URLs
- **loadVideoWithQuality()**: Loads video into player
- **Video.js Player**: Plays videos from R2
- **Advertiser Info Button**: Links to advertiser website
- **Loop Logic**: Advances through playlist infinitely

---

## 📊 State Management

### Backend State
```javascript
R2_BUCKET = 'charity-stream-videos'
videoFiles = [
  {filename: 'video_1.mp4', number: 1, size: 12345678},
  {filename: 'video_2.mp4', number: 2, size: 23456789},
  // ... discovered dynamically
]
```

### Frontend State
```javascript
playlist = ['video_1', 'video_2', 'video_3', ...]  // Video names
videoUrls = {
  'video_1': 'https://pub-8359...r2.dev/video_1.mp4',
  'video_2': 'https://pub-8359...r2.dev/video_2.mp4',
  // ... mapped from API response
}
currentIndex = 0  // Currently playing video
```

---

## 🔐 Security

### Backend Security
- ✅ R2 credentials in environment variables
- ✅ SSL/TLS for R2 communication
- ✅ Input validation on filenames
- ✅ Regex filtering for video_X.mp4 pattern

### Frontend Security
- ✅ CORS headers for API requests
- ✅ noopener,noreferrer for external links
- ✅ Error handling prevents crashes
- ✅ Fallback system for reliability

---

## 📈 Scalability

### Current Capacity
- **Videos**: Unlimited (dynamic discovery)
- **File Size**: Up to 50MB per video
- **Concurrent Users**: Unlimited (CDN delivery)
- **Bandwidth**: Cloudflare's global CDN

### Growth Path
```
Current: 5 videos
   ↓
Add 10 advertiser videos → 15 videos
   ↓
Add 50 more videos → 65 videos
   ↓
Add 100 more videos → 165 videos
   ↓
No code changes needed at any point! ✅
```

---

## 🎉 System Benefits

### Technical
- ✅ Fully dynamic video discovery
- ✅ R2 CDN for global delivery
- ✅ Scalable architecture
- ✅ Error handling & fallbacks
- ✅ Modular design

### Operational
- ✅ Zero maintenance for videos
- ✅ Instant video additions
- ✅ No deployments needed
- ✅ Automated workflows
- ✅ Self-documenting system

### Business
- ✅ Fast advertiser onboarding
- ✅ Unlimited growth capacity
- ✅ Low operational costs
- ✅ Professional infrastructure
- ✅ Competitive advantage

---

**This is the architecture of a truly scalable video platform!** 🚀


