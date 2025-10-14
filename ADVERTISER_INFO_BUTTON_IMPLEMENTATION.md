# 📢 Advertiser Info Button Implementation

## Overview

The advertiser info button system displays a clickable ℹ️ button on videos that have associated advertisers. When clicked, it opens the advertiser's website in a new tab.

---

## ✅ What Was Added

### Files Modified:

1. **`charitystream/backend/server.js`**
   - Line 1838-1851: Ad format mapping (static → static_image)
   - Line 1907: Use mapped database value
   - Line 2943-2975: GET endpoint for specific video advertiser
   - Line 2977-2999: GET endpoint for all advertiser mappings

2. **`charitystream/backend/package.json`**
   - Line 10: Added `process-advertisers` script

3. **`charitystream/public/index.html`**
   - Line 2731-2823: Complete advertiser info system
   - Line 2938: Integration with video loading

### Files Created:

1. **`charitystream/backend/scripts/process-approved-advertisers.js`**
   - Script to create video-advertiser mappings

2. **`charitystream/backend/scripts/README.md`**
   - Documentation for the script

3. **`charitystream/backend/API_VIDEO_ADVERTISER_ENDPOINTS.md`**
   - API endpoint documentation

---

## 🎯 How It Works

### 1. **Admin Workflow**

```
1. Advertiser submits application
   ↓
2. Admin reviews and approves (sets approved = true)
   ↓
3. Run: npm run process-advertisers
   ↓
4. Script creates video-advertiser mapping
   ↓
5. Video now has associated advertiser info
```

### 2. **User Experience**

```
User watches video
   ↓
ℹ️ button appears in top-right corner
   ↓
User clicks ℹ️ button
   ↓
Opens advertiser's website in new tab
```

### 3. **Technical Flow**

```
Video loads (loadVideoWithQuality)
   ↓
onVideoChanged('video_1.mp4') called
   ↓
fetchAdvertiserInfo('video_1.mp4') called
   ↓
GET /api/videos/video_1.mp4/advertiser
   ↓
Backend queries video_advertiser_mappings table
   ↓
Returns advertiser info (if exists)
   ↓
showInfoButton() creates and displays ℹ️ button
   ↓
Button click → Opens advertiser website
```

---

## 🎬 Visual Example

### Video Without Advertiser:
```
┌─────────────────────────────────────┐
│                                     │
│         [Video Playing]             │
│                                     │
│                                     │
│                                     │
└─────────────────────────────────────┘
[Play] [Volume]  HD
```

### Video With Advertiser:
```
┌─────────────────────────────────────┐
│                             ℹ️ ←────│ Clickable info button
│         [Video Playing]             │
│                                     │
│                                     │
│                                     │
└─────────────────────────────────────┘
[Play] [Volume]  HD

Hover over ℹ️: "Learn about Acme Corporation"
Click ℹ️: Opens https://www.acme.com
```

---

## 📝 Code Integration Details

### Frontend Code Added (index.html):

**Variables:**
```javascript
let currentAdvertiserInfo = null;
```

**Functions:**
```javascript
async function fetchAdvertiserInfo(videoFilename)
function showInfoButton()
function hideInfoButton()  
function onVideoChanged(videoFilename)
```

**Integration Point:**
```javascript
// In loadVideoWithQuality function:
const videoFilename = `${playlist[index]}.mp4`;
onVideoChanged(videoFilename);
```

---

## 🎨 UI Styling

### Info Button Styles:
- **Position:** Top-right corner (10px from top and right)
- **Design:** Circular button with ℹ️ emoji
- **Background:** Semi-transparent black (rgba(0,0,0,0.7))
- **Size:** 30px × 30px
- **Hover:** Darker background + slight scale (1.1x)
- **Cursor:** Pointer (indicates clickable)
- **Z-index:** 1000 (appears above video)

### Hover Effect:
```javascript
mouseenter: background darker, scale up to 110%
mouseleave: return to normal
```

---

## 🧪 Testing Steps

### Step 1: Create Test Data

```sql
-- Insert test advertiser
INSERT INTO advertisers 
(company_name, website_url, email, ad_format, media_r2_link, approved) 
VALUES 
('Test Company', 'https://example.com', 'test@example.com', 'video', 
 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4', true);
```

### Step 2: Run Processing Script

```bash
cd charitystream/backend
npm run process-advertisers
```

**Expected output:**
```
🔄 Processing approved advertisers...
📊 Found 1 approved video advertisers
✅ Added mapping: video_1.mp4 → Test Company
```

### Step 3: Test API Endpoint

```bash
curl http://localhost:3001/api/videos/video_1.mp4/advertiser
```

**Expected response:**
```json
{
  "hasAdvertiser": true,
  "advertiser": {
    "company_name": "Test Company",
    "website_url": "https://example.com",
    "video_filename": "video_1.mp4"
  }
}
```

