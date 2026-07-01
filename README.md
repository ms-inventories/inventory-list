# inventory-list

The repository root is the current static GitHub Pages app.

The future Coolify/Vite/React app lives in `react-app/` so the static page can stay online while the self-hosted version is built out.

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
