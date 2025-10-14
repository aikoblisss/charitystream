# 🛠️ Backend Scripts

## Process Approved Advertisers Script

### Purpose
This script processes approved advertisers from the database and creates video-advertiser mappings. When an advertiser is approved, this script extracts the video information and creates the necessary associations.

---

## 📁 File Location
`backend/scripts/process-approved-advertisers.js`

---

## 🚀 Usage

### Run the Script

```bash
# From the backend directory
cd charitystream/backend
node scripts/process-approved-advertisers.js
```

### Or from the project root

```bash
# From project root
cd charitystream
node backend/scripts/process-approved-advertisers.js
```

---

## 📋 What It Does

### 1. **Finds Approved Video Advertisers**
```sql
SELECT id, company_name, website_url, media_r2_link, ad_format
FROM advertisers 
WHERE approved = true AND ad_format = 'video'
```

### 2. **Extracts Video Filenames**
- Parses R2 URLs like: `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4`
- Extracts: `video_1.mp4`
- Validates it's a video file (.mp4, .webm, .mov)

### 3. **Creates Mappings**
```sql
INSERT INTO video_advertiser_mappings 
(advertiser_id, video_filename, website_url, company_name) 
VALUES (...)
```

### 4. **Prevents Duplicates**
- Checks if mapping already exists before inserting
- Skips existing mappings with informative message

---

## 📊 Example Output

### Successful Run:
```
🔄 Processing approved advertisers...
📊 Found 3 approved video advertisers
✅ Added mapping: video_1.mp4 → Acme Corp
✅ Added mapping: video_2.mp4 → Tech Solutions
ℹ️ Mapping already exists for: video_3.mp4
📊 Found 5 approved sponsors
🎉 Finished processing approved advertisers and sponsors
```

### No Approved Advertisers:
```
🔄 Processing approved advertisers...
📊 Found 0 approved video advertisers
📊 Found 0 approved sponsors
🎉 Finished processing approved advertisers and sponsors
```

### Error Handling:
```
🔄 Processing approved advertisers...
❌ Error processing approved advertisers: Connection refused
```

---

## 🔧 Configuration

### Environment Variables Required:
```env
DATABASE_URL=postgresql://user:password@host:port/database
```

The script automatically loads environment variables from your `.env` file.

---

## 📦 Dependencies

The script uses:
- `pg` (PostgreSQL client) - Already installed
- `dotenv` (Environment variables) - Already installed

No additional installation needed if your backend is set up!

---

## 🔄 When to Run This Script

### Scenarios:
1. **After approving new advertisers** in the admin panel
2. **Initial setup** to process existing approved advertisers
3. **Database recovery** after adding new videos
4. **Manual trigger** when video-advertiser associations are needed

### Frequency:
- Run manually after approving advertisers
- Or set up as a cron job (optional)
- Safe to run multiple times (prevents duplicates)

---

## 🎯 Use Cases

### Use Case 1: New Advertiser Approved
```
1. Admin approves advertiser in admin panel
2. Run: node scripts/process-approved-advertisers.js
3. Script creates video-advertiser mapping
4. Video player can now link to advertiser's website
```

### Use Case 2: Bulk Processing
```
1. Multiple advertisers approved at once
2. Run script once to process all
3. All mappings created in one go
```

### Use Case 3: Database Recovery
```
1. video_advertiser_mappings table is empty
2. Advertisers table has approved entries
3. Run script to recreate all mappings
```

---

## 🧪 Testing

### Test with Sample Data:

1. **Insert a test advertiser:**
```sql
INSERT INTO advertisers 
(company_name, website_url, email, ad_format, media_r2_link, approved) 
VALUES 
('Test Company', 'https://test.com', 'test@test.com', 'video', 
 'https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/test_video.mp4', true);
```

2. **Run the script:**
```bash
node scripts/process-approved-advertisers.js
```

3. **Verify mapping created:**
```sql
SELECT * FROM video_advertiser_mappings WHERE company_name = 'Test Company';
```

---

## 🔍 Script Functions

### `processApprovedAdvertisers()`
Main function that orchestrates the entire process.
- Queries approved advertisers
- Creates mappings
- Handles errors gracefully

### `extractVideoFilename(r2Url)`
Extracts and validates video filename from R2 URL.

**Input:** `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/video_1.mp4`  
**Output:** `video_1.mp4`

**Returns:** Filename if valid video, `null` otherwise

---

## 🛡️ Error Handling

### The script handles:
- ✅ Database connection failures
- ✅ Missing R2 URLs
- ✅ Invalid video filenames
- ✅ Duplicate mappings
- ✅ SQL errors

### Connection errors:
```javascript
try {
  // Process advertisers
} catch (error) {
  console.error('❌ Error processing approved advertisers:', error);
} finally {
  await pool.end(); // Always closes connection
}
```

---

## 📝 Database Schema Requirements

### Tables Used:

**advertisers:**
```sql
- id (primary key)
- company_name
- website_url
- media_r2_link
- ad_format
- approved (boolean)
```

**video_advertiser_mappings:**
```sql
- id (primary key)
- advertiser_id (foreign key)
- video_filename
- website_url
- company_name
- is_active (boolean, default true)
```

---

## 🚦 Exit Codes

- `0` - Success (all advertisers processed)
- `1` - Error (database connection or query failed)

---

## 🔄 Automation (Optional)

### Set up a cron job to run automatically:

```bash
# Run every hour
0 * * * * cd /path/to/charitystream/backend && node scripts/process-approved-advertisers.js >> logs/process-advertisers.log 2>&1
```

### Or trigger via API endpoint:

```javascript
// In server.js
app.post('/api/admin/process-advertisers', authenticateToken, adminOnly, async (req, res) => {
  try {
    await processApprovedAdvertisers();
    res.json({ success: true, message: 'Advertisers processed' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to process advertisers' });
  }
});
```

---

## 📚 Related Files

- `server.js` - Main server with advertiser submission endpoint
- `database.js` - Database helper functions
- `migrate_database.js` - Database migration script

---

## ✅ Checklist After Running

- [ ] Check console output for success messages
- [ ] Verify mappings created in database
- [ ] Test video player shows correct advertiser links
- [ ] Ensure no duplicate mappings created

---

## 🎉 Summary

**Script:** `process-approved-advertisers.js`  
**Purpose:** Create video-advertiser mappings for approved advertisers  
**Usage:** `node scripts/process-approved-advertisers.js`  
**Safe:** Yes - prevents duplicates, handles errors gracefully  
**Required:** Run after approving new video advertisers  

**Ready to use!** 🚀

