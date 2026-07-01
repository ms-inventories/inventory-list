# 876en.org Deployment Plan

This is the planned Coolify + Cloudflare Tunnel deployment path. GitHub Actions is active for Coolify deploy webhooks.

## Domains

Suggested public routes:

| Hostname | Service | Purpose |
| --- | --- | --- |
| `876en.org` | future marketing/newsletter site | Public homepage, announcements, newsletter signup |
| `<tenant>.876en.org` | React app | Tenant-specific platoon workspaces, such as `1st.876en.org` or `ms.876en.org` |
| `api.876en.org` | Express API | Backend API, media URLs, platform endpoints |
| `auth.876en.org` | Authentik | Identity provider and account login |
| `coolify.876en.org` | Coolify | Coolify dashboard, protect with Cloudflare Access |

If wildcard tunnel routes work cleanly in your Cloudflare account, route `*.876en.org` to the React app and let the backend resolve tenant from the subdomain. Put exact infrastructure routes above the wildcard so `api`, `auth`, and `coolify` go to the correct services.

## Cloudflare Tunnel Route Order

Create the exact service routes first:

| Hostname | Path | Service |
| --- | --- | --- |
| `876en.org` | empty | homepage/newsletter service |
| `www.876en.org` | empty | homepage/newsletter service |
| `auth.876en.org` | empty | Authentik service |
| `coolify.876en.org` | empty | Coolify service |
| `api.876en.org` | empty | backend API service |

Then create the wildcard tenant routes:

| Hostname | Path | Service |
| --- | --- | --- |
| `*.876en.org` | `^/api` | backend API service |
| `*.876en.org` | empty | React frontend service |

The wildcard API route must be above the wildcard frontend route. This lets tenant pages call same-origin `/api` while all normal page paths still load the React app.

If Coolify requires manual labels for the wildcard behavior, use the templates in [coolify-labels.md](coolify-labels.md).

If wildcard routing gives you trouble, create manual pairs for the first tenants:

| Hostname | Path | Service |
| --- | --- | --- |
| `1st.876en.org` | `^/api` | backend API service |
| `1st.876en.org` | empty | React frontend service |
| `ms.876en.org` | `^/api` | backend API service |
| `ms.876en.org` | empty | React frontend service |

## Initial Four Tenants

Use simple slugs until the real naming convention is decided:

```text
1st.876en.org
2nd.876en.org
3rd.876en.org
ms.876en.org
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
*.876en.org -> frontend service
```

Use exact routes for `auth.876en.org`, `coolify.876en.org`, and `api.876en.org` before the wildcard.

### Backend API

```text
Base directory: backend
Install command: npm ci
Start command: npm start
Port: 3000
```

Published route:

```text
api.876en.org -> backend service on port 3000
*.876en.org ^/api -> backend service on port 3000
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
PUBLIC_MEDIA_BASE_URL=https://api.876en.org/media
```

Recommended layout on NAS:

```text
inventory-uploads/
  tenants/
    1st/
      submissions/
      items/
    ms/
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

The Coolify deploy workflow is active:

```text
.github/workflows/coolify-deploy.yml
```

GitHub secrets used by the workflow:

```text
COOLIFY_FRONTEND_WEBHOOK_URL
COOLIFY_BACKEND_WEBHOOK_URL
COOLIFY_DEPLOY_TOKEN
```

The frontend webhook is required for the React app deploy. The backend webhook can stay empty until the backend resource is ready. The workflow uses the Coolify deploy webhook with a `GET` request and the deploy token as a bearer token.

The frontend job also accepts Coolify's generic doc-style secret names as a fallback:

```text
COOLIFY_WEBHOOK
COOLIFY_TOKEN
```
