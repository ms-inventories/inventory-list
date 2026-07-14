-- A member mutation that arrives while an external Authentik call is in flight
-- requests a restart without clearing the active lease. The worker promotes the
-- authoritative membership state only after the in-flight call has returned.
ALTER TABLE authentik_provisioning_jobs
  ADD COLUMN IF NOT EXISTS reconcile_requested boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS reconcile_requested_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS enrollment_dispatch_started_at timestamptz;

ALTER TABLE authentik_provisioning_jobs
  DROP CONSTRAINT IF EXISTS authentik_provisioning_reconcile_request_check;

ALTER TABLE authentik_provisioning_jobs
  ADD CONSTRAINT authentik_provisioning_reconcile_request_check
  CHECK (reconcile_requested OR reconcile_requested_by IS NULL);
