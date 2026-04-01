-- Drop the uniqueness constraint on video_filename
-- This constraint is not needed and causes issues with creative replacement
ALTER TABLE advertisers
DROP CONSTRAINT IF EXISTS advertisers_video_filename_unique;

