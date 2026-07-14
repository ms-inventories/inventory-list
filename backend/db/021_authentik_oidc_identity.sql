-- Preserve the immutable Authentik user UUID emitted by OIDC separately from
-- the mutable email and provider-specific subject. Provisioning and first login
-- must agree on this UUID before tenant access can be linked.
ALTER TABLE app_users
  ADD COLUMN IF NOT EXISTS authentik_oidc_user_uuid uuid;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_authentik_oidc_user_uuid_idx
  ON app_users(authentik_oidc_user_uuid)
  WHERE authentik_oidc_user_uuid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS app_users_authentik_identity_uuid_idx
  ON app_users(COALESCE(authentik_user_uuid, authentik_oidc_user_uuid))
  WHERE authentik_user_uuid IS NOT NULL OR authentik_oidc_user_uuid IS NOT NULL;

DO $$
BEGIN
  ALTER TABLE app_users
    ADD CONSTRAINT app_users_authentik_identity_uuid_match
    CHECK (
      authentik_user_uuid IS NULL
      OR authentik_oidc_user_uuid IS NULL
      OR authentik_user_uuid = authentik_oidc_user_uuid
    );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