### Step 4: Test on Website

1. Start your backend server
2. Open website, login
3. Play video_1.mp4
4. **Expected:** ℹ️ button appears in top-right
5. Click ℹ️ button
6. **Expected:** Opens https://example.com in new tab

### Step 5: Verify Console Logs

**When video loads:**
```
🎬 Loading video 1 (video_1): videos/video_1.mp4
📢 Advertiser found: Test Company
[ℹ️ button appears]
```

**When button clicked:**
```
🔗 Opening advertiser website: https://example.com
```

**When no advertiser:**
```
🎬 Loading video 2 (video_2): videos/video_2.mp4
[No button appears]
```

---

## 🔄 Complete Workflow

### Setup (One-Time):

1. **Advertiser applies:**
   - Fills out form at `/advertiser.html`
   - Uploads video creative
   - Submits application

2. **Admin approves:**
   - Reviews in admin panel
   - Sets `approved = true`

3. **Process mappings:**
   ```bash
   npm run process-advertisers
   ```

4. **System ready:**
   - Video-advertiser mappings created
   - Info button will appear on videos

### Runtime (Automatic):

1. **User plays video:**
   - Video loads
   - Frontend fetches advertiser info
   - ℹ️ button appears (if advertiser exists)

2. **User clicks ℹ️:**
   - Opens advertiser's website
   - (Optional: Track click for analytics)

---

## 🎯 Features

### ✅ Dynamic Loading
- Fetches advertiser info when video changes
- No hardcoding needed
- Automatically updates when mappings change

### ✅ Smart Display
- Shows button only when advertiser exists
- Hides button for videos without advertisers
- Prevents errors for missing data

### ✅ Smooth UX
- Hover effect for interactivity
- Tooltip shows company name
- Opens in new tab (doesn't interrupt video)
- Security: noopener, noreferrer

### ✅ Error Handling
- Gracefully handles API failures
- Silent errors (doesn't break video player)
- Falls back to no button if data unavailable

---

## 📊 Database Requirements

### Table: `video_advertiser_mappings`

Must exist with these columns:
- `video_filename` (VARCHAR)
- `website_url` (VARCHAR)
- `company_name` (VARCHAR)
- `is_active` (BOOLEAN)

### Sample Data:

```sql
INSERT INTO video_advertiser_mappings 
(advertiser_id, video_filename, website_url, company_name, is_active)
VALUES 
(1, 'video_1.mp4', 'https://www.acme.com', 'Acme Corporation', true);
```

---

## 🔧 Customization

### Change Button Position:

```javascript
infoButton.style.cssText = `
  position: absolute;
  top: 10px;      // Change this (vertical position)
  right: 10px;    // Change this (horizontal position)
  ...
`;
```

### Change Button Style:

```javascript
infoButton.innerHTML = '🔗';  // Different icon
infoButton.style.cssText = `
  ...
  background: rgba(255,0,0,0.7);  // Red background
  width: 40px;                    // Larger button
  height: 40px;
  ...
`;
```

### Add Click Tracking:

```javascript
infoButton.addEventListener('click', async () => {
  if (currentAdvertiserInfo && currentAdvertiserInfo.website_url) {
    // Track the click
    await fetch('/api/tracking/advertiser-click', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${authToken}`
      },
      body: JSON.stringify({
        videoFilename: currentAdvertiserInfo.video_filename,
        companyName: currentAdvertiserInfo.company_name,
        timestamp: new Date().toISOString()
      })
    });
    
    // Open website
    window.open(currentAdvertiserInfo.website_url, '_blank', 'noopener,noreferrer');
  }
});
```

---

## 🚀 Deployment Checklist

- [x] Backend endpoints added
- [x] Frontend code added
- [x] Processing script created
- [x] Package.json updated
- [x] Integration with video loader
- [ ] Run `npm run process-advertisers` after approving advertisers
- [ ] Test with real advertiser data
- [ ] Verify ℹ️ button appears and works
- [ ] Verify website opens correctly

---

## 📚 Related Documentation

- `API_VIDEO_ADVERTISER_ENDPOINTS.md` - API documentation
- `backend/scripts/README.md` - Script usage guide
- `ADVERTISER_SUBMISSION_API.md` - Advertiser submission flow

---

## 🎉 Summary

**What was added:**
- ✅ Advertiser info fetching system
- ✅ Dynamic ℹ️ info button
- ✅ Integration with video player
- ✅ Automatic display/hide based on data
- ✅ Click to open advertiser website

**How to use:**
1. Approve advertiser in admin panel
2. Run `npm run process-advertisers`
3. Info button automatically appears on associated videos

**Result:**
- Videos with advertisers show ℹ️ button
- Users can click to learn more about sponsors
- Drives traffic to advertiser websites
- Professional, polished UX

**Everything is ready to test!** 🚀

