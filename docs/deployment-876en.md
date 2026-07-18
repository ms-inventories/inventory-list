# 876en.org Deployment Plan

This is the active Coolify + Cloudflare Tunnel deployment path. GitHub Actions deploys from `main` through Coolify webhooks.

## Domains

Suggested public routes:

| Hostname | Service | Purpose |
| --- | --- | --- |
| `876en.org` | React app | Public FRG/newsletter splash page |
| `admin.876en.org` | React app | Platform admin console for creating platoons |
| `<tenant>.876en.org` | React app | Tenant-specific platoon workspaces, such as `1st.876en.org` or `ms.876en.org` |
| `api.876en.org` | Express API | Backend API, media URLs, platform endpoints |
| `auth.876en.org` | Authentik | Identity provider and account login |
| `coolify.bensonhub.com` | Coolify | Live Coolify dashboard and API control plane |

If wildcard tunnel routes work cleanly in your Cloudflare account, route `*.876en.org` to the React app and let the backend resolve tenant from the subdomain. Put exact `api` and `auth` routes above the wildcard. Coolify is hosted separately at `coolify.bensonhub.com`.

## Cloudflare Tunnel Route Order

Create the exact service routes first:

| Hostname | Path | Service |
| --- | --- | --- |
| `876en.org` | empty | homepage/newsletter service |
| `www.876en.org` | empty | homepage/newsletter service |
| `admin.876en.org` | empty | React frontend service |
| `auth.876en.org` | empty | Authentik service |
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
VITE_OIDC_CLIENT_ID=<authentik inventory client id>
VITE_OIDC_DISCOVERY_URL=https://auth.876en.org/application/o/inventory-web/.well-known/openid-configuration
VITE_OIDC_AUTHORIZATION_ENDPOINT=https://auth.876en.org/application/o/authorize/
VITE_OIDC_TOKEN_ENDPOINT=https://auth.876en.org/application/o/token/
VITE_OIDC_SCOPE=openid profile email groups ak_user_uuid
VITE_ENABLE_AUTH_DIAGNOSTICS=false
```

Do not set the production frontend to `VITE_API_BASE_URL=/api` unless you have a working path route from every frontend hostname to the backend. With the current Cloudflare/Coolify setup, use `https://api.876en.org/api`; otherwise `https://876en.org/api/me` can return the React app HTML instead of backend JSON.

Published routes:

```text
admin.876en.org -> frontend service
*.876en.org -> frontend service
```

Use exact routes for `auth.876en.org` and `api.876en.org` before the wildcard. Manage deployment tokens at `coolify.bensonhub.com`; `coolify.876en.org` is a reserved but currently unused alias.

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
MEDIA_SIGNING_SECRET=<base64-encoded 32-byte-or-longer random secret>
MEDIA_SESSION_TTL_SECONDS=300
MEDIA_UPLOAD_STAGING_TTL_HOURS=24
```

`PUBLIC_MEDIA_BASE_URL` defaults to `https://api.<BASE_DOMAIN>/media` in production and should point back to this API's `/media` route. Authorized tenant API activity issues a short-lived, host-only, HttpOnly, tenant-path-scoped media-session cookie; copied media URLs fail without that cookie, and packet-source files additionally require platoon-admin access. Media responses deliberately do not opt into CORS. New photos stay staged for `MEDIA_UPLOAD_STAGING_TTL_HOURS` until an authorized evidence/reference transaction consumes their opaque upload ID. Generate `MEDIA_SIGNING_SECRET` independently from the database and OIDC credentials, encode it as base64, and keep it only in the Coolify secret store. If it is temporarily absent, the API uses a process-local random key and logs a warning instead of taking the entire service offline; set the persistent value before scaling beyond one API instance.

Schedule this backend command at least hourly in Coolify to remove expired, unattached files. It row-locks expired uploads, treats an already-missing file as cleaned, records an audit event, and never selects attached media:

```bash
npm --prefix backend run cleanup:media
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

Later storage work should add:

- image compression/normalization
- content hashes and a reconciliation report for legacy/unregistered NAS files
- an explicit retention policy if future record deletion should eventually purge attached media

## Brevo Email

Use Brevo SMTP for tenant invites and inventory workflow notifications.

Backend env:

```text
PUBLIC_APP_URL=https://876en.org
PLATFORM_ADMIN_EMAILS=<your root/admin email>
PLATFORM_ADMIN_SUBJECTS=<optional oidc subject allowlist>
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<brevo smtp login>
SMTP_PASS=<brevo smtp key>
EMAIL_FROM_NAME=876 EN Inventory
EMAIL_FROM_ADDRESS=no-reply@876en.org
NEWSLETTER_FROM_NAME=Black Shadow Company
NEWSLETTER_FROM_ADDRESS=newsletter@876en.org
```

Use the existing Brevo account for both `nsvss.com` and `876en.org`. Add and authenticate `876en.org` as another sending domain, then create the newsletter sender; both domains can use the same SMTP credentials.

Implemented email events:

- tenant invite email
- Platoon admin notification when an NCO submits a finding
- NCO notification when the platoon admin requests more proof

The proof emails are best-effort. The API saves the inventory action first, then sends mail in the background so SMTP downtime does not block field work.

## Authentik

Permanent account creation uses a separate, disabled-by-default management integration. Follow [Permanent Authentik Provisioning](authentik-provisioning.md) for the least-privilege service account, recovery Email Stage UUID, Coolify values, activation smoke test, and rollback. Never store a human Authentik administrator password in the app.

Suggested host:

```text
auth.876en.org
```

Create an OAuth2/OpenID Connect provider for Inventory List.

Backend env:

```text
OIDC_ISSUER=https://auth.876en.org/application/o/inventory-web/
OIDC_AUDIENCE=<authentik inventory client id>
OIDC_CLIENT_ID=<authentik inventory client id>
OIDC_DISCOVERY_URL=https://auth.876en.org/application/o/inventory-web/.well-known/openid-configuration
OIDC_GROUPS_CLAIM=groups
PLATFORM_ADMIN_GROUP=876en-admins
PLATFORM_ADMIN_SUBJECTS=<optional oidc subject allowlist>
FRG_ADMIN_GROUP=876en-frg-admins
TENANT_ADMIN_GROUP=876en-platoon-admin
TENANT_GROUP_PREFIX=876en-
```

App groups:

```text
876en-admins
876en-frg-admins
876en-platoon-admin
876en-ms
```

An explicit app database membership is authoritative for that tenant's role and disabled status. Authentik tenant groups remain a compatibility fallback only when no database membership row exists, controlled by `AUTHENTIK_TENANT_GROUP_FALLBACK_ENABLED`. A user in `876en-admins` can still use the audited platform-support override.

Production requires either `PLATFORM_ADMIN_EMAILS` or `PLATFORM_ADMIN_SUBJECTS` even if you also use the `876en-admins` group. Put your first supply/root admin email here when Authentik emits an email claim. If admin diagnostics show no groups or the email is not what you expected, copy the `Subject`, set `PLATFORM_ADMIN_SUBJECTS` to that value, redeploy the backend, and sign in again. This is the bootstrap/support escape hatch while Authentik group claims are being polished.

Frontend OIDC notes:

- Configure the Authentik application as a public/OIDC client with PKCE.
- The frontend client ID should match `VITE_OIDC_CLIENT_ID`.
- If you keep an Authentik application tile, set its Launch URL to `https://876en.org/#/launch`. The tile is optional; the normal product flow starts from the site login or a direct app URL.
- Add redirect URIs for the public app/admin hosts you use, starting with `https://admin.876en.org/`. Tenant admin login on platoon subdomains will also need allowed redirect URIs such as `https://1st.876en.org/` and `https://ms.876en.org/`, or an Authentik wildcard/regex redirect rule if you choose to allow tenant-wide callback URLs.
- Make sure the provider emits a group claim. The app looks for groups such as `876en-admins` or `876en-ms` in the access token, ID token, and OIDC userinfo response; if `/#/launch` still says `No groups in token`, add or enable the Authentik OAuth/OIDC scope mapping that exposes user groups.
- The public `876en.org` nav login dropdown should point to the app launcher, `https://876en.org/#/launch`. Authentik handles sign-in, but its app dashboard is not the user destination.
- The frontend can use explicit Authentik OAuth endpoints (`/application/o/authorize/` and `/application/o/token/`) so the browser does not need to fetch the discovery document from `auth.876en.org`.
- Keep `VITE_ENABLE_AUTH_DIAGNOSTICS=false` for normal production. Set it to `true` only during a support session when you intentionally need the manual access-token fallback or extra auth diagnostics.
- Tenant invitation links use `https://<tenant>.876en.org/#/accept-invite?token=...`. Authentik only sees the origin/path portion of that redirect URI, so the allowed redirect entry is the tenant root such as `https://1st.876en.org/`; the app restores the invite hash after login.

## Inventory Session Flow

The first React tenant-admin session flow is live:

- create an active inventory session from the platoon admin page
- paste hand-receipt packet rows into the session
- view session progress and row status
- let the platoon admin directly mark rows found or not found when working alone
- let contributors/NCOs submit found/not-found/mismatch proof with location, serial, note, and photo
- show contributors the platoon admin's request note and move those response items to the top
- let the platoon admin review proof from a queue and approve, reject, or request more proof
- let the platoon admin write a specific request note when asking for more proof
- show a proof history timeline in the platoon admin review queue when an item has follow-up submissions
- show a close-out report on session detail with counts, unresolved rows, and a copyable text summary
- export complete close-out report rows as CSV
- print a clean close-out report that hides the admin console and includes the full reconciliation list
- import packet rows from pasted text, text/CSV files, PDFs, or photos through a platoon admin review step before saving
- persist packet import batches with source files, extracted text, source links, and retry actions for platoon admins
- search and filter session rows by text, status, proof requests, review work, problems, and completed items
- auto-match imported session rows to known inventory items by LIN, NSN, title, and common-name signals
- notify platoon admins by email when proof is submitted
- notify the submitter by email when the platoon admin requests more proof

