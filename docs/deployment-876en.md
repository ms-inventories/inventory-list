# 876en.org Deployment Plan

This is the planned Coolify + Cloudflare Tunnel deployment path. Nothing in GitHub Actions is active yet.

## Domains

Suggested public routes:

| Hostname | Service | Purpose |
| --- | --- | --- |
| `876en.org` | future marketing/newsletter site | Public homepage, announcements, newsletter signup |
| `inventory.876en.org` | React app | Main inventory app shell |
| `<tenant>.inventory.876en.org` | React app | Tenant-specific platoon workspaces |
| `api.inventory.876en.org` | Express API | Backend API, media URLs, Authentik token validation |
| `auth.876en.org` | Authentik | Identity provider and account login |
| `coolify.876en.org` | Coolify | Coolify dashboard, protect with Cloudflare Access |

If wildcard tunnel routes work cleanly in your Cloudflare account, route `*.inventory.876en.org` to the React app and let the backend resolve tenant from the subdomain. If not, start with the four tenant hostnames manually.

## Initial Four Tenants

Use simple slugs until the real naming convention is decided:

```text
first.inventory.876en.org
second.inventory.876en.org
third.inventory.876en.org
fourth.inventory.876en.org
```

The platform admin can create more tenants later.

## Coolify Apps

### Frontend

```text
Base directory: react-app
Install command: npm ci
Build command: npm run build
Publish directory: dist
```

Published routes:

```text
inventory.876en.org -> frontend service
*.inventory.876en.org -> frontend service
```

### Backend API

```text
Base directory: backend
Install command: npm ci
Start command: npm start
Port: 3000
```

Published route:

```text
api.inventory.876en.org -> backend service on port 3000
```

### Database

Use Postgres in Coolify.

Apply:

```text
backend/db/001_init.sql
```

## Local NAS Storage

Mount the NAS/share into the backend container and set:

```text
STORAGE_DRIVER=local
STORAGE_ROOT=/data/inventory-uploads
PUBLIC_MEDIA_BASE_URL=https://api.inventory.876en.org/media
```

Recommended layout on NAS:

```text
inventory-uploads/
  tenants/
    first/
      submissions/
      items/
    second/
```

Later backend work should add:

- upload endpoint
- image compression/normalization
- storage key generation by tenant/session/submission
- static media serving or signed download URLs

## Brevo Email

Use Brevo SMTP for welcome and invite emails.

Backend env:

```text
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<brevo smtp login>
SMTP_PASS=<brevo smtp key>
EMAIL_FROM_NAME=876 EN Inventory
EMAIL_FROM_ADDRESS=no-reply@876en.org
```

Later backend work should add:

- welcome email
- tenant invite email
- LT notification when an NCO submits a finding
- NCO notification when the LT requests more proof

## Authentik

Suggested host:

```text
auth.876en.org
```

Create an OAuth2/OpenID Connect provider for Inventory List.

Backend env:

```text
OIDC_ISSUER=https://auth.876en.org/application/o/inventory/
OIDC_AUDIENCE=inventory-api
OIDC_DISCOVERY_URL=https://auth.876en.org/application/o/inventory/.well-known/openid-configuration
OIDC_GROUPS_CLAIM=groups
PLATFORM_ADMIN_GROUP=inventory-platform-admins
```

App group:

```text
inventory-platform-admins
```

Tenant roles live in the app database. Authentik proves identity; the app decides tenant access.

## GitHub Actions

The workflow is intentionally inactive:

```text
.github/workflows/coolify-deploy.yml.disabled
```

When ready, rename it to:

```text
.github/workflows/coolify-deploy.yml
```

GitHub secrets to create before enabling:

```text
COOLIFY_FRONTEND_WEBHOOK_URL
COOLIFY_BACKEND_WEBHOOK_URL
COOLIFY_DEPLOY_TOKEN
```

Do not enable this until Coolify apps, routes, env vars, and database are ready.
