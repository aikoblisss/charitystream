-- ADD stripe_customer_id TO advertiser_accounts TABLE
-- ============================================================================
-- Canonical Stripe customer per advertiser account for unified billing.
-- Billing tab and Checkout use this as source of truth (not advertisers.stripe_customer_id).
-- ============================================================================

ALTER TABLE advertiser_accounts
ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255);

-- Optional: index for lookups when validating customer exists
CREATE INDEX IF NOT EXISTS idx_advertiser_accounts_stripe_customer_id
ON advertiser_accounts(stripe_customer_id)
WHERE stripe_customer_id IS NOT NULL;
