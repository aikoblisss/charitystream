-- ============================================================================
-- REMOVE FILE DATA FROM ADVERTISERS TABLE - PERFORMANCE FIX
-- ============================================================================
-- Purpose: Remove all BYTEA file data from database to fix 1.5+ minute query times
-- Date: Immediate
-- 
-- WARNING: This will permanently delete stored file data. Files should be in R2.
-- ============================================================================

-- STEP 1: Check for foreign key dependencies
-- First, let's see which records have file_data and might be referenced
SELECT 
    COUNT(*) as total_advertisers,
    COUNT(file_data) as advertisers_with_file_data,
    COUNT(media_r2_link) as advertisers_with_r2_link
FROM advertisers;

-- STEP 2: Check which advertisers with file_data also have R2 links
SELECT 
    id,
    company_name,
    email,
    CASE 
        WHEN file_data IS NOT NULL THEN 'HAS_FILE_DATA'
        ELSE 'NO_FILE_DATA'
    END as file_status,
    CASE 
        WHEN media_r2_link IS NOT NULL THEN 'HAS_R2_LINK'
        ELSE 'NO_R2_LINK'
    END as r2_status
FROM advertisers
WHERE file_data IS NOT NULL
ORDER BY id DESC
LIMIT 20;

-- STEP 3: Check video_advertiser_mappings foreign key constraint
-- Find any advertisers that are referenced in video_advertiser_mappings
SELECT 
    a.id,
    a.company_name,
    a.email,
    COUNT(vam.id) as mapping_count
FROM advertisers a
LEFT JOIN video_advertiser_mappings vam ON vam.advertiser_id = a.id
WHERE a.file_data IS NOT NULL
GROUP BY a.id, a.company_name, a.email
ORDER BY mapping_count DESC;

-- STEP 4: Delete mappings for advertisers with file_data (if safe to delete)
-- UNCOMMENT ONLY IF YOU WANT TO DELETE MAPPINGS:
-- DELETE FROM video_advertiser_mappings 
-- WHERE advertiser_id IN (
--     SELECT id FROM advertisers WHERE file_data IS NOT NULL
-- );

-- STEP 5: Clear file_data, file_original_name, and file_mime_type columns
-- This is the MAIN FIX for performance
UPDATE advertisers 
SET 
    file_data = NULL,
    file_original_name = NULL,
    file_mime_type = NULL
WHERE file_data IS NOT NULL;

-- STEP 6: Verify the cleanup
SELECT 
    COUNT(*) as total_advertisers,
    COUNT(file_data) as advertisers_with_file_data_remaining,
    COUNT(media_r2_link) as advertisers_with_r2_link
FROM advertisers;

-- STEP 7 (OPTIONAL): If you want to permanently remove the columns from the schema
-- WARNING: This cannot be undone easily. Only run if you're sure.
-- First, drop the foreign key constraint if it exists:
-- ALTER TABLE video_advertiser_mappings 
-- DROP CONSTRAINT IF EXISTS video_advertiser_mappings_advertiser_id_fkey;

-- Then drop the columns:
-- ALTER TABLE advertisers DROP COLUMN IF EXISTS file_data;
-- ALTER TABLE advertisers DROP COLUMN IF EXISTS file_original_name;
-- ALTER TABLE advertisers DROP COLUMN IF EXISTS file_mime_type;

-- ============================================================================
-- NOTES:
-- ============================================================================
-- 1. The UPDATE statement (Step 5) sets all file_data to NULL but keeps the column
--    This restores query performance while maintaining table structure
-- 
-- 2. The ALTER TABLE statements (Step 7) permanently remove the columns
--    Only run these if you're certain you'll never need file_data storage
-- 
-- 3. If you have foreign key constraint issues, you may need to:
--    a) Delete child records from video_advertiser_mappings first, OR
--    b) Temporarily drop the constraint, update, then recreate it
-- 
-- 4. After running Step 5, your database queries should be fast again
-- 
-- ============================================================================

