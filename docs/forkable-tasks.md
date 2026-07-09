# Forkable Task Breakdown

Use these labels when starting a new forked conversation.

Example prompt:

```text
Start the PACKET-001 task.
```

Each task is designed to be worked mostly independently. If a task needs to touch another task's primary files or API routes, pause and coordinate first.

## Coordination Rules

- Keep one thread per label.
- Do not rename shared models, shared auth helpers, or CSS design tokens unless the task explicitly calls for it.
- Prefer additive routes/components over broad rewrites.
- Update this file when a task is completed or split.
- Every implementation task should run the QA stack or explain why it could not.

## QA

### QA-001: Local Docker QA Environment

Goal: provide a repeatable local stack for testing frontend, API, Postgres, seeded tenants, and QA personas.

Status: scaffolded.

Primary files:

- `docker-compose.qa.yml`
- `docker/qa/Dockerfile`
- `backend/src/seed-qa.js`
- `docs/qa-environment.md`

Subtasks:

- [x] Add Docker Compose services for Postgres, API, and Vite frontend.
- [x] Seed QA users, `ms` tenant, session rows, one review submission, and newsletter content.
- [ ] Add Playwright smoke checks for platform admin, tenant admin, contributor, and newsletter admin.
- [ ] Add screenshot capture guidance for UI review.
- [ ] Add a reset script that is clearly labeled as destructive.

Definition of done:

- `npm run qa:up` starts the stack.
- `http://admin.localhost:5175/#/admin` can use QA Root Admin.
- `http://ms.localhost:5175/#/admin` can use QA Platoon Admin and QA NCO.

### QA-002: Smoke Test Harness

Goal: create automated browser checks that future task threads can run before pushing.

Status: complete. Safe for other threads to start follow-on UI or feature tasks.

Primary files:

- `react-app/`
- `tests/` or `qa/`
- `.github/workflows/` only if CI is added

Subtasks:

- [x] Add Playwright or similar browser test dependency.
- [x] Cover public landing page.
- [x] Cover platform admin login and tenant list.
- [x] Cover tenant dashboard and session navigation.
- [x] Cover packet upload entry point.
- [x] Document how to run tests against the QA stack.

Definition of done:

- One command verifies the highest-risk UI flows locally.

## Auth And Launch

### AUTH-001: Launch Routing And Role Destinations

Goal: make Authentik launch land every user in the right place.

Primary files:

- `react-app/src/App.jsx`
- `react-app/src/lib/auth.js`
- `react-app/src/config.js`
- `backend/src/auth.js`
- `backend/src/tenant.js`

Subtasks:

- [ ] Confirm the app tile launch URL should be `https://876en.org/#/launch`.
- [ ] Normalize launch behavior for platform admins, FRG admins, single-tenant users, and multi-tenant users.
- [ ] Make regular platoon users land on their workspace, not platform admin.
- [ ] Add a friendly no-access state with next steps.
- [ ] Add QA persona checks for each role.

Definition of done:

- QA Root Admin opens platform admin.
- QA Newsletter Admin opens newsletter admin.
- QA Platoon Admin opens `ms` admin/workspace.
- QA NCO opens `ms` workspace without admin-only controls.

### AUTH-002: Production-Safe Diagnostics

Goal: keep debugging tools available without exposing them to normal users.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`
- `react-app/src/lib/api.js`
- `react-app/src/config.js`

Subtasks:

- [ ] Hide `Use access token` unless QA/dev diagnostics are enabled.
- [ ] Move token/group details behind an admin-only diagnostics disclosure.
- [ ] Replace raw launch errors with concise user-facing copy.
- [ ] Add a copyable diagnostics bundle for admins.
- [ ] Verify production envs do not show QA controls.

Definition of done:

- Normal users never see token controls.
- QA mode still supports persona and manual-token testing.

### AUTH-003: Callback And API Failure Recovery

Goal: make OIDC callback and `/me` failures actionable.

Primary files:

- `react-app/src/lib/auth.js`
- `react-app/src/lib/api.js`
- `react-app/src/App.jsx`
- `backend/src/routes.js`
- `backend/src/auth.js`

Subtasks:

- [ ] Detect failed token exchange separately from failed `/me`.
- [ ] Show CORS/API routing diagnostics only to admin/QA mode.
- [ ] Add retry and sign-out actions to callback failure screens.
- [ ] Ensure tenant slug survives redirects.
- [ ] Test `admin.localhost`, `ms.localhost`, and root `localhost`.

Definition of done:

- A bad callback does not trap the user on a blank or vague `Failed to fetch` screen.

## Packet Import

### PACKET-001: Packet Upload Wizard

Goal: turn `Upload packet` into a guided, obvious workflow.

Status: in progress by current Codex thread, started 2026-07-08.

Coordination note: this task owns the packet upload wizard UI, packet import entry points, and session handoff around packet imports. Avoid overlapping changes in `PACKET-002`, `PACKET-003`, and `SESSION-001` until this status changes.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`
- `backend/src/routes.js` only if API shape must change

