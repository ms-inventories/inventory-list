# inventory-list

The repository root is the legacy static GitHub Pages fallback app.

The current Coolify/Vite/React app lives in `react-app/`. Keep the static page online only as a fallback while the self-hosted version finishes cutover.

This repo is now a monorepo:

- Root: legacy static GitHub Pages fallback.
- `react-app/`: Coolify React frontend.
- `backend/`: Coolify Express API.

## Static GitHub Pages App

This is not the primary production UI anymore. It should stay clearly labeled as a legacy fallback and point users to the current portal:

- Current portal: `https://876en.org/#/launch`
- Current platform admin: `https://admin.876en.org/#/admin`

When the Coolify version is fully trusted, either replace the Pages app with a redirect/splash page or archive it.

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

See [docs/saas-architecture.md](docs/saas-architecture.md) for the Authentik, tenant, platoon inventory workflow, and Coolify deployment model.

See [docs/deployment-876en.md](docs/deployment-876en.md) for the planned `876en.org` Cloudflare Tunnel, Coolify, NAS storage, Brevo email, and active GitHub Actions deploy setup.

See [docs/coolify-labels.md](docs/coolify-labels.md) for frontend/backend wildcard label templates.

See [docs/ui-task-list.md](docs/ui-task-list.md) for the current UI backlog, including dead buttons, confusing links, and unfinished flows.

See [docs/forkable-tasks.md](docs/forkable-tasks.md) for labeled task packages that can be handed to separate Codex threads.

See [docs/qa-environment.md](docs/qa-environment.md) for the Docker-based local QA stack.

## Monorepo Commands

```bash
npm install
npm run check
npm run dev:frontend
npm run dev:api
npm run qa:up
```
