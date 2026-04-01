-- unique_viewers_today on sponsor_campaigns (anonymous viewer rollup per day).
-- Used by sponsor impression recording and Sponsor Portal dashboard.
ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS unique_viewers_today INT NOT NULL DEFAULT 0;
