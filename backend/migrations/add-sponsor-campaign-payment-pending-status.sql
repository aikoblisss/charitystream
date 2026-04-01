-- Migration: Add 'payment_pending' to sponsor_campaigns status CHECK constraint
-- Run this against your Neon database

ALTER TABLE sponsor_campaigns
  DROP CONSTRAINT IF EXISTS sponsor_campaigns_status_check;

ALTER TABLE sponsor_campaigns
  ADD CONSTRAINT sponsor_campaigns_status_check
  CHECK (status = ANY (ARRAY[
    'pending_approval'::text,
    'approved'::text,
    'active'::text,
    'ended'::text,
    'rejected'::text,
    'payment_failed'::text,
    'payment_pending'::text
  ]));
