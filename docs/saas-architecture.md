# SaaS Architecture

This is the target architecture for the Coolify-hosted version of the app.

The static GitHub Pages app in the repository root can remain online while this version is built.

## Product Model

The app becomes a small multi-tenant inventory workflow system.

Each tenant is a platoon or unit workspace. Tenants are isolated by subdomain and database tenant ID.

Examples:

- `first.inventory.876en.org`
- `second.inventory.876en.org`
- `third.inventory.876en.org`
- `fourth.inventory.876en.org`

The supply/main admin can create more tenants later.

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
inventory-platform-admins
```

### Tenant Admin

Usually the LT for a platoon.

Can:

- Add platoon members to the tenant.
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
inventory.876en.org
```

The tenant slug is extracted from:

```text
first.inventory.876en.org
```

This resolves tenant slug:

```text
first
```

The database also supports explicit hostnames through `tenant_domains`, so aliases can be added later.

## Inventory Session Workflow

### 1. Tenant Admin Starts Session

The LT creates an inventory session from a packet or an existing item list.

If the packet does not include locations, the LT can add them while importing/scanning rows.

### 2. Contributors Submit Findings

NCOs open the tenant app and submit:

- Status: found, not found, mismatch, needs review.
- Location text.
- Notes.
- Serial number if known.
- Photos.

The session item moves to `needs_review`.

### 3. Tenant Admin Reviews Evidence

The LT can:

- Approve the finding.
- Reject it.
- Request more proof.

Examples of proof requests:

- "Need a serial number photo."
- "Need wider photo showing the cage/location."
- "Need quantity count."

### 4. Direct Check Mode

If the LT is doing the inventory personally, the LT can directly mark session items as found/approved without submitting evidence to himself.

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

- Frontend: `https://inventory.876en.org`
- Tenant frontend: `https://first.inventory.876en.org`
- API same origin path later: `/api`
- Or API subdomain: `https://api.inventory.876en.org`

Same-origin `/api` is preferred when practical because it simplifies CORS and cookies.

## Authentik Setup Notes

Create an OAuth2/OpenID provider and application for Inventory List.

Recommended settings:

- Provider type: OAuth2/OpenID Connect.
- Flow: Authorization Code + PKCE for the React app.
- Access token includes email, name, and groups.
- Redirect URI includes the Coolify frontend URL.
- Backend validates tokens using the provider discovery/JWKS endpoint.

Use Authentik groups for coarse access:

- `inventory-platform-admins`
- optional tenant groups such as `inventory-first-admins`, `inventory-first-contributors`

The app database remains the source of tenant membership and role inside a specific tenant. Authentik proves who the person is; the app decides what tenant role they have.

## Next Build Steps

1. Deploy `backend/` to Coolify with Postgres.
2. Apply `backend/db/001_init.sql`.
3. Create the Authentik OIDC provider and group.
4. Wire React login to Authentik.
5. Replace old S3 JSON reads with API calls.
6. Build tenant admin screens:
   - members
   - sessions
   - review queue
   - item DB maintenance
7. Add photo upload storage.
