# Local QA Environment

The QA stack runs the React app, Express API, and Postgres locally with Docker. It uses QA persona headers instead of Authentik, so it is safe to test UI flows without changing the live `876en.org` deployment.

## Start

```bash
npm run qa:up
```

Services:

- Frontend: `http://localhost:5175`
- Platform admin: `http://admin.localhost:5175/#/admin`
- MS tenant: `http://ms.localhost:5175/#/admin`
- API: `http://localhost:5300/api`
- Postgres: `localhost:55432`

The API runs migrations and seeds QA data on startup.

## QA Personas

Open an admin/workspace URL and use the `QA users` disclosure on the sign-in card.

- Root admin: platform admin, all tenants.
- Platoon admin: `ms` tenant admin.
- Newsletter admin: FRG/newsletter editor.
- NCO: `ms` contributor.

Seeded data includes:

- `ms` tenant.
- `July sensitive items` inventory session.
- Four packet rows.
- One pending proof submission for review.
- One published newsletter issue.
- One approved newsletter subscriber.

## Useful URLs

```text
http://localhost:5175/
http://localhost:5175/#/launch
http://admin.localhost:5175/#/admin
http://admin.localhost:5175/#/newsletter
http://ms.localhost:5175/#/admin
```

## Logs

```bash
npm run qa:logs
```

## Smoke Tests

With the QA stack running:

```bash
npm run qa:test
```

The smoke suite covers:

- Public landing page.
- Platform admin with the Root admin persona.
- Newsletter admin with the Newsletter admin persona.
- Tenant dashboard with the Platoon admin persona.
- Tenant dashboard with the NCO contributor persona.
- Packet upload review entry point.

Artifacts for failed tests are written under `qa-artifacts/`.

Use headed mode when reviewing UI behavior:

```bash
npm run qa:test:headed
```

## UI Screenshots

For quick screenshots during UI review, run Playwright with the QA stack up:

```bash
npx playwright screenshot --browser=chromium http://localhost:5175 qa-artifacts/public-home.png
npx playwright screenshot --browser=chromium http://admin.localhost:5175/#/admin qa-artifacts/platform-admin.png
npx playwright screenshot --browser=chromium http://ms.localhost:5175/#/admin qa-artifacts/ms-workspace.png
```

For mobile framing, add a viewport:

```bash
npx playwright screenshot --browser=chromium --viewport-size=390,844 http://ms.localhost:5175/#/admin qa-artifacts/ms-workspace-mobile.png
```

Screenshots under `qa-artifacts/` are ignored by git.

## Stop

```bash
npm run qa:down
```

## Reset

This deletes the QA Postgres and upload volumes.

```bash
npm run qa:reset:danger -- --yes
```

Then start again:

```bash
npm run qa:up
```

## Notes For Forked Task Threads

- Use QA before pushing UI changes.
- Do not use real production secrets in this stack.
- If a task needs Authentik-specific behavior, document the exact Authentik setting separately and keep the QA route working with personas.
- If a task adds a new page or route, add it to `docs/forkable-tasks.md` when the work lands.
