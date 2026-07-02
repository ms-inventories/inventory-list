# 876en.org Deployment Plan

This is the planned Coolify + Cloudflare Tunnel deployment path. GitHub Actions is active for Coolify deploy webhooks.

## Domains

Suggested public routes:

| Hostname | Service | Purpose |
| --- | --- | --- |
| `876en.org` | React app | Public FRG/newsletter splash page |
| `admin.876en.org` | React app | Platform admin console for creating platoons |
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
| `admin.876en.org` | empty | React frontend service |
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

Environment variables:

```text
VITE_BASE_DOMAIN=876en.org
VITE_API_BASE_URL=https://api.876en.org/api
VITE_NEWSLETTER_ACTION_URL=<optional brevo form action url>
VITE_OIDC_CLIENT_ID=inventory-web
VITE_OIDC_DISCOVERY_URL=https://auth.876en.org/application/o/inventory/.well-known/openid-configuration
VITE_OIDC_SCOPE=openid profile email groups
```

Published routes:

```text
admin.876en.org -> frontend service
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

Backend startup runs migrations automatically because `npm start` executes:

```text
npm run migrate && node src/server.js
```

The migration runner records applied files in `schema_migrations`. If the early schema files were already applied manually, it baselines those files and continues with anything missing. It also uses a Postgres advisory lock so overlapping deploys do not race.

You can still run `npm run migrate` manually from the backend resource terminal when you want to verify the database before starting or restarting the app.

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

Use Brevo SMTP for tenant invites and inventory workflow notifications.

Backend env:

```text
PUBLIC_APP_URL=https://876en.org
PLATFORM_ADMIN_EMAILS=<your root/admin email>
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<brevo smtp login>
SMTP_PASS=<brevo smtp key>
EMAIL_FROM_NAME=876 EN Inventory
EMAIL_FROM_ADDRESS=no-reply@876en.org
```

Implemented email events:

- tenant invite email
- LT/platoon-admin notification when an NCO submits a finding
- NCO notification when the LT requests more proof

The proof emails are best-effort. The API saves the inventory action first, then sends mail in the background so SMTP downtime does not block field work.

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

Production requires `PLATFORM_ADMIN_EMAILS` even if you also use the `inventory-platform-admins` group. Put your first supply/root admin email here, log in once, create the first platoons, then you can keep or narrow the allowlist after Authentik groups are verified.

Frontend OIDC notes:

- Configure the Authentik application as a public/OIDC client with PKCE.
- The frontend client ID should match `VITE_OIDC_CLIENT_ID`.
- Add redirect URIs for the public app/admin hosts you use, starting with `https://admin.876en.org/`. Tenant admin login on platoon subdomains will also need allowed redirect URIs such as `https://1st.876en.org/` and `https://ms.876en.org/`, or an Authentik wildcard/regex redirect rule if you choose to allow tenant-wide callback URLs.
- The public `876en.org` nav login dropdown points inventory users to `https://admin.876en.org/#/admin`; Authentik and the backend decide whether the signed-in user belongs to the inventory group or a tenant.
- Until Authentik is fully wired, the admin UI includes an access-token field so a valid bearer token can be pasted for testing.
- Tenant invitation links use `https://<tenant>.876en.org/#/accept-invite?token=...`. Authentik only sees the origin/path portion of that redirect URI, so the allowed redirect entry is the tenant root such as `https://1st.876en.org/`; the app restores the invite hash after login.

## Inventory Session Flow

The first React tenant-admin session flow is live:

