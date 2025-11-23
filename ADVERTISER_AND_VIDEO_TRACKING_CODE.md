# Advertiser Form Sign Up & Video Tracking Code

This document contains all code related to:
1. Advertiser form sign up flow (form submission, record creation, R2 upload)
2. Video player view tracking and loading videos from R2

---

## PART 1: ADVERTISER FORM SIGN UP FLOW

### 1.1 Frontend: Advertiser Form (advertiser.html)

#### Form Submission Handler
```javascript
// File: public/advertiser.html (lines 1478-1622)

// Form submission triggers enhancement modal
document.getElementById('advertiserForm').addEventListener('submit', function(e) {
  e.preventDefault();
  showEnhancementModal();
});

// Collect form data including enhancements
function collectFormData() {
  const form = document.getElementById('advertiserForm');
  const formData = new FormData(form);
  
  // Get basic form data
  const data = {
    companyName: document.getElementById('companyName').value,
    websiteUrl: document.getElementById('websiteUrl').value,
    firstName: document.getElementById('firstName').value,
    lastName: document.getElementById('lastName').value,
    email: document.getElementById('email').value,
    jobTitle: document.getElementById('jobTitle').value,
    adFormat: document.querySelector('input[name="adFormat"]:checked')?.value,
    weeklyBudget: document.getElementById('budget').value,
    cpmRate: document.querySelector('input[name="cpmRate"]:checked')?.value,
    isRecurring: document.getElementById('recurringSpend').checked
  };
  
  // Handle custom CPM rate
  if (data.cpmRate === 'custom') {
    const customSlider = document.getElementById('cpmSlider');
    if (customSlider) {
      data.cpmRate = customSlider.value;
    }
  }
  
  // Get enhancement selections
  data.expeditedApproval = document.getElementById('expeditedEnhancement').checked;
  data.clickTracking = document.getElementById('clickableLinkEnhancement').checked;
  
  // Get destination URL if clickable link is selected
  if (data.clickTracking) {
    data.destinationUrl = document.getElementById('destinationUrl').value;
  }
  
  return data;
}

// Proceed to checkout (creates Stripe session)
function proceedToCheckout() {
  // Collect all form data
  const formData = collectFormData();
  
  // Validate required fields
  if (!formData.email || !formData.companyName || !formData.firstName || !formData.lastName) {
    alert('Please fill in all required fields');
    return;
  }
  
  // Check if file is uploaded
  const fileInput = document.getElementById('fileUpload');
  if (!fileInput.files || fileInput.files.length === 0) {
    alert('Please upload your ad creative before proceeding to checkout');
    return;
  }
  
  // Create FormData for file upload
  const submitData = new FormData();
  
  // Add form fields
  Object.keys(formData).forEach(key => {
    submitData.append(key, formData[key]);
  });
  
  // Add file
  submitData.append('creative', fileInput.files[0]);
  
  // Submit to backend
  fetch('/api/advertiser/create-checkout-session', {
    method: 'POST',
    body: submitData
  })
  .then(response => response.json())
  .then(data => {
    if (data.checkoutUrl) {
      // Redirect to Stripe Checkout
      window.location.href = data.checkoutUrl;
    }
  })
  .catch(error => {
    console.error('❌ Checkout error:', error);
    alert('Failed to create checkout session. Please try again.');
  });
}
```

### 1.2 Backend: Cloudflare R2 Configuration

```javascript
// File: backend/server.js (lines 2566-2595)

// ===== CLOUDFLARE R2 CONFIGURATION =====

const { S3Client, PutObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

// Configure Cloudflare R2 (S3-compatible)
const r2Client = new S3Client({
  region: 'auto',
  endpoint: 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com',
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID || '9eeb17f20eafece615e6b3520faf05c0',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4'
  }
});

// Configure multer for file uploads (store in memory)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max file size
  },
  fileFilter: (req, file, cb) => {
    // Accept video and image files
    const allowedMimes = ['video/mp4', 'image/png', 'image/jpeg', 'image/jpg'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MP4 videos and PNG/JPG images are allowed.'));
    }
  }
});
```

### 1.3 Backend: Create Checkout Session (Main Flow)