The next backend/frontend slice should add a manual match/override control for session rows the automatic matcher misses or gets wrong.

## Production Cutover

Use this as the first real go-live pass.

1. Backend Coolify env is set from `backend/.env.example`, with `NODE_ENV=production`, `ALLOW_DEV_AUTH=false`, the production `DATABASE_URL`, a unique `MEDIA_SIGNING_SECRET`, and `PLATFORM_ADMIN_EMAILS` containing your root admin email.
2. Backend deploy logs show `migration complete: database is current`, or the backend terminal runs `npm run migrate` with the same result.
3. Backend `https://api.876en.org/health` returns `{ "ok": true }`.
4. Frontend Coolify env has `VITE_BASE_DOMAIN=876en.org`, `VITE_API_BASE_URL=https://api.876en.org/api`, and the Authentik discovery/client values.
5. Cloudflare routes include `admin.876en.org`, `876en.org`, `api.876en.org`, and the tenant wildcard or explicit tenant hostnames.
6. Authentik has redirect URIs for `https://admin.876en.org/`, `https://876en.org/`, and each first tenant host such as `https://1st.876en.org/` and `https://ms.876en.org/`.
7. Open `https://876en.org/#/launch`, sign in with the account in `876en-admins`, and confirm it routes to platform admin.
8. Create the first tenants, for example `1st` and `ms`, assigning each platoon admin email as the first platoon admin.
9. Open each tenant admin link, create a test inventory session, import a couple packet rows, invite one contributor, and submit/approve one proof item.
10. Confirm a current in-app evidence/source link opens, then copy the same plain `/media/...` URL into an anonymous/private browser and confirm it returns `403`. Also confirm a contributor cannot open a packet-source link.
11. After the test pass, leave the root static GitHub Pages site online until you are comfortable moving the public homepage to the Coolify app.

## Production Test Workspace Reset

Use `scripts/production-tenant-reset.mjs` only when a platform administrator intentionally wants to recreate a test workspace from scratch. Set the two platform/Authentik credential pairs in a trusted operator shell, set `MVP_RESET_TENANT_SLUG`, and set `MVP_RESET_CONFIRMATION` to the exact value `DELETE <slug>`. The runner refuses reserved hostnames and never prints credentials or tokens.

The reset first proves that the operator is a platform administrator and Authentik superuser. It removes only the exact, unprivileged Authentik group carrying the matching app-managed tenant UUID and slug. The backend then requires the exact slug again, cascades all tenant-owned database records, removes orphaned temporary crew accounts, deletes the tenant upload directory, and records a platform audit event. The runner verifies that the slug, group, and tenant API route are absent before reporting success. Human Authentik identities and global newsletter/platform data are preserved.

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
VITE_OIDC_CLIENT_ID=<authentik inventory client id>
VITE_OIDC_DISCOVERY_URL=https://auth.876en.org/application/o/inventory-web/.well-known/openid-configuration
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
MEDIA_SIGNING_SECRET=<separate base64-encoded QA-only random secret>
MEDIA_SESSION_TTL_SECONDS=300
MEDIA_UPLOAD_STAGING_TTL_HOURS=24
```

Keep QA on a separate database and storage folder. Never enable `ALLOW_DEV_AUTH` on the production backend.

The QA frontend exposes root/platoon-admin/NCO persona buttons when `VITE_ENABLE_QA_AUTH=true`. A normal test pass should be:

1. Root admin creates a platoon with `qa-lead@876en.test` as the platoon admin.
2. QA platoon admin opens that platoon, creates a session, and pastes packet rows.
3. QA platoon admin invites or directly creates contributor access for `qa-nco@876en.test`.
4. QA NCO opens Tasks, submits proof with a photo/location/serial.
5. QA platoon admin opens Review and approves, requests more proof, or rejects.

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

Webhook acceptance is not treated as a successful release. Coolify returns a deployment UUID, and the workflow derives that Coolify instance's `/api/v1` base from an HTTPS webhook ending in `/api/v1/deploy`, then polls `GET /deployments/{uuid}`. Query parameters and fragments are never carried into the status URL. Each configured frontend/backend deployment must reach `finished` within 45 minutes. `failed`, cancelled, unknown, repeatedly unreadable, and timed-out deployments fail the GitHub Actions run. When Coolify reports a Git commit SHA, the workflow also checks that it matches the commit that started the run.

Enable the Coolify API and give `COOLIFY_DEPLOY_TOKEN` both `read` and `deploy` permissions. The workflow never prints the webhook URL, bearer token, API response bodies, or deployment logs. Failures show only the target, HTTP/status category, and a shortened deployment UUID; inspect the full deployment log inside Coolify.

References: [Coolify deployment status API](https://coolify.io/docs/api-reference/api/deployments/get-deployment-by-uuid) and [Coolify API authorization](https://coolify.io/docs/api-reference/authorization).

The frontend deployment target also accepts Coolify's generic doc-style secret names as a fallback:

```text
COOLIFY_WEBHOOK
COOLIFY_TOKEN
```
