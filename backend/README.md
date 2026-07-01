# Inventory List API

This is the future SaaS backend for the Coolify-hosted React app.

It is intentionally separate from the static GitHub Pages app in the repository root.

## Responsibilities

- Resolve tenant from subdomain, such as `first.inventory.876en.org`.
- Validate Authentik-issued OIDC access tokens.
- Enforce tenant roles:
  - `platform_admin`: supply/main admin who can create tenants.
  - `tenant_admin`: LT or tenant owner.
  - `contributor`: NCO/soldier who can submit findings and evidence.
  - `viewer`: read-only access.
- Track inventory sessions, session items, submissions, photos, review requests, and audit events.

## Local Development

```bash
cp .env.example .env
npm install
npm run check
npm run dev
```

Apply the database schema in `db/001_init.sql` to a Postgres database before using the API.

When `ALLOW_DEV_AUTH=true`, you can simulate a user with headers:

```text
x-dev-sub: dev-user-1
x-dev-email: lt@example.com
x-dev-name: Demo LT
x-dev-groups: inventory-platform-admins
```

Disable `ALLOW_DEV_AUTH` in production.

## Coolify

Use `backend` as the base directory.

```text
Install command: npm ci
Start command: npm start
Port: 3000
```

Set environment variables from `.env.example` in Coolify.
