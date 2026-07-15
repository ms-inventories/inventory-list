# Permanent Authentik Provisioning

The permanent-account schema, client, and authority foundation are deployed. Production provisioning was enabled on 2026-07-15 after the dedicated Authentik service identity, recovery email stage, Coolify values, synchronous SMTP send, exact recovery-stage send, backend redeploy, and health check succeeded. The signed-in phone/desktop create-link-email-login smoke test and its tagged test-identity cleanup remain the final activation verification. The app database is authoritative for each tenant role and disabled state; Authentik provides the login identity and group claims, but must not re-enable an explicitly disabled database membership.

## Trust Boundary

- Use `https://auth.bensonhub.com` as the management origin. The backend appends `/api/v3`; do not include that path in `AUTHENTIK_API_ORIGIN`.
- Keep the browser login issuer separate. `OIDC_ISSUER` and `OIDC_DISCOVERY_URL` can continue to use the Inventory OIDC application under `https://auth.876en.org`.
- Never put a human administrator username or password in Coolify, the repository, an API request, or an app log. Provisioning must use a dedicated Authentik service account and API token.
- Store the API token only as a runtime secret in Coolify. Do not expose it as a frontend variable or build argument.
- The app creates no Authentik superusers and never needs permission to delete users, delete groups, view token keys, impersonate users, or access the Admin interface.

## Immutable OIDC Identity

Permanent provisioning requires an immutable Authentik user UUID at first sign-in. Email address, username, display name, and Authentik's numeric API `pk` are not safe identity keys because they can change or be reused.

The preferred configuration is:

1. Create an Authentik OAuth2/OpenID Scope Mapping with the requested scope name `ak_user_uuid`. Its expression must emit the signed-in user's immutable UUID as the claim `ak_user_uuid` (for example, a mapping result shaped like `{ "ak_user_uuid": str(request.user.uuid) }`). Do not derive this value from email, username, or a mutable attribute.
2. Attach the mapping to the Inventory OAuth2/OpenID Provider used by `auth.876en.org`.
3. Only after that mapping exists, set the frontend Coolify variable `VITE_OIDC_SCOPE=openid profile email groups ak_user_uuid`; a mapping attached to the provider is not emitted unless the client requests its scope name. Do not add the scope to the frontend first, because Authentik can reject every existing login with `invalid_scope` while the mapping is absent.
4. Sign in with a controlled account, inspect the decoded access/ID token, and confirm `ak_user_uuid` is a canonical UUID matching that user's `uuid` from the Authentik management API.
5. Set `OIDC_IMMUTABLE_USER_ID_CLAIM=ak_user_uuid` on the backend and leave `OIDC_SUBJECT_IS_USER_UUID=false`.

There is one supported alternative: if the Inventory provider is deliberately configured so its OIDC `sub` value is the Authentik user UUID, verify that behavior with more than one controlled account and set `OIDC_SUBJECT_IS_USER_UUID=true`. In that mode the backend uses `sub` as the immutable UUID and does not depend on the named claim. Do not enable this flag merely because a subject looks UUID-like; changing provider subject mode later changes identity and can lock users out.

Provisioning must remain disabled if neither verified configuration is available. On first login, the backend compares the OIDC UUID with the UUID returned by the Authentik management API. A missing or different UUID fails closed instead of linking an account by email alone.

## Prepare Authentik 2026.5.3

### Recovery email stage