Subtasks:

- [ ] Replace the current session handoff with a modal/drawer wizard.
- [ ] Step 1: create or select inventory session.
- [ ] Step 2: choose PDF, spreadsheet, image, or paste text.
- [ ] Step 3: review parsed rows.
- [ ] Step 4: import rows and show success summary.
- [ ] Preserve the current session import history.
- [ ] Verify mobile layout.

Definition of done:

- A leader can click `Upload packet` and complete an import without hunting for a hidden control.

### PACKET-002: PDF Parser Reliability

Goal: support clean Army-style packet PDFs and weird layout variants.

Primary files:

- `react-app/src/lib/packetParser.js` or the current parser module
- `react-app/src/components/AdminConsole.jsx`
- `docs/`
- `output/` only for generated test PDFs

Subtasks:

- [ ] Build parser fixtures from generated Army-style PDFs.
- [ ] Extract MPO, LIN, NSN, description, and OH Qty when present.
- [ ] Ignore page headers, footers, signatures, stamps, and embedded photos.
- [ ] Flag low-confidence rows for review.
- [ ] Support one-line fallback import.
- [ ] Add parser notes to docs.

Definition of done:

- Generated test PDFs and simple one-line text both produce reviewable rows.

### PACKET-003: Packet Source Attachments

Goal: make uploaded packet source files easy to find later.

Primary files:

- `backend/src/routes.js`
- `backend/db/`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [ ] Confirm uploaded packet source files are stored with import batches.
- [ ] Show source file, file size, and uploaded by.
- [ ] Add delete/replace behavior if needed.
- [ ] Add error handling for unsupported files.

Definition of done:

- Every import has a traceable source file or pasted-text note.

## Platform Admin

### PLATFORM-001: Platform Navigation And Overview

Goal: remove dead platform sidebar controls and replace them with real views.

Status: in progress by current Codex thread. Avoid overlapping edits to platform navigation, platform overview, sidebar state, or platform-only admin views until this status is cleared.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`
- `backend/src/routes.js` if summary APIs are needed

Subtasks:

- [ ] Create a real platform dashboard view.
- [ ] Decide whether `Users`, `Roles`, and `Organizations` are real routes now or hidden until later.
- [ ] Add active nav state instead of hardcoded `Platoons`.
- [ ] Keep mobile behavior usable.
- [ ] Add empty states for unimplemented sections if they stay visible.

Definition of done:

- No platform sidebar button is a dead click.

### PLATFORM-002: Tenant Row Actions

Goal: make tenant row actions explicit.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`

Subtasks:

- [ ] Replace ambiguous `Open` with `Open workspace`.
- [ ] Add `Admin view` if separate from workspace.
- [ ] Add `Copy link`.
- [ ] Add overflow menu only if there are more than two actions.
- [ ] Test mobile row/card layout.

Definition of done:

- A platform admin knows where each action goes before clicking.

### PLATFORM-003: Support Diagnostics Page

Goal: make `Support` useful for troubleshooting deploy/auth/API issues.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/src/config.js`

Subtasks:

- [ ] Add API health/config summary route with safe values only.
- [ ] Show frontend env summary.
- [ ] Show auth issuer, base domain, API base URL, storage driver, and app version.
- [ ] Add copy diagnostics button.
- [ ] Do not reveal secrets.

Definition of done:

- Support page helps debug deployment without leaking credentials.

### PLATFORM-004: Admin Setup Checklist

Goal: help a root admin know what is configured and what remains.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`

Subtasks:

- [ ] Show checklist for Authentik app, platform group, tenant created, DNS wildcard, API reachable, storage writable, email configured.
- [ ] Link each item to relevant docs.
- [ ] Mark local QA values clearly.

