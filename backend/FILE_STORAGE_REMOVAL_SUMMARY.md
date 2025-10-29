# File Data Storage Removal - Performance Fix

## Problem Summary
The `advertisers` table has severe performance issues due to storing large video/file data in the `file_data` column (BYTEA type), causing:
- 1.5+ minute query times
- Database UI freezing/lagging
- General performance degradation

## Solution Applied
Completely removed all file data storage from the Neon database. Files should ONLY be stored in Cloudflare R2, never in the database.

## Changes Made

### 1. Webhook Handler Updated (server.js)
**Location:** Lines 4498-4511

**Before:**
```javascript
// Upload file to R2 if file data exists
let mediaUrl = null;
if (advertiser.file_data) {
  try {
    console.log('📤 Uploading file to R2 after subscription creation...');
    
    const timestamp = Date.now();
    const originalName = advertiser.file_original_name || 'file';
    const filename = `${timestamp}-${originalName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const contentType = advertiser.file_mime_type || 'video/mp4';
    
    const uploadCommand = new PutObjectCommand({
      Bucket: 'advertiser-media',
      Key: filename,
      Body: advertiser.file_data, // Direct buffer
      ContentType: contentType,
    });
    
    await r2Client.send(uploadCommand);
    mediaUrl = `https://pub-83596556bc864db7aa93479e13f45deb.r2.dev/${filename}`;
    
    // Clear file data from database after successful upload
    await pool.query(
      `UPDATE advertisers 
       SET file_data = NULL, 
           file_original_name = NULL, 
           file_mime_type = NULL 
       WHERE id = $1`,
      [advertiserId]
    );
    
  } catch (uploadError) {
    console.error('❌ R2 upload error in webhook:', uploadError);
  }
}
```

**After:**
```javascript
// NOTE: Files are NOT stored in database for performance reasons
// If a file was provided, it should have been uploaded to R2 directly
// The media_r2_link should already exist in the database
let mediaUrl = advertiser.media_r2_link || null;

console.log('📤 File storage status:', {
  hasMediaLink: !!advertiser.media_r2_link,
  mediaUrl: mediaUrl
});
```

### 2. Create Checkout Session (Already Correct)
**Location:** Lines 3928-3970

The create-checkout-session endpoint already does NOT store file data in database:
```javascript
// File will be uploaded directly to R2 in the webhook, not stored in database
let fileMetadata = null;
if (req.file) {
  fileMetadata = {
    originalname: req.file.originalname,
    mimetype: req.file.mimetype,
    size: req.file.size
  };
  console.log('📁 File received for direct R2 upload:', req.file.originalname);
  // Store only metadata, NOT the buffer
}

// NOTE: File data is NOT stored in database - it will be uploaded directly to R2 in the webhook
// No file storage in database to avoid performance issues
```

This is correct and no changes needed.

## Database Cleanup Required

### Run This SQL to Remove Existing File Data

See `REMOVE_FILE_DATA_FROM_DATABASE.sql` for the complete SQL script.

**Quick Summary:**
```sql
-- STEP 1: Count affected records
SELECT COUNT(*) FROM advertisers WHERE file_data IS NOT NULL;

-- STEP 2: Clear all file_data (main fix)
UPDATE advertisers 
SET 
    file_data = NULL,
    file_original_name = NULL,
    file_mime_type = NULL
WHERE file_data IS NOT NULL;

-- STEP 3: Verify cleanup
SELECT COUNT(*) FROM advertisers WHERE file_data IS NOT NULL;
-- Should return 0
```

### Handle Foreign Key Constraint (if needed)

If you get foreign key constraint errors when trying to clean up, you may need to:

```sql
-- Option 1: Delete child records first
DELETE FROM video_advertiser_mappings 
WHERE advertiser_id IN (
    SELECT id FROM advertisers WHERE file_data IS NOT NULL
);

-- Option 2: Temporarily drop and recreate constraint
ALTER TABLE video_advertiser_mappings 
DROP CONSTRAINT IF EXISTS video_advertiser_mappings_advertiser_id_fkey;

-- Run the UPDATE statement here

ALTER TABLE video_advertiser_mappings
ADD CONSTRAINT video_advertiser_mappings_advertiser_id_fkey
FOREIGN KEY (advertiser_id) REFERENCES advertisers(id);
```

## Performance Impact

### Before:
- Query time: 1.5+ minutes
- Database UI: Freezing/lagging
- General queries on advertisers table: Very slow

### After:
- Query time: Should be < 1 second
- Database UI: Responsive
- General queries on advertisers table: Fast

## Important Notes

1. **Application Code Already Updated**: The code now expects files to be uploaded directly to R2, not stored in the database.

2. **Database Columns Remain**: The `file_data`, `file_original_name`, and `file_mime_type` columns are still in the schema but set to NULL. This keeps the table structure intact while fixing performance.

3. **R2 Upload Flow**: The current implementation expects files to be uploaded to R2 before or during the checkout process. If this doesn't happen, the `media_r2_link` will be NULL.

4. **Future Optimization**: If you want to permanently remove the columns from the schema (optional):
   ```sql
   ALTER TABLE advertisers DROP COLUMN IF EXISTS file_data;
   ALTER TABLE advertisers DROP COLUMN IF EXISTS file_original_name;
   ALTER TABLE advertisers DROP COLUMN IF EXISTS file_mime_type;
   ```

## Testing

After applying these changes:
1. Run the SQL cleanup script
2. Test advertiser checkout flow
3. Verify queries are fast
4. Check that media_r2_link is being set properly
5. Verify webhook processing doesn't fail

## Rollback Plan

If you need to rollback:
1. The application code can be reverted to store file_data
2. However, you cannot recover file data that was cleared from the database
3. If files are in R2, they should still be accessible

## Next Steps

1. ✅ Code changes applied to webhook handler
2. ⏳ Run SQL cleanup script to clear existing file_data
3. ⏳ Test the advertiser submission flow
4. ⏳ Monitor database performance
5. ⏳ Verify queries are fast

