-- Permanent account provisioning is reconciled from the app's authoritative
-- tenant membership. Keep Authentik's API identifiers separate from the OIDC
-- subject: Authentik uses the numeric PK in API paths and exposes an immutable
-- UUID for durable identity matching.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS authentik_user_pk bigint,
  ADD COLUMN IF NOT EXISTS authentik_user_uuid uuid,
  ADD COLUMN IF NOT EXISTS authentik_managed_by_app boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS authentik_linked_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_authentik_user_pk_idx
  ON app_users(authentik_user_pk)
  WHERE authentik_user_pk IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_authentik_user_uuid_idx
  ON app_users(authentik_user_uuid)
  WHERE authentik_user_uuid IS NOT NULL;

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_authentik_link_check;

ALTER TABLE app_users
  ADD CONSTRAINT app_users_authentik_link_check
  CHECK (
    (
      authentik_user_pk IS NULL
      AND authentik_user_uuid IS NULL
      AND authentik_linked_at IS NULL
      AND authentik_managed_by_app = false
    )
    OR
    (
      account_type = 'authentik'
      AND authentik_user_pk IS NOT NULL
      AND authentik_user_pk > 0
      AND authentik_user_uuid IS NOT NULL
      AND authentik_linked_at IS NOT NULL
    )
  );

-- One current reconciliation job per membership prevents competing desired
-- states. target_revision fences an in-flight worker when a leader changes the
-- role or disables/re-enables the membership during an external API call.
CREATE TABLE IF NOT EXISTS authentik_provisioning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_membership_id uuid NOT NULL UNIQUE
    REFERENCES tenant_memberships(id) ON DELETE CASCADE,
  desired_role text NOT NULL
    CHECK (desired_role IN ('tenant_admin', 'contributor', 'viewer')),
  desired_state text NOT NULL DEFAULT 'active'
    CHECK (desired_state IN ('active', 'disabled')),
  current_step text NOT NULL DEFAULT 'identity'
    CHECK (current_step IN ('identity', 'groups', 'enrollment', 'complete')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'retry_wait', 'succeeded', 'failed')),
  target_revision integer NOT NULL DEFAULT 1 CHECK (target_revision > 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  requested_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  enrollment_required boolean,
  enrollment_sent_at timestamptz,
  last_attempt_at timestamptz,
  next_attempt_at timestamptz,
  last_error_code text,
  last_safe_error text,
  last_error_at timestamptz,
  lease_token uuid,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (
    (last_error_code IS NULL AND last_safe_error IS NULL AND last_error_at IS NULL)
    OR
    (
      last_error_code IS NOT NULL
      AND char_length(last_error_code) BETWEEN 1 AND 80
      AND last_safe_error IS NOT NULL
      AND char_length(last_safe_error) BETWEEN 1 AND 300
      AND last_error_at IS NOT NULL
    )
  ),
  CHECK (
    (status = 'running' AND lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
    OR
    (status <> 'running' AND lease_token IS NULL AND lease_expires_at IS NULL)
  ),
  CHECK (
    (status = 'retry_wait' AND next_attempt_at IS NOT NULL)
    OR
    (status <> 'retry_wait' AND next_attempt_at IS NULL)
  ),
  CHECK (enrollment_sent_at IS NULL OR enrollment_required = true),
  CHECK (
    (status = 'succeeded' AND current_step = 'complete' AND completed_at IS NOT NULL)
    OR
    (status <> 'succeeded' AND current_step <> 'complete' AND completed_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS authentik_provisioning_jobs_ready_idx
  ON authentik_provisioning_jobs(status, next_attempt_at, updated_at)
  WHERE status IN ('pending', 'retry_wait');

CREATE INDEX IF NOT EXISTS authentik_provisioning_jobs_stale_lease_idx
  ON authentik_provisioning_jobs(lease_expires_at)
  WHERE status = 'running';
