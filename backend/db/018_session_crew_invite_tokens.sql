-- The short PIN is intentionally easy to share verbally, but it must only work
-- when paired with the high-entropy token carried by the one-time invite link.
-- Existing consumed grants remain valid through their auth session; legacy
-- pending PIN-only grants deliberately remain unusable.
ALTER TABLE session_crew_grants
  ADD COLUMN IF NOT EXISTS invite_token_digest text,
  ADD COLUMN IF NOT EXISTS invite_failure_count integer NOT NULL DEFAULT 0;

ALTER TABLE session_crew_grants
  DROP CONSTRAINT IF EXISTS session_crew_grants_invite_failure_count_check;

ALTER TABLE session_crew_grants
  ADD CONSTRAINT session_crew_grants_invite_failure_count_check
  CHECK (invite_failure_count >= 0);

CREATE UNIQUE INDEX IF NOT EXISTS session_crew_grants_invite_token_idx
  ON session_crew_grants(invite_token_digest)
  WHERE invite_token_digest IS NOT NULL;

ALTER TABLE session_crew_grants
  DROP CONSTRAINT IF EXISTS session_crew_grants_revoke_reason_check;

ALTER TABLE session_crew_grants
  ADD CONSTRAINT session_crew_grants_revoke_reason_check
  CHECK (revoke_reason IN (
    'leader_revoked',
    'session_closed',
    'session_deleted',
    'expired',
    'crew_logout',
    'attempt_limit'
  ));
