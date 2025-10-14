# 🎬 Video-Advertiser API Endpoints

## Overview

These endpoints allow you to fetch advertiser information associated with specific videos. When a video is playing, you can query these endpoints to display the advertiser's company name and provide a clickable link to their website.

---

## 📍 Endpoints

### 1. Get Advertiser for Specific Video

**Endpoint:** `GET /api/videos/:videoFilename/advertiser`

**Purpose:** Fetch advertiser information for a specific video file.

#### Request

**Method:** `GET`

**URL Parameters:**
- `videoFilename` (string, required) - The video filename (e.g., `video_1.mp4`)

**Example:**
```http
GET /api/videos/video_1.mp4/advertiser
```

#### Response

**Success (200):**
```json
{
  "hasAdvertiser": true,
  "advertiser": {
    "company_name": "Acme Corporation",
    "website_url": "https://www.acme.com",
    "video_filename": "video_1.mp4"
  }
}
```

**No Advertiser Found (200):**
```json
{
  "hasAdvertiser": false,
  "advertiser": null
}
```

**Error (500):**
```json
{
  "error": "Failed to fetch advertiser information"
}
```

#### Usage Example (JavaScript)

```javascript
async function getVideoAdvertiser(videoFilename) {
  try {
    const response = await fetch(`/api/videos/${videoFilename}/advertiser`);
    const data = await response.json();
    
    if (data.hasAdvertiser) {
      console.log('Advertiser:', data.advertiser.company_name);
      console.log('Website:', data.advertiser.website_url);
      
      // Display advertiser link in UI
      displayAdvertiserLink(data.advertiser);
    } else {
      console.log('No advertiser for this video');
    }
  } catch (error) {
    console.error('Error fetching advertiser:', error);
  }
}

// Usage
getVideoAdvertiser('video_1.mp4');
```

---

### 2. Get All Video-Advertiser Mappings

**Endpoint:** `GET /api/videos/advertiser-mappings`

**Purpose:** Fetch all active video-advertiser mappings. Useful for preloading advertiser data or displaying a list of all advertisers.

#### Request

**Method:** `GET`

**No parameters required**

**Example:**
```http
GET /api/videos/advertiser-mappings
```

#### Response

**Success (200):**
```json
{
  "mappings": [
    {
      "video_filename": "video_1.mp4",
      "website_url": "https://www.acme.com",
      "company_name": "Acme Corporation"
    },
    {
      "video_filename": "video_2.mp4",
      "website_url": "https://www.techsolutions.com",
      "company_name": "Tech Solutions Inc"
    },
    {
      "video_filename": "video_5.mp4",
      "website_url": "https://www.example.org",
      "company_name": "Example Organization"
    }
  ]
}
```

**No Mappings (200):**
```json
{
  "mappings": []
}
```

**Error (500):**
```json
{
  "error": "Failed to fetch advertiser mappings"
}
```

#### Usage Example (JavaScript)

```javascript
async function getAllAdvertiserMappings() {
  try {
    const response = await fetch('/api/videos/advertiser-mappings');
    const data = await response.json();
    
    console.log(`Found ${data.mappings.length} advertiser mappings`);
    
    // Create a lookup map for quick access
    const advertiserMap = {};
    data.mappings.forEach(mapping => {
      advertiserMap[mapping.video_filename] = {
        company: mapping.company_name,
        url: mapping.website_url
      };
    });
    
    // Use the map
    const video1Advertiser = advertiserMap['video_1.mp4'];
    if (video1Advertiser) {
      console.log(`Video 1 advertiser: ${video1Advertiser.company}`);
    }
    
    return advertiserMap;
  } catch (error) {
    console.error('Error fetching mappings:', error);
  }
}

// Usage
const mappings = await getAllAdvertiserMappings();
```

---

## 🎯 Use Cases

### Use Case 1: Display Advertiser During Video Playback

```javascript
// When video starts playing
player.on('play', async function() {
  const currentVideoUrl = player.currentSrc();
  const filename = extractFilename(currentVideoUrl); // e.g., "video_1.mp4"
  
  const response = await fetch(`/api/videos/${filename}/advertiser`);
  const data = await response.json();
  
  if (data.hasAdvertiser) {
    // Show "Sponsored by [Company]" with clickable link
    showAdvertiserBanner(data.advertiser.company_name, data.advertiser.website_url);
  } else {
    // Hide advertiser banner
    hideAdvertiserBanner();
  }
});
```

### Use Case 2: Preload All Advertiser Data

```javascript
// On page load, fetch all mappings once
let advertiserCache = {};

async function initializeAdvertiserData() {
  const response = await fetch('/api/videos/advertiser-mappings');
  const data = await response.json();
  
  // Store in cache
  data.mappings.forEach(mapping => {
    advertiserCache[mapping.video_filename] = {
      company: mapping.company_name,
      url: mapping.website_url
    };
  });
  
  console.log('Advertiser data loaded:', Object.keys(advertiserCache).length, 'mappings');
}

// Call on page load
initializeAdvertiserData();

// Use cached data during playback (no API calls needed!)
function getAdvertiserFromCache(filename) {
  return advertiserCache[filename] || null;
}
```

### Use Case 3: Track Advertiser Clicks

```javascript
async function handleAdvertiserClick(videoFilename) {
  const response = await fetch(`/api/videos/${videoFilename}/advertiser`);
  const data = await response.json();
  
  if (data.hasAdvertiser) {
    // Track the click
    await fetch('/api/tracking/advertiser-click', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        videoFilename: videoFilename,
        companyName: data.advertiser.company_name,
        clickedAt: new Date().toISOString()
      })
    });
    
    // Open advertiser website
    window.open(data.advertiser.website_url, '_blank');
  }
}
```

