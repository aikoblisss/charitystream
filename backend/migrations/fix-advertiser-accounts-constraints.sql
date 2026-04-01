-- ============================================================================
-- FIX advertiser_accounts TABLE CONSTRAINTS
-- ============================================================================
-- Purpose: 
--   1. Make email UNIQUE (case-insensitive)
--   2. Make advertiser_id nullable and NOT unique (multiple campaigns can share one account)
--   3. Ensure email is always stored in lowercase
-- Date: 2024
-- ============================================================================

-- Step 1: Normalize all existing emails to lowercase
UPDATE advertiser_accounts
SET email = LOWER(TRIM(email))
WHERE email IS NOT NULL;

-- Step 2: Drop existing unique constraint on advertiser_id if it exists
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM pg_constraint 
        WHERE conname = 'advertiser_accounts_advertiser_id_key'
    ) THEN
        ALTER TABLE advertiser_accounts DROP CONSTRAINT advertiser_accounts_advertiser_id_key;
    END IF;
END $$;

-- Step 3: Ensure advertiser_id can be NULL
ALTER TABLE advertiser_accounts
ALTER COLUMN advertiser_id DROP NOT NULL;

-- Step 4: Add UNIQUE constraint on email (case-insensitive via LOWER)
-- First, ensure no duplicate emails exist
DO $$
DECLARE
    duplicate_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO duplicate_count
    FROM (
        SELECT LOWER(TRIM(email)) as normalized_email
        FROM advertiser_accounts
        WHERE email IS NOT NULL
        GROUP BY LOWER(TRIM(email))
        HAVING COUNT(*) > 1
    ) duplicates;
    
    IF duplicate_count > 0 THEN
        RAISE EXCEPTION 'Cannot add unique constraint: duplicate emails exist. Please resolve duplicates first.';
    END IF;
END $$;

-- Step 5: Add unique constraint on email
-- Use a unique index with LOWER() to enforce case-insensitive uniqueness
CREATE UNIQUE INDEX IF NOT EXISTS idx_advertiser_accounts_email_unique
ON advertiser_accounts(LOWER(TRIM(email)))
WHERE email IS NOT NULL;

-- Step 6: Add a check constraint to ensure email is always lowercase
ALTER TABLE advertiser_accounts
ADD CONSTRAINT check_email_lowercase
CHECK (email = LOWER(TRIM(email)));

-- Step 7: Verify constraints
SELECT 
    conname as constraint_name,
    contype as constraint_type,
    pg_get_constraintdef(oid) as constraint_definition
FROM pg_constraint
WHERE conrelid = 'advertiser_accounts'::regclass
ORDER BY conname;

-- Step 8: Verify indexes
SELECT 
    indexname,
    indexdef
FROM pg_indexes
WHERE tablename = 'advertiser_accounts'
ORDER BY indexname;

