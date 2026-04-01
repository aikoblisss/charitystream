-- End date for non-recurring sponsor campaigns (UTC date). When end_at = today, Monday job sets status = 'ended'.
ALTER TABLE sponsor_campaigns ADD COLUMN IF NOT EXISTS end_at DATE;
