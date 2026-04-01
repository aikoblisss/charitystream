-- Viewer direct donations rolled into weekly pool and allocation
ALTER TABLE weekly_donation_pool
  ADD COLUMN IF NOT EXISTS viewer_total DECIMAL(12,2) NOT NULL DEFAULT 0;

ALTER TABLE weekly_charity_allocation
  ADD COLUMN IF NOT EXISTS viewer_amount DECIMAL(12,2) NOT NULL DEFAULT 0;