1. Sign in to the Authentik Admin interface at `auth.bensonhub.com` with a human administrator account.
2. Confirm the Brand serving this hostname has a Recovery flow configured and that Authentik's worker can send email. When the stage uses global connection settings, configure `AUTHENTIK_EMAIL__HOST`, `AUTHENTIK_EMAIL__PORT`, `AUTHENTIK_EMAIL__USERNAME`, `AUTHENTIK_EMAIL__PASSWORD`, `AUTHENTIK_EMAIL__USE_TLS`, `AUTHENTIK_EMAIL__USE_SSL`, `AUTHENTIK_EMAIL__TIMEOUT`, and `AUTHENTIK_EMAIL__FROM` on the Authentik service. Port `587` normally uses `USE_TLS=true` and `USE_SSL=false`; port `465` normally uses the inverse. Never enable both TLS modes.
3. Open **Flows and Stages > Stages**. Select or create the general-purpose **Email Stage** used for account recovery. Do not use the Email Authenticator Setup stage.
4. Set the stage template, subject, sender, and SMTP behavior. The backend sends `token_duration=days=7`, so the generated recovery link expires after seven days even if the stage default differs.
5. Locate the stage UUID. While signed in as an administrator, open `https://auth.bensonhub.com/api/v3/stages/email/?ordering=name&page_size=100`, find the exact stage by `name`, and copy its `pk` UUID. An edit request for that row also uses `/api/v3/stages/email/<UUID>/`.
6. Record only the UUID for Coolify. Never copy an administrator session or browser credential into the app.

Run `ak test_email <controlled-address> -S "<stage name>"` from the Authentik worker/server environment before enabling provisioning. Also make one synchronous Django mail send when diagnosing queued retries so the underlying SMTP exception is visible. A `535 Authentication failed` response means the relay username or secret is invalid; do not enable provisioning or repeatedly retry enrollment until the relay credential is replaced and the test succeeds.

The recovery-email API also requires the calling service identity to have object-level **Can view Email Stage** on this exact stage. A missing Brand recovery flow, inaccessible stage, or broken SMTP setup will leave the app job retryable without granting tenant access.

### Dedicated service identity and role

1. Under **Directory > Roles**, create a role such as `inventory-provisioner`.
2. Assign only the permissions below. Keep reset/group-membership permissions object-scoped wherever possible: bind the selected Email Stage and existing `876en` groups directly, then use Authentik Initial Permissions so the role receives the listed user/group object permissions on app-created objects. Global view/add permissions are needed for exact lookup and creation.
3. Under **Directory > Users**, create a user-created **Service Account** dedicated to Inventory provisioning. Do not make it an Admin or superuser.
4. Assign the role to the service account, directly or through a dedicated group.
5. Create an expiring API token for this service account. Store the token in Coolify as `AUTHENTIK_API_TOKEN`, test the rollout, and revoke any superseded token.

The allowlist for the APIs used by this integration is:

| Authentik permission | Permission code | Why it is needed |
| --- | --- | --- |
| Can view user | `authentik_core.view_user` | Exact email lookup and linked-user reads |
| Can add user | `authentik_core.add_user` | Create a missing internal user |
| Reset Password | `authentik_core.reset_user_password` | Call the recovery-email action; scope to app-managed users when practical |
| Can view group | `authentik_core.view_group` | Exact base/tenant group lookup |
| Can add group | `authentik_core.add_group` | Create a missing `876en-<tenant>` group |
| Add user to group | `authentik_core.add_user_to_group` | Add the user to the base and tenant groups |
| Remove user from group | `authentik_core.remove_user_from_group` | Remove disabled memberships from the tenant group |
| Can view Email Stage | `authentik_stages_email.view_emailstage` | Object permission on the selected recovery Email Stage |

Do not grant `delete_*`, `enable_group_superuser`, `disable_group_superuser`, `impersonate`, `view_token_key`, or full Admin/superuser access. If a smoke test returns `403`, inspect the Authentik event for the exact denied permission before widening this allowlist.

The `876en` base group must already exist and is only a non-privileged login-eligibility group. It must have no parent groups and no assigned roles, must not enable superuser access, grant access to a tenant by itself, or use the tenant-group prefix. The worker validates those fields from Authentik and fails closed before changing membership. Membership in `876en` never replaces an explicit database tenant membership.

