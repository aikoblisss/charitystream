-- ============================================================================
-- ADD IMPRESSION CAPS AND ARCHIVING COLUMNS TO ADVERTISERS TABLE
-- ============================================================================
-- Purpose: Add columns for impression cap enforcement and campaign archiving
-- Date: Immediate
-- 
-- This migration adds:
-- 1. max_weekly_impressions (INTEGER, NULLABLE) - Maximum impressions per week
-- 2. capped (BOOLEAN, DEFAULT false) - Whether campaign has reached its cap
-- 3. archived (BOOLEAN, DEFAULT false) - Whether campaign is archived
-- 4. archived_at (TIMESTAMP WITH TIME ZONE, NULLABLE) - When campaign was archived
-- 5. archived_reason (TEXT, NULLABLE) - Reason for archiving
-- ============================================================================

-- Add max_weekly_impressions column if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'advertisers' AND column_name = 'max_weekly_impressions') THEN
        ALTER TABLE advertisers ADD COLUMN max_weekly_impressions INTEGER;
        COMMENT ON COLUMN advertisers.max_weekly_impressions IS 'Maximum impressions allowed per week. NULL means no cap (non-recurring campaign).';
        RAISE NOTICE 'Added max_weekly_impressions column to advertisers table.';
    ELSE
        RAISE NOTICE 'Column max_weekly_impressions already exists.';
    END IF;
END $$;

-- Add capped column if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'advertisers' AND column_name = 'capped') THEN
        ALTER TABLE advertisers ADD COLUMN capped BOOLEAN DEFAULT false;
        COMMENT ON COLUMN advertisers.capped IS 'Whether the campaign has reached its weekly impression cap. Capped campaigns are excluded from playlist.';
        RAISE NOTICE 'Added capped column to advertisers table.';
    ELSE
        RAISE NOTICE 'Column capped already exists.';
    END IF;
END $$;

-- Add archived column if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'advertisers' AND column_name = 'archived') THEN
        ALTER TABLE advertisers ADD COLUMN archived BOOLEAN DEFAULT false;
        COMMENT ON COLUMN advertisers.archived IS 'Whether the campaign is archived. Archived campaigns are excluded from playlist.';
        RAISE NOTICE 'Added archived column to advertisers table.';
    ELSE
        RAISE NOTICE 'Column archived already exists.';
    END IF;
END $$;

-- Add archived_at column if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'advertisers' AND column_name = 'archived_at') THEN
        ALTER TABLE advertisers ADD COLUMN archived_at TIMESTAMP WITH TIME ZONE;
        COMMENT ON COLUMN advertisers.archived_at IS 'Timestamp when the campaign was archived.';
        RAISE NOTICE 'Added archived_at column to advertisers table.';
    ELSE
        RAISE NOTICE 'Column archived_at already exists.';
    END IF;
END $$;

-- Add archived_reason column if it doesn't exist
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'advertisers' AND column_name = 'archived_reason') THEN
        ALTER TABLE advertisers ADD COLUMN archived_reason TEXT;
        COMMENT ON COLUMN advertisers.archived_reason IS 'Reason why the campaign was archived.';
        RAISE NOTICE 'Added archived_reason column to advertisers table.';
    ELSE
        RAISE NOTICE 'Column archived_reason already exists.';
    END IF;
END $$;

-- Set default values for existing rows
UPDATE advertisers 
SET 
    capped = COALESCE(capped, false),
    archived = COALESCE(archived, false)
WHERE capped IS NULL OR archived IS NULL;

-- ============================================================================
-- VERIFICATION
-- ============================================================================
-- Run this to verify the columns were added:
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_name = 'advertisers'
--   AND column_name IN ('max_weekly_impressions', 'capped', 'archived', 'archived_at', 'archived_reason')
-- ORDER BY column_name;
-- ============================================================================

