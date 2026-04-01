-- Add phone_number to sponsor_accounts for Account tab in Sponsor Portal
ALTER TABLE sponsor_accounts
ADD COLUMN IF NOT EXISTS phone_number TEXT;
