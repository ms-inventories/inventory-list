ALTER TABLE newsletter_subscribers
  ADD COLUMN IF NOT EXISTS platoon text,
  ADD COLUMN IF NOT EXISTS supervisor_name text,
  ADD COLUMN IF NOT EXISTS reviewed_by uuid REFERENCES app_users(id),
  ADD COLUMN IF NOT EXISTS reviewed_at timestamptz,
  ADD COLUMN IF NOT EXISTS review_note text;

ALTER TABLE newsletter_subscribers
  ALTER COLUMN status SET DEFAULT 'pending';

ALTER TABLE newsletter_subscribers
  DROP CONSTRAINT IF EXISTS newsletter_subscribers_status_check;

ALTER TABLE newsletter_subscribers
  ADD CONSTRAINT newsletter_subscribers_status_check
  CHECK (status IN ('pending', 'active', 'rejected', 'unsubscribed'));
