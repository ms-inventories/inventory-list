# Inventory List API

This is the future SaaS backend for the Coolify-hosted React app.

It is intentionally separate from the static GitHub Pages app in the repository root.

## Responsibilities

- Resolve tenant from subdomain, such as `1st.876en.org` or `ms.876en.org`.
- Validate Authentik-issued OIDC access tokens.
- Enforce tenant roles:
  - `platform_admin`: supply/main admin who can create tenants.
  - `tenant_admin`: LT or tenant owner.
  - `contributor`: NCO/soldier who can submit findings and evidence.
  - `viewer`: read-only access.
- Track inventory sessions, session items, submissions, photos, review requests, and audit events.
- Bootstrap platform access with either an Authentik admin group or `PLATFORM_ADMIN_EMAILS`.
- Let platform admins create platoons and assign the first platoon admin.
- Let platoon admins invite contributors, viewers, or additional platoon admins.
- Derive day-to-day tenant access from Authentik groups:
  - `876en-admins`: global support/superuser access to every tenant.
  - `876en-frg-admins`: public FRG site editor access.
  - `876en-<tenant>`: access to that tenant, for example `876en-ms`.
  - `876en-platoon-admin`: admin capability inside any tenant group the user also belongs to.

## Local Development

```bash
cp .env.example .env
npm install
npm run check
npm run migrate
npm run dev
```

Run `npm run migrate` before using the API. The migration runner applies every SQL file in `db/` once and can safely baseline a database where the first schema files were already applied manually.

In production, `npm start` runs migrations before launching the server. The runner uses a Postgres advisory lock so overlapping redeploys wait instead of racing each other.

When `ALLOW_DEV_AUTH=true`, you can simulate a user with headers:

```text
x-dev-sub: dev-user-1
x-dev-email: lt@example.com
x-dev-name: Demo LT
x-dev-groups: 876en-ms,876en-platoon-admin
```

Disable `ALLOW_DEV_AUTH` in production.

## Admin Model

Platform/root admins can create platoons with:

```text
POST /api/platform/tenants
```

Request body:

```json
{
  "name": "1st Platoon",
  "slug": "1st",
  "adminEmail": "lt@example.com",
  "adminDisplayName": "1LT Example"
}
```

That creates `1st.876en.org` as the primary tenant hostname and makes the LT a `tenant_admin`.

Platform admin access is granted when either condition is true:

- The Authentik token includes the `876en-admins` group.
- The authenticated email is listed in `PLATFORM_ADMIN_EMAILS`.

Tenant access can also come directly from Authentik. A user in `876en-ms` can work the MS tenant as a contributor. A user in both `876en-ms` and `876en-platoon-admin` can administer the MS tenant. A user in `876en-admins` can jump into every tenant for support.

Tenant admins can invite helpers with:

```text
POST /api/tenant/invitations
```

Request body:

```json
{
  "email": "nco@example.com",
  "displayName": "SSG Example",
  "role": "contributor"
}
```

The API stores a pending invite, returns the invite URL, and sends email through SMTP when Brevo is configured. If SMTP is not configured, the invite still exists and the response includes the invite URL for manual sharing.

Invite roles:

- `tenant_admin`: LT or delegated inventory lead.
- `contributor`: NCO/soldier who can submit findings and proof.
- `viewer`: read-only access.

The same SMTP settings also power best-effort inventory workflow notifications:

- platoon admins get an email when proof is submitted for review
- the submitter gets an email when a platoon admin requests more proof

The API saves the inventory change before sending these messages, so SMTP downtime does not block submissions or reviews.

## Coolify

Use `backend` as the base directory.

```text
Install command: npm ci
Start command: npm start
Port: 3000
```

Set environment variables from `.env.example` in Coolify.
