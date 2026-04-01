-- Sponsor rejection processing: ensures we only process each rejected campaign once.
-- Script process-sponsor-rejections.js sets this to TRUE after successful Stripe action + email.
ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS rejection_processed BOOLEAN NOT NULL DEFAULT FALSE;
