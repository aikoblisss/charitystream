# ✅ Advertiser Processing Script - Improvements

## Overview

The `process-approved-advertisers.js` script has been significantly improved with better database configuration, error handling, and logging.

---

## 🆕 What Was Improved

### 1. **Better Database Configuration**

**Before:**
```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
```

**After:**
```javascript
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});
```

**Benefits:**
- ✅ SSL support for production (Neon.tech compatibility)
- ✅ Connection timeout protection (10 seconds)
- ✅ Idle timeout management (30 seconds)
- ✅ Same config as server.js (consistency)

---

### 2. **Connection Testing**

**Added:**
```javascript
// Test connection first
client = await pool.connect();
console.log('✅ Database connection established');
```

**Benefits:**
- ✅ Verifies database is reachable before processing
- ✅ Clear error message if connection fails
- ✅ Prevents silent failures

---

### 3. **Enhanced Logging**

**Added:**
```javascript
console.log(`🔍 Processing advertiser: ${advertiser.company_name}`);
console.log(`📹 Found video: ${videoFilename}`);
console.log(`❌ Could not extract video filename from: ${advertiser.media_r2_link}`);
console.log(`🔗 Processing R2 URL: ${r2Url}`);
console.log(`📄 Not a video file: ${filename}`);
```

**Benefits:**
- ✅ Track progress for each advertiser
- ✅ Identify problems (invalid URLs, non-video files)
- ✅ Easier debugging
- ✅ Clear visibility into what's happening

---

### 4. **Sponsor Video Support**

**Added:**
```javascript
// Process sponsor videos if they exist
for (const sponsor of sponsorsResult.rows) {
  if (sponsor.logo_r2_link) {
    const sponsorVideoFilename = extractVideoFilename(sponsor.logo_r2_link);
    if (sponsorVideoFilename) {
      // Create mapping with sponsor_id
      await client.query(
        `INSERT INTO video_advertiser_mappings 
         (sponsor_id, video_filename, website_url, company_name) 
         VALUES ($1, $2, $3, $4)`,
        [sponsor.id, sponsorVideoFilename, sponsor.website, sponsor.organization]
      );
    }
  }
}
```

**Benefits:**
- ✅ Supports sponsor video content
- ✅ Same mapping table for both advertisers and sponsors
- ✅ Future-proof architecture

---

### 5. **Better Video File Validation**

**Before:**
```javascript
if (filename && (filename.endsWith('.mp4') || filename.endsWith('.webm') || filename.endsWith('.mov'))) {
  return filename;
}
```

**After:**
```javascript
const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv'];
const isVideo = videoExtensions.some(ext => filename.toLowerCase().endsWith(ext));

if (filename && isVideo) {
  return filename;
}
```

**Benefits:**
- ✅ Supports more video formats
- ✅ Case-insensitive checking
- ✅ Easy to add new formats
- ✅ Logs non-video files for debugging

---

### 6. **Improved Error Handling**

**Added:**
```javascript
// Unhandled promise rejection handler
process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled promise rejection:', err);
  process.exit(1);
});

// DATABASE_URL validation
if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL environment variable is not set');
  console.error('💡 Make sure you have a .env file with DATABASE_URL=...');
  process.exit(1);
}
```

**Benefits:**
- ✅ Catches all promise rejections
- ✅ Validates environment before running
- ✅ Helpful error messages
- ✅ Clean exit codes

---

### 7. **Proper Client Management**

**Before:**
```javascript
await pool.query(...);
```

**After:**
```javascript
client = await pool.connect();
await client.query(...);
// ... 
finally {
  if (client) {
    client.release();
  }
  await pool.end();
}
```

**Benefits:**
- ✅ Proper connection lifecycle
- ✅ Always releases client
- ✅ Always closes pool
- ✅ No connection leaks

---

## 📊 Example Output (Enhanced)

### Successful Run:
```bash
$ npm run process-advertisers

🔗 Database URL: Set
🔄 Processing approved advertisers...
✅ Database connection established
📊 Found 2 approved video advertisers

🔍 Processing advertiser: Acme Corporation
🔗 Processing R2 URL: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4
📹 Found video: video_1.mp4
✅ Added mapping: video_1.mp4 → Acme Corporation

🔍 Processing advertiser: Tech Solutions
🔗 Processing R2 URL: https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_2.mp4
📹 Found video: video_2.mp4
ℹ️ Mapping already exists for: video_2.mp4

📊 Found 1 approved sponsors
🎉 Finished processing approved advertisers and sponsors
```

### Error - No DATABASE_URL:
```bash
❌ DATABASE_URL environment variable is not set
💡 Make sure you have a .env file with DATABASE_URL=your_neon_connection_string
```

### Error - Connection Failed:
```bash
🔄 Processing approved advertisers...
❌ Error processing approved advertisers: connection timeout
💡 Check your DATABASE_URL environment variable in .env file
💡 Make sure your Neon.tech database is running and accessible
```

### Error - Invalid URL:
```bash
🔍 Processing advertiser: Example Corp
🔗 Processing R2 URL: https://example.com/logo.png
📄 Not a video file: logo.png
❌ Could not extract video filename from: https://example.com/logo.png
```

---

## 🧪 Testing Guide

### Test 1: Valid Advertiser

