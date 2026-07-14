-- Serialize and enforce immutable Authentik UUID ownership across management
-- API UUIDs, OIDC UUID claims, and legacy UUID-subject identities.
LOCK TABLE app_users IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM (
      SELECT id, authentik_user_uuid AS identity_uuid
      FROM app_users
      WHERE authentik_user_uuid IS NOT NULL
      UNION
      SELECT id, authentik_oidc_user_uuid
      FROM app_users
      WHERE authentik_oidc_user_uuid IS NOT NULL
      UNION
      SELECT id,
        CASE
          WHEN authentik_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            THEN authentik_subject::uuid
          ELSE NULL
        END
      FROM app_users
    ) identities
    WHERE identity_uuid IS NOT NULL
    GROUP BY identity_uuid
    HAVING COUNT(DISTINCT id) > 1
  ) THEN
    RAISE EXCEPTION 'Conflicting immutable Authentik UUID ownership exists'
      USING ERRCODE = '23505';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_app_user_authentik_uuid_ownership()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  candidate uuid;
BEGIN
  FOR candidate IN
    SELECT DISTINCT identity_uuid
    FROM (
      VALUES
        (NEW.authentik_user_uuid),
        (NEW.authentik_oidc_user_uuid),
        (
          CASE
            WHEN NEW.authentik_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN NEW.authentik_subject::uuid
            ELSE NULL
          END
        )
    ) candidates(identity_uuid)
    WHERE identity_uuid IS NOT NULL
    ORDER BY identity_uuid
  LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended(candidate::text, 0));
    IF EXISTS (
      SELECT 1
      FROM app_users existing
      WHERE existing.id <> NEW.id
        AND (
          existing.authentik_user_uuid = candidate
          OR existing.authentik_oidc_user_uuid = candidate
          OR CASE
            WHEN existing.authentik_subject ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
              THEN existing.authentik_subject::uuid
            ELSE NULL
          END = candidate
        )
    ) THEN
      RAISE EXCEPTION 'Immutable Authentik UUID is already owned by another app user'
        USING ERRCODE = '23505';
    END IF;
  END LOOP;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS app_users_authentik_uuid_ownership ON app_users;
CREATE TRIGGER app_users_authentik_uuid_ownership
BEFORE INSERT OR UPDATE OF authentik_subject, authentik_user_uuid, authentik_oidc_user_uuid
ON app_users
FOR EACH ROW
EXECUTE FUNCTION enforce_app_user_authentik_uuid_ownership();
