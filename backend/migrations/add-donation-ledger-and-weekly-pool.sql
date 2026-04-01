-- donation_ledger: one row per collected payment attributed to a week (sponsor one-time, etc.)
-- billing_record_id references sponsor_donations.id for sponsor one-time payments
CREATE TABLE IF NOT EXISTS donation_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_type TEXT NOT NULL,
    source_id UUID NOT NULL,
    billing_record_id BIGINT,
    amount DECIMAL(12,2) NOT NULL,
    week_start DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- weekly_donation_pool: per-week rollup of sponsor + advertiser donations (for payout)
CREATE TABLE IF NOT EXISTS weekly_donation_pool (
    week_start DATE PRIMARY KEY,
    sponsor_total DECIMAL(12,2) NOT NULL DEFAULT 0,
    advertiser_total DECIMAL(12,2) NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

-- Allow sponsor_billing without a checkout session (non-recurring card-on-file flow)
ALTER TABLE sponsor_billing
  ALTER COLUMN stripe_checkout_session_id DROP NOT NULL;