Definition of done:

- A new deploy has a visible setup status page.

## Tenant Workspace

### TENANT-001: Mobile Sidebar And User Menu

Goal: make the tenant shell controls real.

Status: in progress by current Codex thread. Avoid overlapping edits to the tenant dashboard shell, mobile sidebar behavior, tenant top bar, notification bell placeholder, or user menu until this status is cleared.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`

Subtasks:

- [ ] Wire hamburger to open/collapse sidebar.
- [ ] Add overlay drawer behavior on mobile.
- [ ] Add user menu with profile, app portal, switch workspace, diagnostics, and sign out.
- [ ] Keyboard and outside-click close behavior.
- [ ] Verify desktop and mobile screenshots.

Definition of done:

- Hamburger and chevron are no longer fake controls.

### TENANT-002: Notifications Panel

Goal: make the bell useful.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/db/` if a notification table is added

Subtasks:

- [ ] Define notification sources: new proof, proof request, assignment, import complete, session closed.
- [ ] Add unread count.
- [ ] Add notification panel UI.
- [ ] Add mark-read behavior if persisted.
- [ ] Link notifications to the relevant session/review item.

Definition of done:

- The bell opens useful status, or it is hidden until persistence exists.

### TENANT-003: Guidance Page

Goal: give platoon admins a place to publish search/inventory guidance.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/db/`

Subtasks:

- [ ] Add read-only guidance page first.
- [ ] Add tenant admin editor.
- [ ] Store markdown/plain text guidance.
- [ ] Link guidance to packet/session workflow.

Definition of done:

- Tenant members can find local instructions without asking the admin.

### TENANT-004: Tenant Settings

Goal: allow platoon-level configuration.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/db/`

Subtasks:

- [ ] Edit tenant display name.
- [ ] Configure default guidance.
- [ ] Configure notification preferences.
- [ ] Show base URL and group mapping.

Definition of done:

- Tenant admins can maintain basic workspace settings.

## Sessions And Tasking

### SESSION-001: Start Inventory Wizard

Goal: replace the plain session form with a task-focused start flow.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`

Subtasks:

- [ ] Modal/drawer for session name and packet source.
- [ ] Option to start from blank session.
- [ ] Option to upload packet immediately.
- [ ] Show created session confirmation.
- [ ] Return user to the right session detail.

Definition of done:

- `Start new inventory` has an obvious beginning, middle, and success state.

### SESSION-002: Assignment Workflow

Goal: support assigning packet rows to helpers.

Primary files:

- `backend/db/`
- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [ ] Add assigned user field/table for session rows.
- [ ] Add assign/reassign/unassign API.
- [ ] Add `Assign to me` and admin assignment actions.
- [ ] Contributors see assigned rows first.
- [ ] Dashboard reflects assignment state.

Definition of done:

- A platoon admin can task someone and the contributor sees the assignment.

### SESSION-003: Closeout And Reports

Goal: make session closeout deliberate and reportable.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`

Subtasks:

- [ ] Add closeout confirmation with unresolved counts.
- [ ] Show missing/found/review status summary.
- [ ] Generate printable report.
- [ ] Export CSV.
- [ ] Prevent accidental close or make reopen clear.

Definition of done:

- Closing an inventory session produces a usable summary.

### SESSION-004: Item Detail Drawer

Goal: centralize row history and actions.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`

Subtasks:

- [ ] Open drawer from a session row.
- [ ] Show packet line, known item, photos, location, serial, submission history.
- [ ] Include proof submission/review actions where allowed.
- [ ] Link source packet batch.

Definition of done:

- Users can inspect an item without scanning the whole row/card.

## Review And Evidence

### REVIEW-001: Review Queue Actions

Goal: make approve/reject/request-more-proof fully trustworthy.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`

Subtasks:

- [ ] Verify each decision updates submission, session row, queue, and dashboard counts.
- [ ] Add success/error feedback near the acted item.
- [ ] Keep item visible long enough to confirm action.
- [ ] Add undo/reopen only if useful.
- [ ] Add QA cases for each decision.

Definition of done:

- Review decisions are reflected everywhere immediately after action.

### REVIEW-002: Photo Proof Viewer