Tenant groups use the exact lowercase form `876en-<tenant-slug>`. They must also have no parent groups and no assigned roles. A newly created tenant group is tagged automatically and explicitly created with empty parent/role lists. Before enabling provisioning, tag every pre-existing tenant group in Authentik with `inventory_list_managed: true`, its exact lowercase `inventory_tenant_slug`, and the exact app `inventory_tenant_id` UUID returned for that workspace by the platform tenants API. An untagged, stale, privileged, inherited, or mismatched same-name group fails closed instead of receiving members. Reserved platform groups such as `876en-admins`, `876en-frg-admins`, and `876en-platoon-admin` are not provisioning targets and must never be parents of the base or tenant groups.

## Coolify Backend Environment

Set these values on the backend resource while leaving the feature off:

```text
AUTHENTIK_PROVISIONING_ENABLED=false
OIDC_IMMUTABLE_USER_ID_CLAIM=ak_user_uuid
OIDC_SUBJECT_IS_USER_UUID=false
AUTHENTIK_API_ORIGIN=https://auth.bensonhub.com
AUTHENTIK_API_TOKEN=<dedicated service-account API token>
AUTHENTIK_RECOVERY_EMAIL_STAGE_UUID=<recovery Email Stage pk UUID>
AUTHENTIK_RECOVERY_TOKEN_DURATION=days=7
AUTHENTIK_MANAGED_USER_PATH=users/inventory
AUTHENTIK_BASE_GROUP=876en
AUTHENTIK_TENANT_GROUP_PREFIX=876en-
AUTHENTIK_API_TIMEOUT_MS=8000
AUTHENTIK_PROVISIONING_POLL_MS=5000
AUTHENTIK_PROVISIONING_LEASE_SECONDS=90
AUTHENTIK_PROVISIONING_MAX_ATTEMPTS=8
```

Set this build-time value on the frontend resource before the production smoke test:

```text
VITE_OIDC_SCOPE=openid profile email groups ak_user_uuid
```

`AUTHENTIK_PROVISIONING_ENABLED=true` fails backend startup unless the origin is canonical HTTPS, the token is present, the stage value is a UUID, the managed path and group names are safe, and the recovery duration is `days=1` through `days=7`.

Keep `AUTHENTIK_PROVISIONING_LEASE_SECONDS` at least three times `AUTHENTIK_API_TIMEOUT_MS` (converted to seconds), plus five seconds for database and scheduler overhead. One idempotent create can perform three sequential Authentik requests, so this margin prevents another API replica from reclaiming the job while that operation is still settling. The documented 8-second timeout and 90-second lease already satisfy this rule; a 30-second timeout requires a lease of at least 95 seconds.

Keep `AUTHENTIK_TENANT_GROUP_FALLBACK_ENABLED=true` during this rollout for legacy users with no database membership row. An explicit invited, active, or disabled database membership is already authoritative. Set the fallback to `false` only after every legitimate provider-only user has a database membership and signed-in access has been verified.

## Enable Order

1. Deploy the additive database migration, Authentik client, durable job state, API routes, worker, and Team UI with `AUTHENTIK_PROVISIONING_ENABLED=false`, leaving the currently working frontend OIDC scopes unchanged.
2. Confirm `https://api.876en.org/health` is healthy and existing OIDC login, temporary crew codes, assignment, proof, review, and closeout still work.
3. Create and attach the immutable OIDC UUID mapping (or configure the explicitly verified UUID subject alternative). Then append `ak_user_uuid` to `VITE_OIDC_SCOPE`, redeploy the frontend, and verify normal login plus the emitted claim while backend provisioning is still off.
4. Configure and verify the recovery flow/stage, global or stage-specific SMTP delivery, least-privilege role, service account, expiring API token, base-group restrictions, and all backend Coolify values above. Redeploy once while the feature is still off. Do not continue until `ak test_email` succeeds through the exact recovery stage.
5. Confirm no secret appears in deployment logs or frontend assets. Confirm the human administrator password is absent from every app environment variable.
6. Change only `AUTHENTIK_PROVISIONING_ENABLED` to `true` and redeploy the backend.
7. Run the signed-in smoke test below at phone and desktop widths before inviting real users.