- create an active inventory session from the platoon admin page
- paste hand-receipt packet rows into the session
- view session progress and row status
- let the LT directly mark rows found or not found when working alone
- let contributors/NCOs submit found/not-found/mismatch proof with location, serial, note, and photo
- show contributors the LT's request note and move those response items to the top
- let the LT review proof from a queue and approve, reject, or request more proof
- let the LT write a specific request note when asking for more proof
- show a proof history timeline in the LT review queue when an item has follow-up submissions
- show a close-out report on session detail with counts, unresolved rows, and a copyable text summary
- export complete close-out report rows as CSV
- print a clean close-out report that hides the admin console and includes the full reconciliation list
- import packet rows from pasted text, text/CSV files, PDFs, or photos through an LT review step before saving
- persist packet import batches with source files, extracted text, source links, and retry actions for platoon admins
- search and filter session rows by text, status, proof requests, review work, problems, and completed items
- auto-match imported session rows to known inventory items by LIN, NSN, title, and common-name signals
- notify platoon admins by email when proof is submitted
- notify the submitter by email when the LT requests more proof

The next backend/frontend slice should add a manual match/override control for session rows the automatic matcher misses or gets wrong.

## Production Cutover

Use this as the first real go-live pass.

1. Backend Coolify env is set from `backend/.env.example`, with `NODE_ENV=production`, `ALLOW_DEV_AUTH=false`, the production `DATABASE_URL`, and `PLATFORM_ADMIN_EMAILS` containing your root admin email.
2. Backend deploy logs show `migration complete: database is current`, or the backend terminal runs `npm run migrate` with the same result.
3. Backend `https://api.876en.org/health` returns `{ "ok": true }`.
4. Frontend Coolify env has `VITE_BASE_DOMAIN=876en.org`, `VITE_API_BASE_URL=https://api.876en.org/api`, and the Authentik discovery/client values.
5. Cloudflare routes include `admin.876en.org`, `876en.org`, `api.876en.org`, and the tenant wildcard or explicit tenant hostnames.
6. Authentik has redirect URIs for `https://admin.876en.org/`, `https://876en.org/`, and each first tenant host such as `https://1st.876en.org/` and `https://ms.876en.org/`.
7. Open `https://admin.876en.org/#/admin`, sign in with the email listed in `PLATFORM_ADMIN_EMAILS`, and confirm the header shows `Platform admin`.
8. Create the first tenants, for example `1st` and `ms`, assigning each LT email as the first platoon admin.
9. Open each tenant admin link, create a test inventory session, import a couple packet rows, invite one contributor, and submit/approve one proof item.
10. After the test pass, leave the root static GitHub Pages site online until you are comfortable moving the public homepage to the Coolify app.

## QA Environment

Use separate Coolify resources for QA when testing Authentik and inventory flows:

```text
qa.876en.org -> QA frontend
qa-api.876en.org -> QA backend
```

QA frontend env:

```text
VITE_BASE_DOMAIN=876en.org
VITE_API_BASE_URL=https://qa-api.876en.org/api
VITE_ENABLE_QA_AUTH=true
VITE_OIDC_CLIENT_ID=inventory-web
VITE_OIDC_DISCOVERY_URL=https://auth.876en.org/application/o/inventory/.well-known/openid-configuration
```

QA backend env:

```text
NODE_ENV=development
ALLOW_DEV_AUTH=true
DATABASE_URL=<qa-postgres-url>
BASE_DOMAIN=876en.org
PUBLIC_APP_URL=https://qa.876en.org
PUBLIC_MEDIA_BASE_URL=https://qa-api.876en.org/media
STORAGE_ROOT=/data/inventory-uploads-qa
```

Keep QA on a separate database and storage folder. Never enable `ALLOW_DEV_AUTH` on the production backend.

The QA frontend exposes root/LT/NCO persona buttons when `VITE_ENABLE_QA_AUTH=true`. A normal test pass should be:

1. Root admin creates a platoon with `qa-lt@876en.test` as the LT.
2. QA LT opens that platoon, creates a session, and pastes packet rows.
3. QA LT invites or directly creates contributor access for `qa-nco@876en.test`.
4. QA NCO opens Tasks, submits proof with a photo/location/serial.
5. QA LT opens Review and approves, requests more proof, or rejects.

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
