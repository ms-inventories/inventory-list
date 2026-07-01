# inventory-list

The repository root is the current static GitHub Pages app.

The future Coolify/Vite/React app lives in `react-app/` so the static page can stay online while the self-hosted version is built out.

This repo is now a monorepo:

- Root: current static GitHub Pages app.
- `react-app/`: future Coolify React frontend.
- `backend/`: future Coolify Express API.

## Static GitHub Pages App

- `index.html`
- `admin.html`
- `script.js`
- `admin.js`
- `ocr.js`
- `styles.css`

## React/Coolify App

```bash
cd react-app
npm install
npm run dev
```

Coolify should use `react-app` as the base directory, `npm ci` as the install command, `npm run build` as the build command, and `dist` as the publish directory.

## SaaS Backend

The future multi-tenant API lives in `backend/`.

```bash
cd backend
npm install
npm run check
npm run dev
```

See [docs/saas-architecture.md](docs/saas-architecture.md) for the Authentik, tenant, LT/NCO workflow, and Coolify deployment model.

See [docs/deployment-876en.md](docs/deployment-876en.md) for the planned `876en.org` Cloudflare Tunnel, Coolify, NAS storage, Brevo email, and active GitHub Actions deploy setup.

See [docs/coolify-labels.md](docs/coolify-labels.md) for frontend/backend wildcard label templates.

## Monorepo Commands

```bash
npm install
npm run check
npm run dev:frontend
npm run dev:api
```