Goal: make submitted evidence easy to inspect.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`

Subtasks:

- [ ] Thumbnail strip in review queue.
- [ ] Fullscreen/lightbox viewer.
- [ ] Show serial/location/general photo labels.
- [ ] Show submitter note and requested proof context.
- [ ] Mobile-friendly image viewing.

Definition of done:

- A reviewer can judge proof without opening raw image links one by one.

## User Management

### USER-MANAGEMENT-001: Invite Lifecycle

Goal: make helper invitations operational.

Status: completed 2026-07-08. Safe for `USER-MANAGEMENT-002` and `USER-MANAGEMENT-003` to start.

Coordination note: tenant invitation UI/actions, invite routes, and invite email behavior now have a working baseline. Follow-on user-management tasks should preserve the refresh-link behavior because raw invite tokens are not stored.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/src/email.js`

Subtasks:

- [x] Show pending/accepted/revoked/expired status.
- [x] Copy invite link.
- [x] Resend invite email.
- [x] Revoke invite.
- [x] Show expiration.
- [x] Verify accept-invite flow with QA personas.

Definition of done:

- A platoon admin can invite a helper and manage the invitation afterward.

### USER-MANAGEMENT-002: Member Role Editing

Goal: let tenant admins manage active members.

Primary files:

- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [ ] Add role update API.
- [ ] Add disable/remove member API.
- [ ] Add UI menu for member role and status.
- [ ] Prevent removing the last tenant admin.
- [ ] Audit member changes.

Definition of done:

- A tenant admin can promote, demote, or disable members safely.

### USER-MANAGEMENT-003: Authentik Group Sync Status

Goal: clarify why a user has access.

Primary files:

- `backend/src/tenant.js`
- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [ ] Include membership source in API responses.
- [ ] Show database membership vs Authentik group access.
- [ ] Show platform admin override.
- [ ] Add warnings when Authentik group and tenant membership disagree.

Definition of done:

- Admins can understand whether access came from Authentik or the app database.

### USER-MANAGEMENT-004: Multi-Workspace Switcher

Goal: support users assigned to more than one tenant.

Primary files:

- `backend/src/routes.js`
- `react-app/src/App.jsx`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [ ] Return all accessible tenants from `/me`.
- [ ] Add workspace chooser in launch screen.
- [ ] Add switch workspace to user menu.
- [ ] Preserve platform-admin override behavior.

Definition of done:

- Multi-tenant users can switch without manually editing URLs.

## Newsletter And FRG

### NEWSLETTER-001: Signup Approval Flow

Goal: make newsletter signup, review, and approval feel finished.

Status: completed by current Codex thread, 2026-07-08. Safe for `NEWSLETTER-002` and `NEWSLETTER-003` to start.

Coordination note: public newsletter signup validation/copy, subscriber approval UI, subscriber review routes, and review notification result handling are implemented. Live Brevo delivery validation remains in `NEWSLETTER-003`.

Primary files:

- `react-app/src/App.jsx`
- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/src/email.js`

Subtasks:

- [x] Verify public signup validation and success copy.
- [x] Improve subscriber review UI.
- [x] Add review note UI if needed.
- [x] Verify approve/reject updates public/admin state.
- [x] Verify SMTP-disabled review notification behavior; production SMTP live-send validation remains in `NEWSLETTER-003`.

Definition of done:

- FRG admins can manage subscriber approvals without touching the database.

### NEWSLETTER-002: FRG Content Editor

Goal: make the public homepage editable by FRG admins.

Status: in progress by current Codex thread, started 2026-07-08.

Coordination note: this task owns public homepage content blocks, the FRG/newsletter content editor UI, related API routes, and published public rendering. Avoid overlapping public content/admin newsletter editor changes until this status is complete.

Primary files:

- `react-app/src/App.jsx`
- `react-app/src/components/AdminConsole.jsx`
- `backend/db/`
- `backend/src/routes.js`

Subtasks:

- [ ] Define public content blocks: announcements, events, resources.
- [ ] Add DB schema for content blocks.
- [ ] Add admin editor.
- [ ] Render published content on public homepage.
- [ ] Keep content vague and public-safe.

Definition of done:

- FRG admins can update homepage content from the app.

### NEWSLETTER-003: Delivery And Unsubscribe QA

Goal: verify the email lifecycle.

Primary files:

- `backend/src/email.js`
- `backend/src/routes.js`
- `react-app/src/App.jsx`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [ ] Add safe test-send behavior.
- [ ] Confirm delivery records.
- [ ] Confirm unsubscribe flow.
- [ ] Add export of subscribers and delivery status.
- [ ] Document Brevo production envs without secrets.

Definition of done:

- Newsletter admin can publish and verify delivery results.

## Public And Legacy

### PUBLIC-001: Public Landing And Portal Polish

Goal: keep public content vague and useful while routing approved users cleanly.

Primary files:

- `react-app/src/App.jsx`
- `react-app/src/styles.css`

Subtasks:

- [ ] Verify login dropdown copy.
- [ ] Use logo/favicon consistently.
- [ ] Keep heavy equipment imagery out of generic company homepage unless intentionally needed.
- [ ] Ensure mobile hero works.
- [ ] Confirm newsletter section is not too operationally specific.

Definition of done:

- Public visitors see FRG/company content; authorized users can reach the portal.

### LEGACY-001: Static App Cutover Cleanup

Goal: reduce confusion between the root static app and the React/Coolify app.

Primary files:

- `index.html`
- `admin.html`
- `script.js`
- `admin.js`
- `styles.css`
- `README.md`

Subtasks:

- [ ] Label legacy static app clearly.
- [ ] Remove or relabel admin links after React cutover.
- [ ] Decide when GitHub Pages should stop serving inventory UI.
- [ ] Preserve static fallback only if useful.

Definition of done:

- Users are not accidentally sent to old password/admin flows.

## UX System

### UX-001: Empty States And Action Labels

Goal: make every empty page tell the user what to do next.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`
- `react-app/src/styles.css`

Subtasks:

- [ ] Audit empty states.
- [ ] Add next-action buttons when user has permission.
- [ ] Standardize labels: `Open workspace`, `Open session`, `Review queue`, `Import packet`, `Launch app`.
- [ ] Remove duplicate or vague copy.

Definition of done:

- Empty states reduce confusion instead of adding another dead end.

### UX-002: Mobile Toolbar And Table Pass

Goal: make mobile the primary supported layout.

Primary files:

- `react-app/src/styles.css`
- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`

Subtasks:

- [ ] Audit mobile width for platform admin.
- [ ] Audit mobile width for tenant dashboard.
- [ ] Convert wide tables into cards where needed.
- [ ] Collapse secondary actions behind menus.
- [ ] Ensure text never overlaps or clips.

Definition of done:

- Core workflows are usable on a phone.

### UX-003: Loading And Error State Pass

Goal: every async action should feel deliberate.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`
- `react-app/src/lib/api.js`

Subtasks:

- [ ] Audit all submit buttons.
- [ ] Add loading labels and disabled states.
- [ ] Keep success/failure messages close to the action.
- [ ] Distinguish validation errors from network/API errors.
- [ ] Verify repeated clicks do not duplicate data.

Definition of done:

- Users can tell when the app is working, done, or blocked.

### SEARCH-001: Search Behavior Audit

Goal: make search behavior consistent across app sections.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`

Subtasks:

- [ ] Define search scope per page.
- [ ] Make dashboard search filter visible tables.
- [ ] Make sessions search rows, serials, locations, and packet text.
- [ ] Make review search submissions and proof notes.
- [ ] Add clear/reset control where needed.

Definition of done:

- Search inputs do what their placeholder promises.

## Audit And Compliance

### AUDIT-001: Audit Log UI

Goal: expose existing audit events to admins.

Primary files:

- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`
- `backend/db/` if new indexes are needed

Subtasks:

- [ ] Add tenant audit log route.
- [ ] Add platform audit log route if needed.
- [ ] Add filters by actor, action, entity, date.
- [ ] Link audit events to related records.

Definition of done:

- Admins can answer who changed or approved something.

## Suggested Parallel Work

These can be forked safely at the same time:

- `NEWSLETTER-001` and `USER-MANAGEMENT-001`
- `PACKET-001` and `PLATFORM-002`
- `TENANT-001` and `REVIEW-002`
- `QA-002` and any single UI task, as long as QA only adds tests

Avoid running these in parallel without coordination:

- `AUTH-001` and `AUTH-003`
- `PACKET-001` and `SESSION-001`
- `PLATFORM-001` and `PLATFORM-003`
- `USER-MANAGEMENT-002` and `USER-MANAGEMENT-003`
