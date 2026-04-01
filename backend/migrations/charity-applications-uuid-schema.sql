-- Optional: Use this only if charity_applications was created with SERIAL id.
-- Converts charity_applications to the exact schema (UUID id, status CHECK, nullable entry_payment_intent_id).
-- Run add-charity-week-pool.sql after this.

-- Add new UUID column
ALTER TABLE charity_applications ADD COLUMN IF NOT EXISTS id_uuid UUID DEFAULT gen_random_uuid();

-- Backfill: assign new UUIDs to existing rows (only if id is integer)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'charity_applications' AND column_name = 'id'
    AND data_type = 'integer'
  ) THEN
    UPDATE charity_applications SET id_uuid = gen_random_uuid() WHERE id_uuid IS NULL;
    ALTER TABLE charity_applications DROP CONSTRAINT IF EXISTS charity_applications_pkey;
    ALTER TABLE charity_applications RENAME COLUMN id TO id_old;
    ALTER TABLE charity_applications RENAME COLUMN id_uuid TO id;
    ALTER TABLE charity_applications ADD PRIMARY KEY (id);
    ALTER TABLE charity_applications DROP COLUMN IF EXISTS id_old;
  END IF;
END $$;

-- Ensure status constraint exists
ALTER TABLE charity_applications DROP CONSTRAINT IF EXISTS charity_applications_status_check;
ALTER TABLE charity_applications ADD CONSTRAINT charity_applications_status_check
  CHECK (status IN ('pending', 'approved', 'rejected'));

-- Ensure entry_payment_intent_id is nullable (no NOT NULL)
ALTER TABLE charity_applications ALTER COLUMN entry_payment_intent_id DROP NOT NULL;