```javascript
// File: backend/server.js (lines 4394-4656)

app.post('/api/advertiser/create-checkout-session', upload.single('creative'), async (req, res) => {
  try {
    const {
      companyName,
      websiteUrl,
      firstName,
      lastName,
      email,
      jobTitle,
      adFormat,
      weeklyBudget,
      cpmRate,
      isRecurring,
      expeditedApproval,
      clickTracking,
      destinationUrl
    } = req.body;
    
    // Validate required fields
    if (!email || !companyName || !firstName || !lastName) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Company name, email, first name, and last name are required'
      });
    }
    
    // Map frontend ad format to database format
    let databaseAdFormat;
    if (adFormat === 'static') {
      databaseAdFormat = 'static_image';
    } else if (adFormat === 'video') {
      databaseAdFormat = 'video';
    } else {
      databaseAdFormat = adFormat;
    }
    
    // Get database pool
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Upload file to R2 immediately with final filename
    let mediaUrl = null;
    
    if (req.file) {
      try {
        // Generate final filename (no pending prefix - file is uploaded directly)
        const timestamp = Date.now();
        const sanitizedFileName = req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const finalFileName = `${timestamp}-${sanitizedFileName}`;
        
        console.log(`📤 Uploading file to R2: ${finalFileName}`);
        
        // Upload to R2 immediately with final filename
        const uploadCommand = new PutObjectCommand({
          Bucket: 'advertiser-media',
          Key: finalFileName,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        });
        
        await r2Client.send(uploadCommand);
        
        // Generate public URL immediately
        mediaUrl = `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${finalFileName}`;
        
        console.log('✅ File uploaded to R2 successfully:', mediaUrl);
        
      } catch (uploadError) {
        console.error('❌ Failed to upload file to R2:', uploadError);
        return res.status(500).json({
          error: 'File upload failed',
          message: 'Failed to upload file to storage. Please try again.',
          details: uploadError.message
        });
      }
    }
    
    // Insert advertiser record with payment_completed = false
    const advertiserResult = await pool.query(
      `INSERT INTO advertisers (
        company_name, website_url, first_name, last_name, 
        email, title_role, ad_format, weekly_budget_cap, cpm_rate, 
        recurring_weekly, expedited, click_tracking, destination_url,
        media_r2_link, payment_completed, application_status, approved, completed, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, false, 'payment_pending', false, false, CURRENT_TIMESTAMP)
      RETURNING id, email, company_name`,
      [
        companyName || null,
        websiteUrl || null,
        firstName || null,
        lastName || null,
        email,
        jobTitle || null,
        databaseAdFormat || null,
        weeklyBudget ? parseFloat(weeklyBudget) : null,
        cpmRate ? parseFloat(cpmRate) : null,
        isRecurring === 'true' || isRecurring === true,
        expeditedApproval === 'true' || expeditedApproval === true,
        clickTracking === 'true' || clickTracking === true,
        destinationUrl || null,
        mediaUrl // Store R2 URL immediately
      ]
    );
    
    const advertiser = advertiserResult.rows[0];
    
    // Calculate pricing and create Stripe checkout session
    const lineItems = [];
    
    // ALL advertisers get CPM Impressions product (metered)
    lineItems.push({
      price: 'price_1SLI8i0CutcpJ738GEgo3GtO' // CPM Impressions price ID
    });
    
    // Add Click Tracking if selected
    if (clickTracking === 'true' || clickTracking === true) {
      lineItems.push({
        price: 'price_1SLI9X0CutcpJ738vcuk6LPD' // Click Tracking price ID
      });
    }
    
    // Add Expedited Approval if selected
    if (expeditedApproval === 'true' || expeditedApproval === true) {
      lineItems.push({
        price: 'price_1SKv1E0CutcpJ738y51YDWa8', // Expedited Approval price ID
        quantity: 1
      });
    }
    
    // Create Stripe customer
    const customer = await stripe.customers.create({
      email: email,
      name: `${firstName} ${lastName}`,
      metadata: {
        advertiserId: String(advertiser.id),
        companyName: companyName,
        campaignType: 'advertiser',
        hasFile: !!req.file ? 'true' : 'false'
      }
    });
    
    // Create Stripe Checkout Session
    const session = await stripe.checkout.sessions.create({
      customer: customer.id,
      payment_method_types: ['card'],
      mode: 'subscription', // Subscription for usage-based billing
      success_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || 'http://localhost:3001'}/advertiser.html`,
      metadata: {
        advertiserId: String(advertiser.id),
        companyName: companyName,
        campaignType: 'advertiser',
        hasFile: !!req.file ? 'true' : 'false',
        isRecurring: isRecurring === 'true' || isRecurring === true ? 'true' : 'false',
        weeklyBudget: weeklyBudget || '',
        cpmRate: cpmRate || ''
      },
      subscription_data: {
        metadata: {
          advertiserId: String(advertiser.id),
          campaignType: 'advertiser',
          companyName: companyName,
          hasFile: !!req.file ? 'true' : 'false'
        }
      },
      line_items: lineItems
    });
    
    // Update advertiser record with Stripe customer ID
    await pool.query(
      'UPDATE advertisers SET stripe_customer_id = $1 WHERE id = $2',
      [customer.id, advertiser.id]
    );
    
    res.json({
      sessionId: session.id,
      checkoutUrl: session.url,
      advertiserId: advertiser.id
    });
    
  } catch (error) {
    console.error('❌ Error creating checkout session:', error);
    res.status(500).json({ 
      error: 'Failed to create checkout session', 
      details: error.message 
    });
  }
});
```

### 1.4 Alternative: Direct Submission (Without Stripe)

```javascript
// File: backend/server.js (lines 2599-2722)

