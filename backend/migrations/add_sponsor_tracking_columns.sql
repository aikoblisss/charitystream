-- Sponsor video tracking columns on sponsor_campaigns only.
-- Run once. If columns already exist, skip or use IF NOT EXISTS (PostgreSQL 9.5+).

ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS impressions_total BIGINT DEFAULT 0;
ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS clicks_total BIGINT DEFAULT 0;
ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS impressions_today INT DEFAULT 0;
ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS clicks_today INT DEFAULT 0;
ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS weekly_rollup_date DATE;
