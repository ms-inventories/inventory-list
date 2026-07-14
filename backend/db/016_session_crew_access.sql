ALTER TABLE app_users
  ALTER COLUMN email DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS account_type text NOT NULL DEFAULT 'authentik';

ALTER TABLE app_users
  DROP CONSTRAINT IF EXISTS app_users_account_type_check;

ALTER TABLE app_users
  ADD CONSTRAINT app_users_account_type_check
  CHECK (account_type IN ('authentik', 'session_crew'));

CREATE TABLE IF NOT EXISTS session_crew_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  display_name text NOT NULL CHECK (char_length(btrim(display_name)) BETWEEN 2 AND 80),
  code_digest text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'consumed', 'revoked', 'expired')),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  consumed_by uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  revoked_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  revoke_reason text CHECK (revoke_reason IN ('leader_revoked', 'session_closed', 'session_deleted', 'expired')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (status <> 'consumed' OR (consumed_at IS NOT NULL AND consumed_by IS NOT NULL)),
  CHECK (status <> 'revoked' OR revoked_at IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS session_crew_grants_pending_code_idx
  ON session_crew_grants(tenant_id, code_digest)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS session_crew_grants_session_idx
  ON session_crew_grants(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_crew_auth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id uuid NOT NULL UNIQUE REFERENCES session_crew_grants(id) ON DELETE CASCADE,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES inventory_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE RESTRICT,
  token_digest text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS session_crew_auth_sessions_lookup_idx
  ON session_crew_auth_sessions(token_digest, expires_at)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS session_crew_auth_sessions_session_idx
  ON session_crew_auth_sessions(session_id, created_at DESC);

CREATE TABLE IF NOT EXISTS session_crew_login_attempts (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  fingerprint_digest text NOT NULL,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  failure_count integer NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
  locked_until timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, fingerprint_digest)
);

CREATE INDEX IF NOT EXISTS session_crew_login_attempts_cleanup_idx
  ON session_crew_login_attempts(updated_at);

ALTER TABLE media_uploads
  ADD COLUMN IF NOT EXISTS crew_auth_session_id uuid
    REFERENCES session_crew_auth_sessions(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS media_uploads_crew_auth_session_idx
  ON media_uploads(crew_auth_session_id)
  WHERE crew_auth_session_id IS NOT NULL;
