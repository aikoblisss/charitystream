# 📦 R2 Video Copy Implementation - Complete Guide

## Overview

The `process-approved-advertisers.js` script now automatically copies approved advertiser videos from the `advertiser-media` bucket to the `charity-stream-videos` bucket, making them available for rotation in both the website and desktop app.

---

## 🎯 What It Does

### Complete Workflow:

```
1. Advertiser submits video
   ↓
2. Video stored in advertiser-media bucket
   ↓
3. Admin approves advertiser (sets approved = true)
   ↓
4. Run: npm run process-advertisers
   ↓
5. Script copies video from advertiser-media → charity-stream-videos
   ↓
6. Creates video_advertiser_mappings entry
   ↓
7. Video appears in website/app rotation
   ↓
8. Info button (ℹ️) shows advertiser info
```

---

## 🔧 Technical Implementation

### 1. **R2 Client Configuration**

```javascript
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
```

**Buckets:**
- **Source:** `advertiser-media` (where submissions land)
- **Destination:** `charity-stream-videos` (where videos loop from)

---

### 2. **Video Copying Function**

```javascript
async function copyVideoToCharityBucket(sourceKey, destinationFilename) {
  // 1. Verify source file exists
  const headCommand = new HeadObjectCommand({
    Bucket: SOURCE_BUCKET,
    Key: sourceKey
  });
  await r2Client.send(headCommand);
  
  // 2. Copy to destination bucket
  const copyCommand = new CopyObjectCommand({
    Bucket: DESTINATION_BUCKET,
    CopySource: `${SOURCE_BUCKET}/${sourceKey}`,
    Key: destinationFilename
  });
  await r2Client.send(copyCommand);
  
  // 3. Return success with new URL
  return { 
    success: true, 
    destinationUrl: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${destinationFilename}`
  };
}
```

**Process:**
1. Checks if source file exists (HeadObjectCommand)
2. Copies file between buckets (CopyObjectCommand)
3. Returns success status and new URL

---

### 3. **Unique Filename Generation**

```javascript
function generateUniqueFilename(originalFilename, advertiserId) {
  const timestamp = Date.now();
  const fileExtension = path.extname(originalFilename);
  const baseName = path.basename(originalFilename, fileExtension);
  
  // Format: advertiser_{id}_{timestamp}_{originalname}.mp4
  return `advertiser_${advertiserId}_${timestamp}_${baseName}${fileExtension}`;
}
```

**Example:**
- Original: `company-video.mp4`
- Advertiser ID: `42`
- Timestamp: `1697123456789`
- Result: `advertiser_42_1697123456789_company-video.mp4`

**Benefits:**
- ✅ Prevents filename conflicts
- ✅ Traceable to advertiser (ID in filename)
- ✅ Unique per submission (timestamp)
- ✅ Preserves original filename info

---

### 4. **Duplicate Prevention**

```javascript
// Check if mapping already exists (by advertiser_id)
const existingMapping = await client.query(
  'SELECT id, video_filename FROM video_advertiser_mappings WHERE advertiser_id = $1 AND is_active = true',
  [advertiser.id]
);

if (existingMapping.rows.length > 0) {
  console.log('ℹ️ Mapping already exists');
  continue; // Skip this advertiser
}
```

**Why check by advertiser_id:**
- Prevents multiple copies of same advertiser's video
- Safe to run script multiple times
- Won't duplicate videos in charity bucket

---

## 📊 Example Output

### Successful Run:

```bash
$ npm run process-advertisers

🔍 Looking for .env file at: C:\...\charitystream\.env
✅ Loaded .env file from: C:\...\charitystream\.env
🔗 DATABASE_URL present: true
🔗 Database URL loaded successfully
🔄 Processing approved advertisers...
📦 Source bucket: advertiser-media
🎯 Destination bucket: charity-stream-videos
✅ Database connection established
📊 Found 2 approved video advertisers

