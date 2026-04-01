-- ============================================================================
-- ADD PASSWORD RESET/CREATION COLUMNS TO advertiser_accounts TABLE
-- ============================================================================
-- Purpose: Add signup_token, signup_token_expires_at, password_reset_token, 
--          and password_reset_expires_at columns to support password creation
--          and reset functionality
-- Date: 2024
-- ============================================================================

-- Add signup token columns (for initial password creation)
ALTER TABLE advertiser_accounts
ADD COLUMN IF NOT EXISTS signup_token TEXT,
ADD COLUMN IF NOT EXISTS signup_token_expires_at TIMESTAMPTZ;

-- Add password reset token columns (for password reset flow)
ALTER TABLE advertiser_accounts
ADD COLUMN IF NOT EXISTS password_reset_token TEXT,
ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ;

-- Add initial setup token columns (for campaign submission/approval flow)
ALTER TABLE advertiser_accounts
ADD COLUMN IF NOT EXISTS initial_setup_token TEXT,
ADD COLUMN IF NOT EXISTS initial_setup_expires_at TIMESTAMPTZ;

-- Create indexes for faster token lookups
CREATE INDEX IF NOT EXISTS idx_advertiser_accounts_signup_token 
ON advertiser_accounts(signup_token) 
WHERE signup_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_advertiser_accounts_password_reset_token 
ON advertiser_accounts(password_reset_token) 
WHERE password_reset_token IS NOT NULL;

-- Create indexes for faster token lookups
CREATE INDEX IF NOT EXISTS idx_advertiser_accounts_initial_setup_token 
ON advertiser_accounts(initial_setup_token) 
WHERE initial_setup_token IS NOT NULL;

-- Verify columns were added
SELECT 
    column_name, 
    data_type, 
    is_nullable
FROM information_schema.columns
WHERE table_name = 'advertiser_accounts'
AND column_name IN ('signup_token', 'signup_token_expires_at', 'password_reset_token', 'password_reset_expires_at', 'initial_setup_token', 'initial_setup_expires_at')
ORDER BY column_name;

