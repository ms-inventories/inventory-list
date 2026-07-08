# Inventory List React App

This is the future Coolify-deployed version of the inventory app. The repository root remains the current static GitHub Pages app.

## Local Development

```bash
npm install
npm run dev
```

## Coolify

Deploy this folder as the app root:

```text
Base directory: react-app
Install command: npm ci
Build command: npm run build
Publish directory: dist
```

Use `876en.org` tenant subdomains for the deployed app, such as:

```text
https://1st.876en.org
https://ms.876en.org
```

Set these environment variables in Coolify if you need to override defaults:

```text
VITE_BASE_DOMAIN=876en.org
VITE_API_BASE_URL=/api
VITE_LEGACY_BUCKET_BASE_URL=https://ms-inventories.s3.us-east-1.amazonaws.com
VITE_AUTHENTIK_LAUNCH_URL=https://auth.876en.org/if/user/
VITE_OIDC_CLIENT_ID=<authentik inventory client id>
VITE_OIDC_DISCOVERY_URL=https://auth.876en.org/application/o/inventory-web/.well-known/openid-configuration
VITE_ENABLE_DEMO_FALLBACK=true
VITE_OIDC_AUTHORIZATION_ENDPOINT=https://auth.876en.org/application/o/authorize/
VITE_OIDC_TOKEN_ENDPOINT=https://auth.876en.org/application/o/token/
```

`VITE_ENABLE_DEMO_FALLBACK` keeps localhost and first deploys usable even when the old static JSON source is unavailable from the browser. Set it to `false` after the backend is serving tenant inventory data.

`876en.org` renders the public FRG/newsletter splash page. The nav login dropdown points to Authentik's application portal by default, so users only see apps they are allowed to launch. Set the Authentik inventory application's launch URL to `https://876en.org/#/launch`; that neutral route signs users in and sends platform admins to admin, newsletter admins to the newsletter editor, single-platoon users to their platoon, or multi-platoon users to a chooser. Tenant subdomains render the SaaS workspace by default; the old static lookup screen remains available at `/#/lookup` or `/lookup` during transition.
