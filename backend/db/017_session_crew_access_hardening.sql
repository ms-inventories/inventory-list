-- A consumed or revoked four-digit code must not be placed back into circulation
-- until its original lifetime ends. The reservation is deliberately independent
-- of the grant so deleting a session cannot make a recently shared code valid for
-- an unrelated session.
CREATE TABLE IF NOT EXISTS session_crew_code_reservations (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code_digest text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, code_digest),
  CHECK (expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS session_crew_code_reservations_expiry_idx
  ON session_crew_code_reservations(expires_at);

INSERT INTO session_crew_code_reservations (tenant_id, code_digest, expires_at, created_at)
SELECT tenant_id, code_digest, max(expires_at), min(created_at)
FROM session_crew_grants
WHERE expires_at > now()
GROUP BY tenant_id, code_digest
ON CONFLICT (tenant_id, code_digest) DO UPDATE
SET expires_at = GREATEST(session_crew_code_reservations.expires_at, EXCLUDED.expires_at);

CREATE INDEX IF NOT EXISTS session_crew_login_attempts_tenant_cleanup_idx
  ON session_crew_login_attempts(tenant_id, updated_at);
