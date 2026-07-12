# SaaS Architecture

This is the target architecture for the Coolify-hosted version of the app.

The static GitHub Pages app in the repository root can remain online while this version is built.

## Product Model

The app becomes a small multi-tenant inventory workflow system.

Each tenant is a platoon or unit workspace. Tenants are isolated by subdomain and database tenant ID.

Examples:

- `1st.876en.org`
- `2nd.876en.org`
- `3rd.876en.org`
- `ms.876en.org`

The supply/main admin can create more tenants later.

Initial platform/root access can come from either the Authentik `876en-admins` group or the backend `PLATFORM_ADMIN_EMAILS` allowlist. The email allowlist is the day-one escape hatch so one known account can create the first platoons before every Authentik group rule is polished.

## Identity

Authentik is the source of accounts and login.

Use an Authentik OAuth2/OpenID Connect provider for the app. The backend validates Authentik-issued access tokens and reads:

- `sub`: stable Authentik user ID.
- `email`: user email.
- `name` or `preferred_username`: display name.
- `groups`: role/group membership.

Authentik docs note that its OAuth2 provider supports OIDC and has provider-specific authorization, token, userinfo, JWKS, and discovery endpoints.

## Roles

### Platform Admin

Usually supply or the overall system owner.

Can:

- Create tenants.
- Assign tenant admins.
- Access any tenant for support.
- Configure initial tenant domains.

Suggested Authentik group:

```text
876en-admins
```

### Tenant Admin

Usually the platoon owner, PSG, or delegated inventory lead.

Can:

- Invite platoon members to the tenant.
- Start inventory sessions.
- Scan/import packet rows.
- Assign or publish inventory tasks.
- Directly check off items if doing the inventory personally.
- Review submitted evidence.
- Approve findings.
- Request more proof, such as serial number photos.
- Add or update DB item records.

### Contributor

Usually NCOs or soldiers helping with the inventory.

Can:

- View assigned/current session items.
- Mark an item found, not found, mismatch, or needs review.
- Submit location notes.
- Upload evidence photos.
- Add serial numbers or extra notes when requested.

### Viewer

Read-only access to the tenant inventory.

## Tenant Routing

The backend resolves tenant context from the request hostname.

For a base domain of:

```text
876en.org
```

The tenant slug is extracted from:

```text
1st.876en.org
```

This resolves tenant slug:

```text
1st
```

The database also supports explicit hostnames through `tenant_domains`, so aliases can be added later.

## Inventory Session Workflow

### 1. Tenant Admin Starts Session

The platoon admin creates an inventory session from a packet or an existing item list.

If the packet does not include locations, the platoon admin can add them while importing/scanning rows.

### 2. Contributors Submit Findings

NCOs open the tenant app and submit:

- Status: found, not found, mismatch, needs review.
- Location text.
- Notes.
- Serial number if known.
- Photos.

The session item moves to `needs_review`.

### 3. Tenant Admin Reviews Evidence

The platoon admin can:

- Approve the finding.
- Reject it.
- Request more proof.

Examples of proof requests:

- "Need a serial number photo."
- "Need wider photo showing the cage/location."
- "Need quantity count."

### 4. Direct Check Mode

If the platoon admin is doing the inventory personally, they can directly mark session items as found/approved without submitting evidence to themselves.

## Backend Apps

### React App

Path:

```text
react-app/
```

Coolify deploys this as the frontend.

### API

Path:

```text
backend/
```

Coolify deploys this as the Express API service.

Suggested routes:

- Public homepage: `https://876en.org`
- Tenant frontend: `https://1st.876en.org`
- Tenant API: same-origin `/api`
- Platform/API/media subdomain: `https://api.876en.org`

Same-origin tenant `/api` is preferred because it lets the backend resolve tenant access from the hostname.

Evidence photos and packet-source files require a short-lived, HMAC-protected, host-only HttpOnly media-session cookie issued only after tenant authorization. The cookie is scoped to one tenant's media path, the media route verifies the storage key is linked to an allowed database record, and packet sources require platoon-admin access. Media responses are private/no-store and do not opt into CORS. The signing secret is a dedicated backend-only Coolify secret and is never reused from OIDC or Postgres.

Production tenant frontends and `api.876en.org` are same-site, so `SameSite=Strict` remains usable without broadening the cookie to sibling hosts. Local Docker QA proxies `/api` and `/media` through the Vite tenant origin because Chromium correctly treats `ms.localhost` and bare `localhost` as different sites.

Photo writes use a separate upload registry. The server records the tenant, uploader, declared purpose, detected image signature, actual byte size, expiry, and lifecycle before returning an opaque upload ID. Evidence and known-item transactions consume that ID once under a database row lock; client-supplied storage paths are not an attachment authority. Packet sources enter the same registry already attached to their immutable import batch. An hourly cleanup command deletes only expired staged files, while attached evidence remains retained through session closeout.

Tenant settings reuse `tenants.name` for workspace identity and `tenant_guidance.body` for member instructions. Tenant-wide in-app and workflow-email preferences live in `tenant_settings`; workspace URLs, slugs, and Authentik group mappings remain derived/read-only so application settings cannot silently change identity policy.

The admin Reports view reads one tenant-scoped aggregate endpoint across inventory sessions and rows. Each row includes only the latest proof decision needed for outcome and proof-work classification; evidence files and packet payloads are excluded. CSV and print output are produced from the same active client filters shown on screen.

## Authentik Setup Notes

Create an OAuth2/OpenID provider and application for Inventory List.

Recommended settings:

- Provider type: OAuth2/OpenID Connect.
- Flow: Authorization Code + PKCE for the React app.
- Access token includes email, name, and groups.
- Redirect URI includes the Coolify frontend URL.
- Backend validates tokens using the provider discovery/JWKS endpoint.

Use Authentik groups for coarse access:

- `876en-admins`: global support/superuser access to all tenants.
- `876en-frg-admins`: FRG/newsletter content admin access.
- `876en-<tenant>`: tenant membership, for example `876en-ms`.
- `876en-platoon-admin`: tenant admin capability when combined with a tenant group.

The app can derive day-to-day access from these Authentik groups and still keep database memberships/invitations for app-created access. Authentik proves who the person is; the app decides the effective tenant role.

## Next Build Steps

1. Deploy `backend/` to Coolify with Postgres.
2. Run `npm run migrate` in the backend resource so every file in `backend/db/` is applied or baselined.
3. Create the Authentik OIDC provider and group.
4. Wire React login to Authentik.
5. Replace old S3 JSON reads with API calls.
6. Build tenant admin screens:
   - members
   - sessions
   - review queue
   - item DB maintenance
7. Add photo upload storage.
