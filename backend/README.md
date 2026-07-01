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

## Local Development

```bash
cp .env.example .env
npm install
npm run check
npm run dev
```

Apply the database schema in `db/001_init.sql` to a Postgres database before using the API. If `001_init.sql` was already applied, run `db/002_tenant_admin_invites.sql` next.

When `ALLOW_DEV_AUTH=true`, you can simulate a user with headers:

```text
x-dev-sub: dev-user-1
x-dev-email: lt@example.com
x-dev-name: Demo LT
x-dev-groups: inventory-platform-admins
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

- The Authentik token includes the `inventory-platform-admins` group.
- The authenticated email is listed in `PLATFORM_ADMIN_EMAILS`.

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

## Coolify

Use `backend` as the base directory.

```text
Install command: npm ci
Start command: npm start
Port: 3000
```

Set environment variables from `.env.example` in Coolify.