app.post('/api/advertiser/submit', upload.single('creative'), async (req, res) => {
  try {
    const {
      companyName,
      websiteUrl,
      firstName,
      lastName,
      email,
      jobTitle,
      adFormat,
      weeklyBudget,
      cpmRate,
      isRecurring
    } = req.body;
    
    // Map frontend ad format to database format
    let databaseAdFormat;
    if (adFormat === 'static') {
      databaseAdFormat = 'static_image';
    } else if (adFormat === 'video') {
      databaseAdFormat = 'video';
    } else {
      databaseAdFormat = adFormat;
    }
    
    let mediaUrl = null;
    
    // Upload file to R2 if provided
    if (req.file) {
      try {
        const timestamp = Date.now();
        const filename = `${timestamp}-${req.file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
        
        console.log(`📤 Uploading file to R2: ${filename}`);
        
        const uploadCommand = new PutObjectCommand({
          Bucket: 'advertiser-media',
          Key: filename,
          Body: req.file.buffer,
          ContentType: req.file.mimetype,
        });
        
        await r2Client.send(uploadCommand);
        
        // Construct public URL
        mediaUrl = `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${filename}`;
        console.log(`✅ File uploaded successfully: ${mediaUrl}`);
        
      } catch (uploadError) {
        console.error('❌ R2 upload error:', uploadError);
        return res.status(500).json({
          error: 'File upload failed',
          message: 'Failed to upload media file to storage'
        });
      }
    }
    
    // Get database pool
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    // Insert into database
    const result = await pool.query(
      `INSERT INTO advertisers (
        company_name, website_url, first_name, last_name, 
        email, title_role, ad_format, weekly_budget_cap, cpm_rate, 
        media_r2_link, recurring_weekly, approved, completed, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false, false, CURRENT_TIMESTAMP)
      RETURNING id, email, media_r2_link, created_at`,
      [
        companyName || null,
        websiteUrl || null,
        firstName || null,
        lastName || null,
        email,
        jobTitle || null,
        databaseAdFormat || null,
        weeklyBudget ? parseFloat(weeklyBudget) : null,
        cpmRate ? parseFloat(cpmRate) : null,
        mediaUrl,
        isRecurring === 'true' || isRecurring === true
      ]
    );
    
    const inserted = result.rows[0];
    
    res.status(200).json({
      success: true,
      message: 'Advertiser submission received successfully',
      data: {
        id: inserted.id,
        email: inserted.email,
        mediaUrl: inserted.media_r2_link,
        createdAt: inserted.created_at
      }
    });
    
  } catch (error) {
    console.error('❌ Error submitting advertiser application:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to submit application. Please try again later.'
    });
  }
});
```

---

## PART 2: VIDEO PLAYER & VIEW TRACKING

### 2.1 Frontend: Video Player Initialization & Playlist Loading

```javascript
// File: public/index.html (lines 3300-3460)

// Initialize video player
function initializeVideoPlayer() {
  // Wait for Video.js to be available
  if (typeof videojs === 'undefined') {
    setTimeout(initializeVideoPlayer, 50);
    return;
  }
  
  try {
    player = videojs('my-video', {
      controls: true,
      autoplay: false,
      preload: 'auto',
      fluid: true,
      loop: false,
      controlBar: {
        progressControl: false,
        fullscreenToggle: false,
        // ... other controls disabled
      }
    });
    
    // DYNAMIC PLAYLIST FROM BACKEND
    let playlist = [];
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
        
        // Extract video names and URLs from backend response
        playlist = data.videos.map(video => {
          const videoName = video.title; // e.g., "video_1"
          videoUrls[videoName] = video.videoUrl; // Store the full R2 URL
          return videoName;
        });
        
        console.log('✅ Dynamic playlist loaded from R2:', playlist);
        return true;
      } catch (error) {
        console.error('❌ Failed to load dynamic playlist, using fallback:', error);
        // Fallback to hardcoded playlist
        playlist = ['video_1', 'video_2', 'video_3', 'video_4', 'video_5'];
        playlist.forEach(videoName => {
          videoUrls[videoName] = `https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev/${videoName}.mp4`;
        });
        return false;
      }
    }
    
    function getVideoUrl(videoName) {
      // Use direct R2 URLs
      const R2_BASE_URL = 'https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev';
      const directUrl = `${R2_BASE_URL}/${videoName}.mp4`;
      return directUrl;
    }
    
    function loadVideoWithQuality(index) {
      if (index >= playlist.length) return;
      
      currentIndex = index;
      const source = {
        src: getVideoUrl(playlist[index]),
        type: "video/mp4"
      };
      
      // Load the video
      player.src(source);
      
      // Fetch advertiser info for this video
      const videoFilename = `${playlist[index]}.mp4`;
      onVideoChanged(videoFilename);
      
      player.one('loadeddata', () => {
        // Auto-play when video loads
        setTimeout(() => {
          player.play().catch(error => {
            console.log('Auto-play prevented:', error);
          });
        }, 100);
      });
    }
    
    // Initialize playlist and load first video
    initializePlaylist().then(() => {
      loadVideoWithQuality(0);
    });
  } catch (error) {
    console.error('Error initializing video player:', error);
  }
}
```

### 2.2 Frontend: View Tracking Functions

```javascript
// File: public/index.html (lines 2588-2796)

// Global tracking variables
let currentAdTrackingId = null;
let isAdPlaying = false;
let adStartTime = null;
let accumulatedAdTime = 0;
let sessionStartTime = null;
let currentVideoStartTime = null;
let currentSessionId = null;

// Start a watch session
async function startWatchSession(videoName, quality) {
  if (!authToken) return null;
  
  try {
    const response = await trackedFetch('/api/tracking/start-session', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        videoName: videoName,
        quality: quality
      })
    });
    
    if (response.ok) {
      const result = await response.json();
      currentSessionId = result.sessionId;
      console.log('📺 Watch session started:', result.sessionId);
      return result.sessionId;
    } else if (response.status === 409) {
      // Session conflict detected (desktop app active)
      console.log('🚫 Session conflict detected');
      if (player) player.pause();
      showConflictToast();
      return null;
    }
  } catch (error) {
    console.error('Error starting watch session:', error);
    return null;
  }
}

// Start ad tracking
async function startAdTracking(sessionId) {
  if (!authToken || !sessionId) return null;
  
  try {
    const response = await trackedFetch('/api/tracking/start-ad', {
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

// Complete ad tracking
async function completeAdTracking(adTrackingId, durationSeconds, completed = true) {
  if (!authToken || !adTrackingId) return;
  
  try {
    const response = await trackedFetch('/api/tracking/complete-ad', {
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
      console.log('✅ Ad tracking completed successfully:', durationSeconds, 'seconds');
      
      // Clear cache and refresh UI
      userImpactCache = null;
      await loadUserImpact(true, true);
      loadLeaderboard();
    }
  } catch (error) {
    console.error('❌ Error completing ad tracking:', error);
  }
}
```

### 2.3 Frontend: Video Player Event Handlers

```javascript
// File: public/index.html (lines 3508-3757)

// Play event handler
function handlePlayEvent() {
  console.log('🎬 Video play event triggered');
  isPlaying = true;
  
  // Start session if not already started
  if (!currentSessionId) {
    startWatchSession(playlist[currentIndex], "standard").then(sessionId => {
      if (!sessionId) {
        player.pause();
        showConflictToast();
        return;
      }
      
      // Session started successfully
      currentSessionId = sessionId;
      sessionStartTime = Date.now();
      currentVideoStartTime = Date.now();
      
      // Start ad tracking
      if (!currentAdTrackingId) {
        startAdTracking(currentSessionId).then(adTrackingId => {
          if (adTrackingId) {
            currentAdTrackingId = adTrackingId;
            isAdPlaying = true;
            adStartTime = Date.now();
          }
        });
      }
    });
  }
}

player.on('play', handlePlayEvent);

// Pause event handler
player.on('pause', () => {
  isPlaying = false;
  
  // Accumulate actual playback time if ad was playing
  if (isAdPlaying && adStartTime) {
    const currentTime = player.currentTime() || 0;
    accumulatedAdTime = currentTime;
    console.log('📺 Ad tracking paused - Current video time:', Math.floor(currentTime), 'seconds');
  }
});

// Video ended event - completes ad tracking and session
player.on("ended", async function () {
  console.log(`🎬 Video ${currentIndex + 1} (${playlist[currentIndex]}) ended`);
  
  // Complete ad tracking if ad was playing
  if (currentAdTrackingId) {
    // Use the video's current time for accurate tracking
    const currentTime = player.currentTime() || 0;
    const adDurationSeconds = Math.floor(Math.max(currentTime, accumulatedAdTime));
    
    console.log('📺 Completing ad tracking:', adDurationSeconds, 'seconds');
    
    await completeAdTracking(currentAdTrackingId, adDurationSeconds, true);
    
    // Reset ad tracking variables
    currentAdTrackingId = null;
    isAdPlaying = false;
    adStartTime = null;
    accumulatedAdTime = 0;
  }
  
  // Move to next video
  const nextIndex = (currentIndex + 1) % playlist.length;
  loadVideoWithQuality(nextIndex);
});
```

### 2.4 Backend: Video Playlist Endpoint

```javascript
// File: backend/server.js (lines 4072-4154)

app.get('/api/videos/playlist', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const cacheKey = 'playlist_all';
    const now = Date.now();
    
    // Check cache first
    const cached = playlistCache.get(cacheKey);
    if (cached && (now - cached.timestamp) < PLAYLIST_CACHE_TTL) {
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
    
    // Build playlist
    const playlist = videoFiles.map(video => ({
      videoId: video.number,
      title: video.filename.replace('.mp4', ''),
      videoUrl: `${R2_BUCKET_URL}/${video.filename}`,
      duration: 60
    }));
    
    const playlistData = {
      videos: playlist
    };
    
    // Cache the result
    playlistCache.set(cacheKey, {
      data: playlistData,
      timestamp: now
    });
    
    console.log(`✅ Dynamically serving playlist: ${playlist.length} videos from R2 bucket`);
    
    res.json(playlistData);
  } catch (error) {
    console.error('❌ Error fetching playlist:', error);
    
    // Fallback to static playlist if R2 listing fails
    const R2_BUCKET_URL = 'https://pub-5077a490479046dbac97642d6ea9aa70.r2.dev';
    const fallbackPlaylist = [
      { videoId: 1, title: 'video_1', videoUrl: `${R2_BUCKET_URL}/video_1.mp4`, duration: 60 },
      { videoId: 2, title: 'video_2', videoUrl: `${R2_BUCKET_URL}/video_2.mp4`, duration: 60 },
      // ... more fallback videos
    ];
    
    res.json({ videos: fallbackPlaylist });
  }
});
```

### 2.5 Backend: Start Session Endpoint

```javascript
// File: backend/server.js (lines 3282-3461)

app.post('/api/tracking/start-session', authenticateToken, async (req, res) => {
  try {
    const { videoName, quality } = req.body;
    const userId = req.user.userId;
    const username = req.user.username;
    const userIP = req.ip || req.connection.remoteAddress;
    const userAgent = req.get('User-Agent');
    
    const pool = getPool();
    if (!pool) {
      return res.status(500).json({ error: 'Database connection not available' });
    }
    
    const client = await pool.connect();
    
    // Find any incomplete sessions for this user (last 3 minutes)
    const activeSessionsResult = await client.query(
      `SELECT id, video_name, start_time, user_agent 
       FROM watch_sessions 
       WHERE user_id = $1 
         AND end_time IS NULL 
         AND start_time > NOW() - INTERVAL '3 minutes'`,
      [userId]
    );
    
    // Check for desktop app precedence
    const isDesktopApp = userAgent && userAgent.toLowerCase().includes('electron');
    
    if (activeSessionsResult.rows.length > 0) {
      const desktopSessions = activeSessionsResult.rows.filter(session => 
        session.user_agent && session.user_agent.toLowerCase().includes('electron')
      );
      
      const hasDesktopSession = desktopSessions.length > 0;
      
      // Desktop app precedence rule
      if (hasDesktopSession && !isDesktopApp) {
        // Desktop session exists, but this is a web request - BLOCK IT
        return res.status(409).json({ 
          error: 'Multiple watch sessions detected',
          message: 'Desktop app is currently active. Please close the desktop app to watch on the website.',
          conflictType: 'desktop_active',
          hasActiveDesktopSession: true
        });
      }
      
      // Close old sessions
      for (const session of activeSessionsResult.rows) {
        const duration = Math.max(0, Math.floor((Date.now() - new Date(session.start_time).getTime()) / 1000));
        
        await client.query(
          `UPDATE watch_sessions 
           SET end_time = CURRENT_TIMESTAMP, 
               duration_seconds = $2, 
               completed = false 
           WHERE id = $1`,
          [session.id, duration]
        );
        
        // Also close any active ad tracking for this session
        await client.query(
          `UPDATE ad_tracking 
           SET ad_end_time = CURRENT_TIMESTAMP, 
               duration_seconds = $2,
               completed = false 
           WHERE session_id = $1 AND ad_end_time IS NULL`,
          [session.id, duration]
        );
      }
    }
    
    // Create the new session
    const sessionData = {
      userId: userId,
      videoName: videoName,
      quality: quality,
      userIP: userIP,
      userAgent: userAgent
    };
    
    const [err, sessionId] = await dbHelpers.createWatchSession(sessionData);
    if (err) {
      return res.status(500).json({ error: 'Failed to start session' });
    }
    
    res.json({
      sessionId: sessionId,
      message: 'Session started'
    });
  } catch (error) {
    console.error('❌ Error in start-session:', error);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    if (client) client.release();
  }
});
```

### 2.6 Backend: Start Ad Tracking Endpoint

```javascript
// File: backend/server.js (lines 3581-3604)

app.post('/api/tracking/start-ad', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    const [err, adTrackingId] = await dbHelpers.startAdTracking(req.user.userId, sessionId);
    if (err) {
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

### 2.7 Backend: Complete Ad Tracking Endpoint

```javascript
// File: backend/server.js (lines 3607-3709)

app.post('/api/tracking/complete-ad', authenticateToken, trackingRateLimit, async (req, res) => {
  try {
    const { adTrackingId, durationSeconds, completed = true } = req.body;
    
    // Check if this ad tracking ID has already been completed
    const pool = getPool();
    if (pool) {
      const checkResult = await pool.query(
        'SELECT id, completed FROM ad_tracking WHERE id = $1',
        [adTrackingId]
      );
      
      if (checkResult.rows.length > 0) {
        const existingTracking = checkResult.rows[0];
        if (existingTracking.completed) {
          return res.json({
            message: 'Ad tracking already completed',
            durationSeconds: durationSeconds
          });
        }
      } else {
        return res.status(404).json({ error: 'Ad tracking ID not found' });
      }
    }
    
    // Complete ad tracking
    const [err, adTracking] = await dbHelpers.completeAdTracking(adTrackingId, durationSeconds, completed);
    if (err) {
      return res.status(500).json({ error: 'Failed to complete ad tracking' });
    }
    
    // Update daily stats and user's monthly minutes if ad was completed
    if (completed && durationSeconds > 0) {
      // Update daily stats
      await dbHelpers.updateDailyStats(req.user.userId, 1, durationSeconds);
      
      // Update user's total and monthly watch time
      const secondsWatched = parseInt(durationSeconds, 10) || 0;
      if (secondsWatched > 0) {
        await dbHelpers.updateWatchSeconds(req.user.userId, secondsWatched);
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

## SUMMARY

### Advertiser Flow:
1. User fills out form in `advertiser.html`
2. Form submission triggers enhancement modal
3. User clicks "Proceed to checkout"
4. Frontend sends FormData (including file) to `/api/advertiser/create-checkout-session`
5. Backend uploads file to R2 bucket `advertiser-media`
6. Backend creates database record with `payment_completed = false`
7. Backend creates Stripe checkout session
8. User completes payment → Stripe webhook updates `payment_completed = true`
9. Admin approves → advertiser goes live

### Video Tracking Flow:
1. Frontend loads playlist from `/api/videos/playlist` (scans R2 bucket `charity-stream-videos`)
2. Video player loads videos from R2 URLs
3. When user plays video:
   - Frontend calls `/api/tracking/start-session`
   - Frontend calls `/api/tracking/start-ad`
4. When video ends:
   - Frontend calls `/api/tracking/complete-ad` with duration
   - Backend updates user stats and daily stats
5. Video loops to next in playlist

### R2 Buckets:
- `advertiser-media`: Stores advertiser creative files
- `charity-stream-videos`: Stores main video content