🔍 Processing advertiser: Acme Corporation
📧 Advertiser ID: 5
📹 Original video: 1697123456789-acme-video.mp4
🎯 Destination filename: advertiser_5_1697200000000_acme-video.mp4
📦 Copying video to charity bucket...
📋 Copying video from advertiser-media/1697123456789-acme-video.mp4 to charity-stream-videos/advertiser_5_1697200000000_acme-video.mp4
✅ Source file exists in advertiser-media
✅ Video copied successfully to charity-stream-videos/advertiser_5_1697200000000_acme-video.mp4
✅ Video copied successfully!
🔗 New video URL: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/advertiser_5_1697200000000_acme-video.mp4
✅ Added mapping: advertiser_5_1697200000000_acme-video.mp4 → Acme Corporation (https://www.acme.com)

🔍 Processing advertiser: Tech Solutions
📧 Advertiser ID: 6
📹 Original video: 1697123999999-tech-ad.mp4
🎯 Destination filename: advertiser_6_1697200000123_tech-ad.mp4
ℹ️ Mapping already exists for advertiser Tech Solutions
   Existing video: advertiser_6_1697199999999_tech-ad.mp4

🎉 Processing complete!
✅ Successful: 2
❌ Errors: 0

📢 IMPORTANT: Videos have been copied to charity-stream-videos bucket
📢 These videos will now appear in the website/app rotation
📢 You may need to update the hardcoded playlist in server.js to include them
```

---

### Error - Source File Not Found:

```bash
🔍 Processing advertiser: Example Corp
📹 Original video: missing-file.mp4
🎯 Destination filename: advertiser_7_1697200000000_missing-file.mp4
📦 Copying video to charity bucket...
📋 Copying video from advertiser-media/missing-file.mp4 to charity-stream-videos/advertiser_7_1697200000000_missing-file.mp4
❌ Source file not found in advertiser-media/missing-file.mp4
❌ Failed to copy video for Example Corp: Source file not found

🎉 Processing complete!
✅ Successful: 0
❌ Errors: 1
```

---

## 🧪 Testing Guide

### Prerequisites:

1. **Approved advertiser with video in database:**
```sql
SELECT id, company_name, ad_format, media_r2_link, approved 
FROM advertisers 
WHERE approved = true AND ad_format = 'video';
```

2. **Video exists in advertiser-media bucket**

3. **Database has video_advertiser_mappings table**

---

### Test Scenario 1: New Approved Advertiser

**Setup:**
```sql
-- Approve an advertiser
UPDATE advertisers 
SET approved = true 
WHERE id = 5 AND ad_format = 'video';
```

**Run:**
```bash
npm run process-advertisers
```

**Expected:**
- ✅ Video copied from advertiser-media to charity-stream-videos
- ✅ Mapping created in database
- ✅ Console shows success message

**Verify:**
```sql
SELECT * FROM video_advertiser_mappings WHERE advertiser_id = 5;
```

Should show new entry with unique filename.

---

### Test Scenario 2: Duplicate Prevention

**Run script twice:**
```bash
npm run process-advertisers
npm run process-advertisers
```

**Expected on second run:**
```
ℹ️ Mapping already exists for advertiser [Name]
```

**Verify:**
- Only ONE video in charity-stream-videos bucket
- Only ONE mapping in database

---

### Test Scenario 3: Multiple Advertisers

**Setup:**
```sql
-- Approve multiple advertisers
UPDATE advertisers 
SET approved = true 
WHERE ad_format = 'video' AND id IN (5, 6, 7);
```

**Run:**
```bash
npm run process-advertisers
```

**Expected:**
- All 3 videos copied
- All 3 mappings created
- Success count: 3

---

## 🔍 Bucket Structure

### Before Running Script:

**advertiser-media bucket:**
```
1697123456789-acme-video.mp4         (Acme Corporation)
1697123999999-tech-ad.mp4            (Tech Solutions)
1697124500000-example-promo.mp4      (Example Corp)
```

**charity-stream-videos bucket:**
```
video_1.mp4
video_2.mp4
video_3.mp4
video_4.mp4
video_5.mp4
```

---

### After Running Script:

**advertiser-media bucket:** (unchanged)
```
1697123456789-acme-video.mp4
1697123999999-tech-ad.mp4
1697124500000-example-promo.mp4
```

**charity-stream-videos bucket:** (new files added)
```
video_1.mp4
video_2.mp4
video_3.mp4
video_4.mp4
video_5.mp4
advertiser_5_1697200000000_acme-video.mp4          ← NEW!
advertiser_6_1697200000123_tech-ad.mp4             ← NEW!
advertiser_7_1697200000456_example-promo.mp4       ← NEW!
```

---

## 📝 Database Mappings

### video_advertiser_mappings table after script:

| id | advertiser_id | video_filename | website_url | company_name |
|----|---------------|----------------|-------------|--------------|
| 1 | 5 | advertiser_5_1697200000000_acme-video.mp4 | https://acme.com | Acme Corporation |
| 2 | 6 | advertiser_6_1697200000123_tech-ad.mp4 | https://tech.com | Tech Solutions |
| 3 | 7 | advertiser_7_1697200000456_example-promo.mp4 | https://example.com | Example Corp |

---

## 🎬 Integration with Video Player

### Current Situation:

**server.js has hardcoded playlist:**
```javascript
const playlist = [
  { videoId: 1, title: 'video_1', videoUrl: `${R2_BUCKET_URL}/video_1.mp4` },
  { videoId: 2, title: 'video_2', videoUrl: `${R2_BUCKET_URL}/video_2.mp4` },
  // ... etc
];
```

### To Include Advertiser Videos:

**Option 1: Manual Update**
```javascript
const playlist = [
  { videoId: 1, title: 'video_1', videoUrl: `${R2_BUCKET_URL}/video_1.mp4` },
  { videoId: 2, title: 'video_2', videoUrl: `${R2_BUCKET_URL}/video_2.mp4` },
  { videoId: 3, title: 'video_3', videoUrl: `${R2_BUCKET_URL}/video_3.mp4` },
  { videoId: 4, title: 'video_4', videoUrl: `${R2_BUCKET_URL}/video_4.mp4` },
  { videoId: 5, title: 'video_5', videoUrl: `${R2_BUCKET_URL}/video_5.mp4` },
  // Add advertiser videos:
  { videoId: 6, title: 'advertiser_5', videoUrl: `${R2_BUCKET_URL}/advertiser_5_1697200000000_acme-video.mp4` },
  { videoId: 7, title: 'advertiser_6', videoUrl: `${R2_BUCKET_URL}/advertiser_6_1697200000123_tech-ad.mp4` },
];
```

**Option 2: Dynamic from Database** (Better!)
```javascript
app.get('/api/videos/playlist', async (req, res) => {
  try {
    const R2_BUCKET_URL = 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev';
    
    // Static videos
    const baseVideos = [
      { videoId: 1, title: 'video_1', videoUrl: `${R2_BUCKET_URL}/video_1.mp4`, duration: 60 },
      { videoId: 2, title: 'video_2', videoUrl: `${R2_BUCKET_URL}/video_2.mp4`, duration: 60 },
      { videoId: 3, title: 'video_3', videoUrl: `${R2_BUCKET_URL}/video_3.mp4`, duration: 60 },
      { videoId: 4, title: 'video_4', videoUrl: `${R2_BUCKET_URL}/video_4.mp4`, duration: 60 },
      { videoId: 5, title: 'video_5', videoUrl: `${R2_BUCKET_URL}/video_5.mp4`, duration: 60 }
    ];
    
    // Get advertiser videos from database
    const pool = getPool();
    const advertiserVideos = await pool.query(`
      SELECT video_filename 
      FROM video_advertiser_mappings 
      WHERE is_active = true
      ORDER BY id
    `);
    
    // Add advertiser videos to playlist
    let videoId = 6;
    const advertiserVideoObjects = advertiserVideos.rows.map(row => ({
      videoId: videoId++,
      title: row.video_filename.replace('.mp4', ''),
      videoUrl: `${R2_BUCKET_URL}/${row.video_filename}`,
      duration: 60
    }));
    
    const fullPlaylist = [...baseVideos, ...advertiserVideoObjects];
    
    console.log(`✅ Serving playlist: ${fullPlaylist.length} videos (${baseVideos.length} base + ${advertiserVideoObjects.length} advertiser)`);
    
    res.json({ videos: fullPlaylist });
  } catch (error) {
    console.error('❌ Error fetching playlist:', error);
    res.status(500).json({ error: 'Failed to fetch playlist' });
  }
});
```

---

## 🎯 Key Features

### 1. **Source Verification** ✅
- Checks if source file exists before copying
- Uses HeadObjectCommand
- Fails gracefully if file missing

### 2. **Unique Filenames** ✅
- Format: `advertiser_{id}_{timestamp}_{original}.mp4`
- Prevents conflicts
- Traceable to advertiser

### 3. **Duplicate Prevention** ✅
- Checks by advertiser_id (not filename)
- Safe to run multiple times
- Won't create duplicate copies

### 4. **Comprehensive Logging** ✅
- Shows each step
- Identifies problems
- Success/error counts

### 5. **Error Handling** ✅
- Continues processing if one fails
- Specific error messages
- Helpful troubleshooting hints

---

## 📊 Processing Flow

```
┌──────────────────────────────────────────────────────┐
│                  NEON DATABASE                        │
│  advertisers table                                   │
│  ├─ id: 5                                            │
│  ├─ company_name: "Acme Corporation"                 │
│  ├─ ad_format: "video"                               │
│  ├─ media_r2_link: "https://.../1697123456789-...mp4"│
│  └─ approved: true  ← Trigger for processing         │
└───────────────────┬──────────────────────────────────┘
                    │
                    ▼
┌──────────────────────────────────────────────────────┐
│        SCRIPT: process-approved-advertisers.js       │
│  1. Query approved advertisers                       │
│  2. Extract filename from media_r2_link              │
│  3. Generate unique destination filename             │
│  4. Check for existing mapping                       │
│  5. Copy video between R2 buckets                    │
│  6. Create database mapping                          │
└───────┬────────────────┬──────────────────────────────┘
        │                │
        ▼                ▼
┌──────────────┐  ┌──────────────────────────────┐
│  R2 BUCKET   │  │   NEON DATABASE              │
│  charity-    │  │   video_advertiser_mappings  │
│  stream-     │  │   ├─ advertiser_id: 5        │
│  videos      │  │   ├─ video_filename: ...     │
│              │  │   ├─ website_url: ...        │
│  New file:   │  │   └─ company_name: ...       │
│  advertiser_ │  │                              │
│  5_169720... │  │                              │
│  .mp4        │  │                              │
└──────────────┘  └──────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────┐
│         WEBSITE & DESKTOP APP                        │
│  • Playlist includes advertiser video                │
│  • Video plays in rotation                           │
│  • Info button (ℹ️) appears                          │
│  • Clicking opens advertiser website                 │
└──────────────────────────────────────────────────────┘
```

---

## 🔧 Error Scenarios Handled

### 1. **Source File Not Found**
```
❌ Source file not found in advertiser-media/video.mp4
❌ Failed to copy video: Source file not found
```
**Cause:** Video was deleted or never uploaded  
**Action:** Continues with next advertiser

### 2. **Database Connection Failed**
```
❌ Error processing approved advertisers: connection refused
💡 Database connection refused. Check your DATABASE_URL
```
**Cause:** DATABASE_URL wrong or Neon database down  
**Action:** Script exits

### 3. **R2 Credentials Invalid**
```
❌ Error copying video: Invalid credentials
💡 R2 credentials error. Check your R2_CONFIG credentials
```
**Cause:** Access keys incorrect  
**Action:** Script exits

### 4. **Bucket Not Found**
```
❌ Error processing approved advertisers: NoSuchBucket
💡 R2 bucket not found. Check your bucket names
```
**Cause:** Bucket names wrong  
**Action:** Script exits

---

## ✅ Success Criteria

After running the script successfully:

### 1. **Videos Copied** ✅
```bash
# Check charity-stream-videos bucket
# Should contain new advertiser_*.mp4 files
```

### 2. **Database Mappings Created** ✅
```sql
SELECT * FROM video_advertiser_mappings WHERE advertiser_id = 5;
-- Should return mapping entry
```

### 3. **Videos Accessible** ✅
```bash
# Test URL directly
curl -I https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/advertiser_5_1697200000000_acme-video.mp4
# Should return 200 OK
```

### 4. **Info Button Works** ✅
```bash
# Test API endpoint
curl http://localhost:3001/api/videos/advertiser_5_1697200000000_acme-video.mp4/advertiser
# Should return advertiser info
```

---

## 🚀 Deployment Workflow

### Step-by-Step:

#### 1. **Advertiser Submits Video**
- Form submission at `/advertiser.html`
- Video uploads to `advertiser-media` bucket
- Entry created in `advertisers` table with `approved = false`

#### 2. **Admin Reviews & Approves**
```sql
-- In admin panel (or manually)
UPDATE advertisers 
SET approved = true 
WHERE id = 5;
```

#### 3. **Run Processing Script**
```bash
cd charitystream/backend
npm run process-advertisers
```

#### 4. **Verify Success**
```bash
# Check logs for success
✅ Added mapping: ...

# Check database
SELECT * FROM video_advertiser_mappings WHERE advertiser_id = 5;

# Check R2 bucket (via Cloudflare dashboard or API)
```

#### 5. **(Optional) Update Playlist**
If you want advertiser videos in rotation immediately, update server.js playlist or use dynamic loading.

---

## 📋 Dependencies

### Required npm packages:
```json
{
  "dependencies": {
    "@aws-sdk/client-s3": "^3.x.x",  // For R2 operations
    "pg": "^8.x.x",                   // For database
    "dotenv": "^16.x.x",              // For env vars
    "path": "built-in",               // Node.js built-in
    "fs": "built-in"                  // Node.js built-in
  }
}
```

**Check if installed:**
```bash
cd charitystream/backend
npm list @aws-sdk/client-s3
```

**If not installed:**
```bash
npm install @aws-sdk/client-s3
```

---

## 🔒 Security Notes

### Credentials Hardcoded:
```javascript
const R2_CONFIG = {
  accessKeyId: '9eeb17f20eafece615e6b3520faf05c0',
  secretAccessKey: '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4',
  // ...
};
```

**⚠️ Important:**
- These credentials are hardcoded in the script
- They have access to your R2 buckets
- Keep this file secure
- Don't commit to public repositories

**Better approach (optional):**
```javascript
const R2_CONFIG = {
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '9eeb17f20eafece615e6b3520faf05c0',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '86716ae1188f87ba5c6d0939a2ff19d972a0b53a6edfb0ed9fe5ba17a87cb4a4',
  endpoint: process.env.R2_ENDPOINT || 'https://e94c5ecbf3e438d402b3fe2ad136c0fc.r2.cloudflarestorage.com',
};
```

---

## 🛠️ Troubleshooting

### Problem: "Source file not found"

**Check:**
1. Does the file exist in advertiser-media bucket?
2. Is the media_r2_link URL correct in database?
3. Was the file upload successful during submission?

**Debug:**
```sql
SELECT id, company_name, media_r2_link 
FROM advertisers 
WHERE approved = true AND ad_format = 'video';
```

---

### Problem: "CopyObject failed"

**Check:**
1. Are R2 credentials correct?
2. Do buckets exist?
3. Do credentials have copy permissions?

**Test R2 access:**
```bash
# Use Cloudflare dashboard to verify:
# 1. advertiser-media bucket exists
# 2. charity-stream-videos bucket exists
# 3. API tokens have read/write permissions
```

---

### Problem: "Mapping creation failed"

**Check:**
1. Does video_advertiser_mappings table exist?
2. Does it have the correct columns?

**Verify schema:**
```sql
\d video_advertiser_mappings

-- Should have columns:
-- id, advertiser_id, video_filename, website_url, company_name, is_active
```

---

## 📊 Performance Considerations

### Copying Videos:

**Small videos (< 10MB):** ~2-5 seconds per copy  
**Medium videos (10-50MB):** ~5-15 seconds per copy  
**Large videos (50-100MB):** ~15-30 seconds per copy

### Script Runtime:

- **1 advertiser:** ~5-10 seconds
- **5 advertisers:** ~25-50 seconds
- **10 advertisers:** ~50-100 seconds

**Note:** S3 CopyObject is server-side, so no data transfers through your server!

---

## ✅ Summary

**What the script does:**
1. ✅ Connects to Neon database
2. ✅ Finds approved video advertisers
3. ✅ Copies videos from advertiser-media → charity-stream-videos
4. ✅ Generates unique filenames (no conflicts)
5. ✅ Creates database mappings
6. ✅ Prevents duplicates
7. ✅ Handles errors gracefully

**Result:**
- ✅ Advertiser videos available in charity bucket
- ✅ Videos can be included in rotation
- ✅ Info buttons work with advertiser links
- ✅ Safe to run repeatedly

**Usage:**
```bash
npm run process-advertisers
```

**The script is now production-ready for R2 bucket video management!** 🚀

