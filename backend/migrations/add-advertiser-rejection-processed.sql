-- Advertiser rejection processing: ensures we only process each rejected campaign once.
-- Script process-advertiser-rejections.js sets this to TRUE after successful Stripe action + email.
ALTER TABLE advertisers ADD COLUMN IF NOT EXISTS rejection_processed BOOLEAN NOT NULL DEFAULT FALSE;
