-- Charity week pool: links approved charity applications to a specific week.
-- charity_applications.id must be UUID (see schema in process-charity-approvals.js).
-- Run after charity_applications exists with UUID primary key.

CREATE TABLE IF NOT EXISTS charity_week_pool (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    charity_application_id UUID NOT NULL
        REFERENCES charity_applications(id)
        ON DELETE CASCADE,
    week_start DATE NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW(),
    UNIQUE(charity_application_id, week_start)
);
