-- ============================================================================
-- ADD phone_number COLUMN TO advertisers TABLE
-- ============================================================================
-- Purpose: Add phone_number column to support phone number storage in account settings
-- Date: 2024
-- ============================================================================

-- Add phone_number column (nullable TEXT)
ALTER TABLE advertisers
ADD COLUMN IF NOT EXISTS phone_number TEXT;

-- Verify column was added
SELECT 
    column_name, 
    data_type, 
    is_nullable
FROM information_schema.columns
WHERE table_name = 'advertisers'
AND column_name = 'phone_number';
