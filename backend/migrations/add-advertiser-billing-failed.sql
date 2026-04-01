-- Add billing_failed flag to advertisers table
-- Set to TRUE when invoice.payment_failed fires for an advertiser invoice
-- Recurring campaigns are also paused (is_paused = TRUE) to stop serving ads
-- Admin must manually reset billing_failed = FALSE and is_paused = FALSE after resolving payment
ALTER TABLE advertisers ADD COLUMN IF NOT EXISTS billing_failed BOOLEAN NOT NULL DEFAULT FALSE;