---

## 🔒 Security Notes

### Public Endpoints
These endpoints are **public** (no authentication required) because:
- Advertiser information is meant to be displayed publicly
- Website URLs are public by nature
- No sensitive data is exposed

### If You Want to Add Authentication

```javascript
// In server.js
app.get('/api/videos/:videoFilename/advertiser', authenticateToken, async (req, res) => {
  // ... endpoint code
});
```

---

## 📊 Database Schema

### Table: `video_advertiser_mappings`

```sql
CREATE TABLE video_advertiser_mappings (
  id SERIAL PRIMARY KEY,
  advertiser_id INTEGER REFERENCES advertisers(id),
  video_filename VARCHAR(255) NOT NULL,
  website_url VARCHAR(500),
  company_name VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for fast lookups
CREATE INDEX idx_video_filename ON video_advertiser_mappings(video_filename);
CREATE INDEX idx_is_active ON video_advertiser_mappings(is_active);
```

---

## 🧪 Testing

### Test with cURL

**Get specific video advertiser:**
```bash
curl http://localhost:3001/api/videos/video_1.mp4/advertiser
```

**Get all mappings:**
```bash
curl http://localhost:3001/api/videos/advertiser-mappings
```

### Test with Browser

**Single video:**
```
http://localhost:3001/api/videos/video_1.mp4/advertiser
```

**All mappings:**
```
http://localhost:3001/api/videos/advertiser-mappings
```

### Test with Postman

1. **GET** `http://localhost:3001/api/videos/video_1.mp4/advertiser`
2. Check response has `hasAdvertiser` and `advertiser` fields

---

## 🔍 Response Field Details

### `hasAdvertiser` (boolean)
- `true` - Advertiser mapping exists for this video
- `false` - No advertiser for this video

### `advertiser` (object or null)
When `hasAdvertiser` is `true`:
- `company_name` (string) - Name of the advertising company
- `website_url` (string) - Full URL to advertiser's website
- `video_filename` (string) - The video file this advertiser is associated with

When `hasAdvertiser` is `false`:
- Value is `null`

---

## 📈 Performance Considerations

### Caching Strategy

**Option 1: Cache on Frontend**
```javascript
const advertiserCache = new Map();

async function getCachedAdvertiser(filename) {
  if (advertiserCache.has(filename)) {
    return advertiserCache.get(filename);
  }
  
  const response = await fetch(`/api/videos/${filename}/advertiser`);
  const data = await response.json();
  
  advertiserCache.set(filename, data);
  return data;
}
```

**Option 2: Preload All Mappings**
```javascript
// Load once on page load
const mappings = await fetch('/api/videos/advertiser-mappings').then(r => r.json());

// Use throughout session (no more API calls!)
const advertiserForVideo1 = mappings.mappings.find(m => m.video_filename === 'video_1.mp4');
```

### Database Performance

The endpoints use:
- ✅ Indexed lookups (`video_filename`)
- ✅ Filtered queries (`is_active = true`)
- ✅ Limited results (`LIMIT 1` for specific video)
- ✅ Simple queries (no joins needed)

**Expected performance:** < 5ms per query

---

## 🚀 Integration Example

### Complete Video Player Integration

```javascript
// Initialize advertiser system
let currentAdvertiser = null;

// When video starts
player.on('play', async function() {
  const videoSrc = player.currentSrc();
  const filename = videoSrc.split('/').pop(); // Extract filename
  
  // Fetch advertiser info
  const response = await fetch(`/api/videos/${filename}/advertiser`);
  const data = await response.json();
  
  if (data.hasAdvertiser) {
    currentAdvertiser = data.advertiser;
    showAdvertiserUI(currentAdvertiser);
  } else {
    currentAdvertiser = null;
    hideAdvertiserUI();
  }
});

// Show advertiser UI
function showAdvertiserUI(advertiser) {
  const banner = document.getElementById('advertiser-banner');
  banner.innerHTML = `
    <div class="advertiser-info">
      <span>Sponsored by</span>
      <a href="${advertiser.website_url}" target="_blank" rel="noopener">
        ${advertiser.company_name}
      </a>
    </div>
  `;
  banner.style.display = 'block';
}

// Hide advertiser UI
function hideAdvertiserUI() {
  const banner = document.getElementById('advertiser-banner');
  banner.style.display = 'none';
}
```

---

## 📝 API Summary

| Endpoint | Method | Auth | Purpose |
|----------|--------|------|---------|
| `/api/videos/:videoFilename/advertiser` | GET | No | Get advertiser for one video |
| `/api/videos/advertiser-mappings` | GET | No | Get all video-advertiser mappings |

---

## ✅ Checklist

After adding these endpoints:

- [x] Endpoints added to server.js
- [x] Database pool connection checked
- [x] Error handling implemented
- [x] No linting errors
- [ ] Test endpoints with sample data
- [ ] Integrate with video player
- [ ] Add advertiser UI to website
- [ ] Track advertiser clicks (optional)

---

## 🎉 Ready to Use!

Both endpoints are now available:
- ✅ `/api/videos/:videoFilename/advertiser` - Get advertiser for specific video
- ✅ `/api/videos/advertiser-mappings` - Get all mappings

**Next steps:**
1. Restart your backend server
2. Test the endpoints
3. Integrate with your video player
4. Display advertiser information in your UI

🚀 **Happy coding!**

