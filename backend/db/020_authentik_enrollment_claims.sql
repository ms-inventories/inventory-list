-- Coordinate one initial Authentik enrollment email across every tenant job for
-- the same app user. A durable owner prevents multiple API replicas from
-- sending concurrent recovery emails; failed/finished owners can be replaced.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS authentik_enrollment_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS authentik_enrollment_job_id uuid;

ALTER TABLE authentik_provisioning_jobs
  ADD COLUMN IF NOT EXISTS enrollment_resend_requested boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'app_users_authentik_enrollment_job_fk'
  ) THEN
    ALTER TABLE app_users
      ADD CONSTRAINT app_users_authentik_enrollment_job_fk
      FOREIGN KEY (authentik_enrollment_job_id)
      REFERENCES authentik_provisioning_jobs(id)
      ON DELETE SET NULL;
  END IF;
END
$$;

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_authentik_enrollment_check;

ALTER TABLE app_users
  ADD CONSTRAINT app_users_authentik_enrollment_check
  CHECK (
    authentik_user_pk IS NOT NULL
    OR (
      authentik_enrollment_sent_at IS NULL
      AND authentik_enrollment_job_id IS NULL
    )
  );

CREATE INDEX IF NOT EXISTS app_users_authentik_enrollment_job_idx
  ON app_users(authentik_enrollment_job_id)
  WHERE authentik_enrollment_job_id IS NOT NULL;
