ALTER TABLE donation_ledger
  DROP CONSTRAINT IF EXISTS donation_ledger_source_type_check;

ALTER TABLE donation_ledger
  ADD CONSTRAINT donation_ledger_source_type_check
  CHECK (source_type IN ('advertiser', 'sponsor', 'direct_donation'));