## Production Smoke Test

Use a controlled email address and a display name clearly tagged with the test date. Do not alter or delete an existing person merely because an email lookup links to that identity.

1. Sign in as a real tenant Leader and open **Team**.
2. Add one permanent **Team member**. Confirm the UI progresses from setup to enrollment sent/ready without exposing provider details.
3. In Authentik, confirm exactly one user exists, the app-created user is under `users/inventory`, and its attributes include `inventory_list_managed=true` and an `inventory_app_user_id`. Record its Authentik `uuid`.
4. Confirm membership in the non-superuser `876en` base group and only the intended `876en-<tenant>` group. Confirm no platform or admin group was added.
5. Open the enrollment email, set a password, and sign in. Confirm the emitted `ak_user_uuid` (or UUID `sub` in the alternative configuration) exactly matches the recorded management UUID. Confirm the user reaches only the intended tenant and has the selected database role.
6. Change Team member to Leader and back. Confirm the database role changes without granting a global Authentik admin group.
7. Disable/remove the test membership. Confirm tenant API access stops immediately, then confirm the tenant group is removed by reconciliation.
8. Retry or resend enrollment once and confirm no duplicate Authentik user, database membership, or email job is created.
9. Clean up only the test identity you created and positively identified by its test name, `users/inventory` path, app-managed attribute, and recorded app user ID. Do not delete a linked pre-existing identity or a tenant group still in use.

If Team reports that an enrollment email may already have been delivered, check the controlled inbox before selecting **Retry**. That state is intentionally never retried automatically: selecting **Retry** explicitly acknowledges that the first delivery is uncertain, safely releases the durable email owner, and records that acknowledgment in the tenant audit trail. A second recovery email is therefore possible, but a second Authentik user or membership must never be created.

### First-login and email-reuse verification

Before inviting real users, also test an existing, controlled Authentik account:

1. Record the account's Authentik UUID, then add that exact email from **Team**. Confirm the UI reaches **Ready** without sending a new-account recovery email and that no second Authentik user is created.
2. Sign in with that account. Confirm its token UUID matches the recorded management UUID, the existing local membership is linked, and no duplicate `app_users` row is created.
3. In an isolated test environment, exercise email reuse with two positively identified test identities: bind the local test membership to UUID A, then attempt login from UUID B using the same normalized email. The request must fail with an identity conflict; it must not move the membership, overwrite UUID A, or create access for UUID B.
4. Repeat once with the immutable claim omitted or malformed. First login for a provisioned test account must fail closed and leave the membership unlinked.

Never perform the email-reuse test by deleting, renaming, or taking over a real user's account. Keep the feature disabled if any first-login case links solely because the email matches.

Production activation is not complete until this test succeeds through a real signed-in browser and the tagged test identity is cleaned up.

## Rollback

1. Set `AUTHENTIK_PROVISIONING_ENABLED=false` and redeploy. This stops the worker and makes new permanent-account requests unavailable while leaving existing inventory work online.
2. Disable the affected database membership first; database authority blocks tenant access immediately even if Authentik reconciliation is delayed.
3. Revoke the service API token in Authentik if compromise or excess permission is suspected. Remove it from Coolify before issuing a replacement.
4. Leave the additive migration and durable job rows in place for diagnosis. Do not manually delete identities or groups unless they are positively tagged app-created test records and have no legitimate use.
5. Verify health, ordinary OIDC login, temporary crew access, assignment, proof, review, and closeout after rollback.

References:

- [Authentik service accounts](https://docs.goauthentik.io/sys-mgmt/service-accounts/)
- [Authentik roles and permissions](https://docs.goauthentik.io/users-sources/access-control/manage_permissions)
- [Authentik group-member permissions](https://docs.goauthentik.io/users-sources/groups/manage_groups#delegating-group-member-management)
- [Authentik Email Stage](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/email/)