**Setup:**
```sql
INSERT INTO advertisers 
(company_name, website_url, email, ad_format, media_r2_link, approved) 
VALUES 
('Test Company', 'https://test.com', 'test@test.com', 'video', 
 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/test_video.mp4', true);
```

**Run:**
```bash
npm run process-advertisers
```

**Expected:**
```
✅ Database connection established
📊 Found 1 approved video advertisers
🔍 Processing advertiser: Test Company
📹 Found video: test_video.mp4
✅ Added mapping: test_video.mp4 → Test Company
```

---

### Test 2: Duplicate Mapping

**Run script twice:**
```bash
npm run process-advertisers
npm run process-advertisers
```

**Expected on second run:**
```
ℹ️ Mapping already exists for: test_video.mp4
```

---

### Test 3: Invalid Video File

**Setup:**
```sql
UPDATE advertisers 
SET media_r2_link = 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/logo.png'
WHERE id = 1;
```

**Run:**
```bash
npm run process-advertisers
```

**Expected:**
```
🔗 Processing R2 URL: https://.../logo.png
📄 Not a video file: logo.png
❌ Could not extract video filename from: https://.../logo.png
```

---

### Test 4: Database Connection Error

**Setup:** Stop your database or use invalid DATABASE_URL

**Run:**
```bash
npm run process-advertisers
```

**Expected:**
```
❌ Error processing approved advertisers: connection refused
💡 Check your DATABASE_URL environment variable in .env file
💡 Make sure your Neon.tech database is running and accessible
```

---

## 🔧 Configuration

### Environment Variables Required:

```env
# .env file in charitystream/ directory
DATABASE_URL=postgresql://user:password@host/database

# Optional:
NODE_ENV=production  # For SSL connections
```

### Production (Neon.tech):
```env
DATABASE_URL=postgresql://user:password@ep-xxx.us-east-2.aws.neon.tech/database?sslmode=require
NODE_ENV=production
```

### Development (Local):
```env
DATABASE_URL=postgresql://localhost:5432/charitystream
NODE_ENV=development
```

---

## 🎯 Key Improvements Summary

| Feature | Before | After |
|---------|--------|-------|
| **SSL Support** | No | Yes (production) ✅ |
| **Connection Test** | No | Yes ✅ |
| **Detailed Logging** | Basic | Comprehensive ✅ |
| **Sponsor Support** | Placeholder | Full implementation ✅ |
| **Video Validation** | 3 formats | 5 formats + case-insensitive ✅ |
| **Error Messages** | Generic | Helpful + actionable ✅ |
| **Client Management** | Basic | Proper lifecycle ✅ |
| **Environment Check** | No | Validates before run ✅ |

---

## 📝 Database Table Schema

### Expected Schema for `video_advertiser_mappings`:

```sql
CREATE TABLE video_advertiser_mappings (
  id SERIAL PRIMARY KEY,
  advertiser_id INTEGER REFERENCES advertisers(id),
  sponsor_id INTEGER REFERENCES sponsors(id),  -- New: supports sponsors too
  video_filename VARCHAR(255) NOT NULL,
  website_url VARCHAR(500),
  company_name VARCHAR(255),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX idx_video_filename ON video_advertiser_mappings(video_filename);
CREATE INDEX idx_is_active ON video_advertiser_mappings(is_active);
CREATE INDEX idx_advertiser_id ON video_advertiser_mappings(advertiser_id);
CREATE INDEX idx_sponsor_id ON video_advertiser_mappings(sponsor_id);
```

**Note:** Either `advertiser_id` OR `sponsor_id` will be set, not both.

---

## 🐛 Troubleshooting

### Script Won't Connect to Database

**Check:**
1. Is DATABASE_URL set in .env?
   ```bash
   echo $DATABASE_URL
   ```

2. Is .env in the correct location?
   ```
   charitystream/.env  ← Should be here
   ```

3. Can you connect with psql?
   ```bash
   psql $DATABASE_URL
   ```

4. Is Neon.tech database running?
   - Check your Neon.tech dashboard
   - Verify database isn't paused

---

### No Advertisers Found

**Check:**
```sql
-- Are there approved video advertisers?
SELECT * FROM advertisers 
WHERE approved = true AND ad_format = 'video';
```

**If empty:**
- Approve some advertisers first
- Or insert test data (see testing guide)

---

### Mappings Not Created

**Check:**
1. Are there SQL errors in output?
2. Does the table exist?
   ```sql
   \d video_advertiser_mappings
   ```
3. Does the script have INSERT permissions?

---

## ✅ Status

**Script Version:** Enhanced v2.0

**Improvements:**
- ✅ Production-ready database config
- ✅ SSL support for Neon.tech
- ✅ Connection testing
- ✅ Comprehensive logging
- ✅ Sponsor video support
- ✅ Better error handling
- ✅ Environment validation
- ✅ Proper client lifecycle

**Ready to use in production!** 🚀

---

## 🎉 Usage

```bash
cd charitystream/backend
npm run process-advertisers
```

**When to run:**
- After approving new advertisers
- After adding new videos
- During initial setup
- After database recovery

**Safe to run multiple times** - prevents duplicates automatically!

---

## 📚 Related Files

- `backend/server.js` - API endpoints
- `backend/scripts/README.md` - Usage documentation
- `backend/API_VIDEO_ADVERTISER_ENDPOINTS.md` - API docs

---

**The script is now production-grade and ready to use!** ✨

