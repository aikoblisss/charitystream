-- charity_week_winner: one winning charity per week (manual or automatic selection).
-- Run after charity_applications exists with UUID id.

CREATE TABLE IF NOT EXISTS charity_week_winner (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    charity_application_id UUID NOT NULL
        REFERENCES charity_applications(id)
        ON DELETE CASCADE,
    week_start DATE NOT NULL UNIQUE,
    selection_method TEXT NOT NULL
        CHECK (selection_method IN ('manual', 'automatic')),
    notification_sent_at TIMESTAMP,
    selected_at TIMESTAMP NOT NULL DEFAULT NOW()
);
