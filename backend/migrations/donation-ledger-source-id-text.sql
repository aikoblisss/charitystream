-- Allow donation_ledger to support both sponsor (UUID) and advertiser (integer id) source_id
-- and billing_record_id as TEXT for serial ids from recurring_billing_records / non_recurring_billing_records
ALTER TABLE donation_ledger
  ALTER COLUMN source_id TYPE TEXT USING source_id::text;

ALTER TABLE donation_ledger
  ALTER COLUMN billing_record_id TYPE TEXT USING billing_record_id::text;

-- Unique constraint for idempotent inserts (source_id + week_start)
CREATE UNIQUE INDEX IF NOT EXISTS idx_donation_ledger_source_week
  ON donation_ledger (source_id, week_start);
