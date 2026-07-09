# Auth Task Status

Owner: current Codex auth thread.
Started: 2026-07-09.

## In Scope

- AUTH-001: Launch routing and role destinations.
- AUTH-002: Production-safe diagnostics.
- AUTH-003: Callback and API failure recovery.
- AUTH-004: Authentik tile strategy.
- AUTH-005: Safe backend/session health diagnostics.

## Coordination Notes

- Do not overlap edits in `react-app/src/lib/auth.js`, `react-app/src/App.jsx` launch routing, `react-app/src/components/AdminConsole.jsx` auth panel behavior, or `/api/me` auth response shape while this status is in progress.
- `docs/forkable-tasks.md` has an unrelated newsletter thread edit in progress, so this file is the auth coordination note for now.

## Current Subtasks

- [x] Route the public login/default app launch URL through `/#/launch`.
- [x] Add `/me.workspaces` so root launch can route database-backed tenant members.
- [x] Route platform admins, FRG admins, and single-workspace users from launch.
- [x] Keep production admin/tenant pages from stopping on a dead sign-in card when no session exists.
- [x] Hide manual access-token controls outside QA.
- [x] Replace raw callback/API failures with user-safe launch messages.
- [x] Add admin/QA diagnostics copy for launch failures.
- [x] Add `/api/auth/health` with safe auth, tenant, and workspace status.
- [x] Teach the launch router to translate health failures into useful messages.
- [x] Surface health details only in admin/QA diagnostics.
- [x] Verify launch-router QA smoke on desktop and mobile Chrome.
- [x] Verify direct auth-health QA responses.
- [x] Decide Authentik tiles are optional only; normal login uses the app launcher/admin routing.
- [ ] Run full QA smoke after the unrelated newsletter/UI work in progress settles.

## Newly Discovered Follow-Ups

No open auth follow-ups. Run the full QA smoke once unrelated UI/newsletter work settles.
