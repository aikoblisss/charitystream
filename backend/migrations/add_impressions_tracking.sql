-- ============================================================================
-- ADD IMPRESSIONS TRACKING TO ADVERTISERS TABLE
-- ============================================================================
-- Purpose: Add video_filename and impressions tracking columns
-- Date: 2024
-- 
-- This migration adds:
-- 1. video_filename column (TEXT, UNIQUE, NULLABLE) - stores the final video filename
-- 2. current_week_impressions (INTEGER, DEFAULT 0)
-- 3. total_impressions (INTEGER, DEFAULT 0)
-- 4. current_week_start (TIMESTAMP WITH TIME ZONE)
-- 5. campaign_start_date (TIMESTAMP WITH TIME ZONE)
-- ============================================================================

-- Add video_filename column (UNIQUE, NULLABLE for older videos)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'advertisers' AND column_name = 'video_filename'
  ) THEN
    ALTER TABLE advertisers 
    ADD COLUMN video_filename TEXT UNIQUE;
    
    COMMENT ON COLUMN advertisers.video_filename IS 'Final video filename in charity-stream-videos bucket (e.g., video_7.mp4). NULL for older videos without impression tracking.';
  END IF;
END $$;

-- Add current_week_impressions column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'advertisers' AND column_name = 'current_week_impressions'
  ) THEN
    ALTER TABLE advertisers 
    ADD COLUMN current_week_impressions INTEGER DEFAULT 0;
    
    COMMENT ON COLUMN advertisers.current_week_impressions IS 'Number of impressions for the current week. Resets weekly.';
  END IF;
END $$;

-- Add total_impressions column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'advertisers' AND column_name = 'total_impressions'
  ) THEN
    ALTER TABLE advertisers 
    ADD COLUMN total_impressions INTEGER DEFAULT 0;
    
    COMMENT ON COLUMN advertisers.total_impressions IS 'Total impressions across all time. Never resets.';
  END IF;
END $$;

-- Add current_week_start column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'advertisers' AND column_name = 'current_week_start'
  ) THEN
    ALTER TABLE advertisers 
    ADD COLUMN current_week_start TIMESTAMP WITH TIME ZONE;
    
    COMMENT ON COLUMN advertisers.current_week_start IS 'Start timestamp of the current week (Sunday 00:00). Used for weekly reset logic.';
  END IF;
END $$;

-- Add campaign_start_date column
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'advertisers' AND column_name = 'campaign_start_date'
  ) THEN
    ALTER TABLE advertisers 
    ADD COLUMN campaign_start_date TIMESTAMP WITH TIME ZONE;
    
    COMMENT ON COLUMN advertisers.campaign_start_date IS 'Date when the campaign started. Used for weekly reset logic.';
  END IF;
END $$;

-- Set default values for existing rows (only if NULL)
UPDATE advertisers 
SET 
  current_week_impressions = COALESCE(current_week_impressions, 0),
  total_impressions = COALESCE(total_impressions, 0)
WHERE 
  current_week_impressions IS NULL 
  OR total_impressions IS NULL;

-- Verify the migration
SELECT 
  column_name, 
  data_type, 
  is_nullable,
  column_default
FROM information_schema.columns 
WHERE table_name = 'advertisers' 
  AND column_name IN (
    'video_filename', 
    'current_week_impressions', 
    'total_impressions',
    'current_week_start',
    'campaign_start_date'
  )
ORDER BY column_name;

