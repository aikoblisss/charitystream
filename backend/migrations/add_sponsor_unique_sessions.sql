-- Sponsor unique session tracking: one count per watch_session per sponsor campaign per day.
-- sponsor_campaigns.id is UUID; watch_sessions.id is INTEGER.

ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS unique_sessions_today INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS sponsor_unique_sessions (
  sponsor_campaign_id UUID NOT NULL,
  watch_session_id INTEGER NOT NULL,
  rollup_date DATE NOT NULL,
  PRIMARY KEY (sponsor_campaign_id, watch_session_id, rollup_date)
);

-- Optional: do not add FK to watch_sessions to avoid coupling; sponsor_campaign_id can reference sponsor_campaigns(id) if desired.
-- CREATE INDEX IF NOT EXISTS idx_sponsor_unique_sessions_rollup ON sponsor_unique_sessions (sponsor_campaign_id, rollup_date);
