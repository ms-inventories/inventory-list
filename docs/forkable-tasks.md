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
- Use `implemented locally, awaiting ACP` when work is verified but still only exists in the shared dirty worktree. Reserve `complete` for durable work already committed to the repository.

## Current Priority Order

1. Implement `USER-MANAGEMENT-006` permanent Authentik provisioning with authoritative database membership and a least-privilege service integration.
2. Implement `SESSION-006` verified-item reuse with leader-confirmed matches and canonical-photo selection.
3. Continue `UX-003` plus the empty-state/action-label cleanup while preserving the current accountability regression suite.
4. Owner follow-up, deferred and unverified: resolve `OPS-002` credential rotation and confirm the old credential is rejected. This does not block local feature work.

## QA

### QA-001: Local Docker QA Environment

Goal: provide a repeatable local stack for testing frontend, API, Postgres, seeded tenants, and QA personas.

Status: complete. QA stack, smoke tests, screenshot guidance, and guarded destructive reset are ready for other task threads.

Primary files:

- `docker-compose.qa.yml`
- `docker/qa/Dockerfile`
- `backend/src/seed-qa.js`
- `docs/qa-environment.md`

Subtasks:

- [x] Add Docker Compose services for Postgres, API, and Vite frontend.
- [x] Seed QA users, `ms` tenant, session rows, one review submission, and newsletter content.
- [x] Add Playwright smoke checks for platform admin, tenant admin, contributor, and newsletter admin.
- [x] Add screenshot capture guidance for UI review.
- [x] Add a reset script that is clearly labeled as destructive.

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

### QA-003: Recorded Packet Flow Regression

Goal: turn the rough 2026-07-09 21:34 user flow into a repeatable QA script.

Status: implemented locally, awaiting ACP, 2026-07-10. `qa/recorded-packet-flow.spec.js` replays the full flow on desktop and mobile, preserves PDF source metadata across closeout/navigation, keeps closed work secondary, rejects stale errors, and attaches screenshots for every major step. The packet-wizard delayed-session race also has focused coverage.

Coordination note: this task should avoid product behavior changes unless a test exposes a small missing selector or fixture. It should coordinate with `PACKET-004` and `SESSION-005` when failures point at those task areas.

Primary files:

- `qa/`
- `playwright.qa.config.mjs`
- `scripts/`
- `output/` or `qa/fixtures/` for packet PDFs/text fixtures
- `docs/qa-environment.md`

Subtasks:

- [x] Add a QA fixture packet that resembles the Army-style hand receipt without extra hints or synthetic row text.
- [x] Cover opening the packet wizard before the session list finishes loading; Continue must wait for a stable existing/new-session choice.
- [x] Script the full recorded flow: start session, upload packet, review rows, import, close/back out, navigate dashboard and sessions.
- [x] Assert no stale `Internal server error` banner remains after navigation/reload.
- [x] Assert closed/empty sessions do not remain the primary selected work item in the full recorded flow.
- [x] Assert import history preserves file source metadata when a PDF is uploaded.
- [x] Capture screenshots at each major step for future visual comparison.

Definition of done:

- A single QA command can replay the flow that failed in the recording and catch stale errors, bad source labels, and session-state regressions.

## Auth And Launch

### AUTH-001: Launch Routing And Role Destinations

Goal: make Authentik launch land every user in the right place.

Status: complete for this pass. Authentik tiles are optional; public login and any tile should use the app launcher at `https://876en.org/#/launch`, not Authentik's dashboard as the destination.

Primary files:

- `react-app/src/App.jsx`
- `react-app/src/lib/auth.js`
- `react-app/src/config.js`
- `backend/src/auth.js`
- `backend/src/tenant.js`

Subtasks:

- [x] Confirm the app tile launch URL should be `https://876en.org/#/launch` if a tile is kept.
- [x] Normalize launch behavior for platform admins, FRG admins, single-tenant users, and multi-tenant users.
- [x] Make regular platoon users land on their workspace, not platform admin.
- [x] Add a friendly no-access state with next steps.
- [x] Add QA persona checks for each role.

Definition of done:

- QA Root Admin opens platform admin.
- QA Newsletter Admin opens newsletter admin.
- QA Platoon Admin opens `ms` admin/workspace.
- QA NCO opens `ms` workspace without admin-only controls.

### AUTH-002: Production-Safe Diagnostics

Goal: keep debugging tools available without exposing them to normal users.

Status: completed by current Codex thread, 2026-07-09. Safe for `AUTH-003` and `UX-003` to continue; coordinate before changing launch diagnostics, admin sign-in controls, or invite manual-token controls again.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`
- `react-app/src/lib/api.js`
- `react-app/src/config.js`

Subtasks:

- [x] Hide `Use access token` unless QA/dev diagnostics are enabled.
- [x] Move token/group details behind an admin-only diagnostics disclosure.
- [x] Replace raw launch errors with concise user-facing copy.
- [x] Add a copyable diagnostics bundle for admins.
- [x] Verify production envs do not show QA controls.

Definition of done:

- Normal users never see token controls.
- QA mode still supports persona and manual-token testing.

### AUTH-003: Callback And API Failure Recovery

Goal: make OIDC callback and `/me` failures actionable.

Status: completed by current Codex thread, 2026-07-10. Safe for non-auth tasks to proceed; coordinate before changing OIDC callback routing, protected-page auto-login behavior, or auth diagnostics again.

Primary files:

- `react-app/src/lib/auth.js`
- `react-app/src/lib/api.js`
- `react-app/src/App.jsx`
- `backend/src/routes.js`
- `backend/src/auth.js`

Subtasks:

- [x] Detect failed token exchange separately from failed `/me`.
- [x] Show CORS/API routing diagnostics only to admin/QA mode.
- [x] Add retry and sign-out actions to callback failure screens.
- [x] Ensure tenant slug survives redirects.
- [x] Test `admin.localhost`, `ms.localhost`, and root `localhost`.

Definition of done:

- A bad callback does not trap the user on a blank or vague `Failed to fetch` screen.

## Packet Import

### PACKET-001: Packet Upload Wizard

Goal: turn `Upload packet` into a guided, obvious workflow.

Status: completed by current Codex thread, 2026-07-08.

Coordination note: packet upload wizard UI, parser reliability, source history, and session handoff are implemented. Coordinate with `PACKET-003` and `SESSION-005` before changing the shared upload/session flow.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`
- `backend/src/routes.js` only if API shape must change

Subtasks:

- [x] Replace the current session handoff with a modal/drawer wizard.
- [x] Step 1: create or select inventory session.
- [x] Step 2: choose PDF, CSV/text, image, or paste text.
- [x] Step 3: review parsed rows.
- [x] Step 4: import rows and show success summary.
- [x] Preserve the current session import history.
- [x] Verify mobile layout.

Definition of done:

- A leader can click `Upload packet` and complete an import without hunting for a hidden control.

### PACKET-002: PDF Parser Reliability

Goal: support clean Army-style packet PDFs and weird layout variants.

Status: completed by current Codex thread, 2026-07-08. `PACKET-003` is implemented locally; coordinate before changing `react-app/src/lib/packetParser.js` or generated packet fixtures again.

Primary files:

- `react-app/src/lib/packetParser.js` or the current parser module
- `react-app/src/components/AdminConsole.jsx`
- `docs/`
- `output/` only for generated test PDFs

Subtasks:

- [x] Build parser fixtures from generated Army-style PDFs.
- [x] Extract MPO, LIN, NSN, description, and OH Qty when present.
- [x] Ignore page headers, footers, signatures, stamps, and embedded photos.
- [x] Flag low-confidence rows for review.
- [x] Support one-line fallback import.
- [x] Add parser notes to docs.

Definition of done:

- Generated test PDFs and simple one-line text both produce reviewable rows.

### PACKET-003: Packet Source Attachments

Goal: make uploaded packet source files easy to find later.

Status: implemented locally, awaiting ACP, 2026-07-10. Uploaded sources are stored with immutable import batches; history shows the original name, MIME type, byte size, uploader, upload time, and source link. Unsupported formats are rejected before parsing, and desktop/mobile QA verifies the metadata survives closeout and navigation.

Primary files:

- `backend/src/routes.js`
- `backend/db/`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [x] Confirm uploaded packet source files are stored with import batches.
- [x] Show source file, file size, and uploaded by.
- [x] Keep import batches immutable instead of deleting/replacing source history; a corrected upload creates a new batch while the prior audit trail remains.
- [x] Add explicit client/server error handling and QA coverage for unsupported files.

Definition of done:

- Every import has a traceable source file or pasted-text note.

### PACKET-004: Packet Review Trust Pass

Goal: make the packet review step clear enough that a platoon admin knows what will be imported before committing rows.

Status: completed by current Codex thread, 2026-07-09. Safe for follow-up parser refinements to continue; coordinate before changing packet wizard review layout or `analyzePacketRows` output again.

Coordination note: coordinate with `SESSION-005` before changing packet wizard session selection or the session detail import panel. This task owns parser preview UX, import source labels, and the review modal layout.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/lib/packetParser.js`
- `react-app/src/styles.css`
- `scripts/packet-parser.test.mjs`
- `docs/packet-parser.md`

Subtasks:

- [x] Preserve the original uploaded filename/type in import history instead of falling back to `Pasted packet text` when a file was used. The full-flow history assertion remains in `QA-003`.
- [x] Add a parser summary before review: rows found, rows ignored, low-confidence rows, likely source type.
- [x] Show ignored/header/footer text in a collapsed diagnostics section rather than the main textarea.
- [x] Make the review step table/card easier to scan: row number, packet text, qty, confidence, remove action, optional location.
- [x] Add "import only valid rows" guardrails so obvious headers, notes, and synthetic/test fixture text cannot become rows.
- [x] Add regression coverage using the Army-style PDF fixture and a messy PDF/text extraction fixture.

Definition of done:

- Uploading a real packet source gives a clear reviewable set of rows, preserves source metadata, and does not ask the user to read raw PDF extraction noise to decide if the import is safe.

## Platform Admin

### PLATFORM-001: Platform Navigation And Overview

Goal: remove dead platform sidebar controls and replace them with real views.

Status: complete for this pass. Platform navigation, overview, sidebar state, and platform-only admin views are safe for follow-up work; coordinate before changing the same section router.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`
- `backend/src/routes.js` if summary APIs are needed

Subtasks:

- [x] Create a real platform dashboard view.
- [x] Decide whether `Users`, `Roles`, and `Organizations` are real routes now or hidden until later.
- [x] Add active nav state instead of hardcoded `Platoons`.
- [x] Keep mobile behavior usable.
- [x] Add empty states for unimplemented sections if they stay visible.

Definition of done:

- No platform sidebar button is a dead click.

### PLATFORM-002: Tenant Row Actions

Goal: make tenant row actions explicit.

Status: complete for this pass. Platform tenant row actions, copy-link behavior, workspace links, and row/card mobile action layout are safe for follow-up work; no separate admin destination exists yet.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`

Subtasks:

- [x] Replace ambiguous `Open` with `Open workspace`.
- [x] Keep `Admin view` out until it is a distinct destination.
- [x] Add `Copy link`.
- [x] Add overflow menu only if there are more than two actions.
- [x] Test mobile row/card layout.

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

Status: completed by current Codex thread, 2026-07-08. Safe for follow-up tenant tasks to start; coordinate before changing the tenant shell, mobile drawer, notification popover placeholder, or user menu again.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`

Subtasks:

- [x] Wire hamburger to open/collapse sidebar.
- [x] Add overlay drawer behavior on mobile.
- [x] Add user menu with profile, app portal, switch workspace, diagnostics, and sign out.
- [x] Keyboard and outside-click close behavior.
- [x] Verify desktop and mobile screenshots.

Definition of done:

- Hamburger and chevron are no longer fake controls.

### TENANT-002: Notifications Panel

Goal: make the bell useful.

Status: completed by current Codex thread, 2026-07-08. Safe for notification persistence and deep-link follow-up work to start.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/db/` if a notification table is added

Subtasks:

- [x] Define notification sources: new proof, proof request, assignment-style open rows, import complete, session closed.
- [x] Add unread count for high-priority action items.
- [x] Add notification panel UI.
- [x] Confirm mark-read is not persisted yet; unread state is derived from live action items.
- [x] Link notifications to the relevant sessions or review queue, with IDs returned for future row-level deep links.

Remaining follow-ups:

- Add a persisted notification/read-state table if dismissible alerts become important.
- Add row-level deep links that select a specific session item or proof submission after the target tab opens.
- Replace assignment-style open-row summaries with true assignee notifications after assignment ownership exists.

Definition of done:

- The bell opens useful status, or it is hidden until persistence exists.

### TENANT-003: Guidance Page

Goal: give platoon admins a place to publish search/inventory guidance.

Status: backend data/API retained but user-facing page retired after field review, 2026-07-11. The focused dashboard, assignment, item-detail, and proof flows now carry the workflow without a separate guidance destination.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/db/`

Subtasks:

- [x] Add read-only guidance page first.
- [x] Add tenant admin editor.
- [x] Store markdown/plain text guidance.
- [x] Link guidance to packet/session workflow.

Definition of done:

- Retired functionality does not clutter tenant navigation; stored historical guidance remains non-destructively preserved.

### TENANT-004: Tenant Settings

Goal: allow platoon-level configuration.

Status: field-refined, 2026-07-11. Platoon admins can update the workspace display name and tenant-wide in-app/email notification preferences and copy the workspace URL. Guidance and deployment-only slug/Authentik group mapping were removed from this user-facing surface. Settings remain tenant-isolated, audited, and covered on desktop/mobile.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`
- `backend/db/`

Subtasks:

- [x] Edit tenant display name.
- [x] Retire default guidance from the user-facing form while preserving stored data.
- [x] Configure notification preferences.
- [x] Show the copyable workspace URL without exposing group mapping.

Definition of done:

- Tenant admins can maintain basic workspace settings.

## Sessions And Tasking

### SESSION-001: Start Inventory Wizard

Goal: replace the plain session form with a task-focused start flow.

Status: complete, 2026-07-09. The guided start modal can create a blank session or continue directly into packet upload, and desktop/mobile QA coverage is in `qa/tenant-start-inventory.spec.js`.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`

Subtasks:

- [x] Modal/drawer for session name and packet source.
- [x] Option to start from blank session.
- [x] Option to upload packet immediately.
- [x] Show created session confirmation.
- [x] Return user to the right session detail.

Definition of done:

- `Start new inventory` has an obvious beginning, middle, and success state.

### SESSION-002: Assignment Workflow

Goal: support assigning packet rows to helpers.

Status: completed and mobile-refined, 2026-07-13. Assignment ownership is persisted on session rows; the selected active inventory appears on the dashboard and prioritizes the user's work; `Unclaimed`, `Mine`, and `Others` partition actionable rows while completed items move to separate history. Claim is visible on mobile, supports Authentik-only users, prevents duplicate/racing actions, and opens accessible proof entry; admins retain reassignment/unassignment controls.

Primary files:

- `backend/db/`
- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`
- `qa/session-assignment.spec.js`

Subtasks:

- [x] Add assigned user field/table for session rows.
- [x] Add assign/reassign/unassign API.
- [x] Add `Claim item` and admin assignment actions.
- [x] Contributors see assigned rows first.
- [x] Dashboard reflects assignment state.

Definition of done:

- A platoon admin can task someone and the contributor sees the assignment.

### SESSION-003: Closeout And Reports

Goal: make session closeout deliberate and reportable.

Status: implemented locally, awaiting ACP, 2026-07-10. Session closeout has unresolved/status summaries, confirmation, reopen, printable output, copied text, CSV export, and desktop/mobile lifecycle plus recorded-flow coverage. `UI-019` now adds tenant-wide cross-session reports with outcome/proof filters, CSV export, and print output.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`

Subtasks:

- [x] Add closeout confirmation with unresolved counts.
- [x] Show missing/found/review status summary.
- [x] Generate printable report.
- [x] Export CSV.
- [x] Prevent accidental close and provide a clear reopen action.

Definition of done:

- Closing an inventory session produces a usable summary.

### SESSION-004: Item Detail Drawer

Goal: centralize row history and actions.

Status: implemented locally, awaiting ACP, 2026-07-10. Every session row opens an accessible responsive drawer with packet/known-item data, assignment, packet-source linkage, full proof history, nested evidence viewing, and role-appropriate actions. Closed-session mutations are hidden in the UI and rejected by the API.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`
- `backend/src/routes.js`
- `qa/session-item-drawer.spec.js`

Subtasks:

- [x] Open an accessible focus-managed drawer from every session row.
- [x] Show packet line, known item, photos, location, serial, assignment, and complete submission history.
- [x] Include proof submission, review-queue handoff, direct-check, and assignment actions where allowed.
- [x] Link the exact source packet batch for platoon admins and identify imported/manual rows for other roles.
- [x] Enforce closed-session read-only behavior in both UI controls and mutation routes.

Definition of done:

- Users can inspect an item without scanning the whole row/card.

### SESSION-005: Abandoned Session And Error Recovery

Goal: make backing out of a bad packet/session flow leave the workspace clean and understandable.

Status: implementation and focused QA are substantially complete. Empty drafts can be deleted, duplicate empty sessions are reused, closed sessions move to a secondary archive, closeout requires confirmation, and successful refresh clears stale errors. The complete recorded-flow replay remains in `QA-003`.

Coordination note: this task owns session selection after close/delete, empty-session cleanup, and stale status banners in the tenant dashboard/sessions views. Coordinate with `PACKET-004` before changing packet wizard steps.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`
- `backend/src/routes.js`
- `backend/db/` only if a delete/archive API needs schema support
- `qa/smoke.spec.js` or a new focused QA spec

Subtasks:

- [x] Reproduce the recorded flow in QA: create a session, import a packet, close it, then navigate dashboard/sessions.
- [x] Confirm `Internal server error` no longer persists after a successful reload or no-session state.
- [x] Add an explicit zero-row session action: `Delete draft` or `Archive empty session`.
- [x] Hide closed sessions by default and make the closed archive clearly secondary.
- [x] Prevent duplicate empty sessions with the same name while one is still active/draft.
- [x] Convert `Close` into a confirmation/closeout path when rows exist, but keep empty-session cleanup lightweight.
- [x] Add focused QA coverage for close/delete/backout and stale-banner cleanup; the single recorded-flow case remains in `QA-003`.

Definition of done:

- A platoon admin can abandon a bad import/session without stale errors, duplicate empty sessions, or unclear closed-session clutter.

### SESSION-006: Verified Item Reuse

Goal: carry trusted location and reference photos into later inventory sessions without confusing historical proof with the permanent item record.

Status: complete, ACP-published, and production-verified, 2026-07-14. Matching, explicit leader confirmation, transactional record promotion, three-photo canonical selection, evidence preservation, legacy backfill, and retained-media authorization are covered by API and responsive browser QA.

Primary files:

- `backend/db/`
- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`
- new matching/media-promotion QA specs

Subtasks:

- [x] Suggest known-item matches during packet review using exact LIN/NSN/serial first and bounded fuzzy fallback second.
- [x] Require a leader to confirm or reject each suggested match.
- [x] On approval, let the leader retain the known location/serial or replace them with the new verified values.
- [x] Let the leader choose up to three canonical old/new reference photos while preserving immutable evidence history.
- [x] Keep media authorization, tenant isolation, and audit events intact during promotion/replacement.

Definition of done:

- A later inventory recognizes the same equipment, reuses only leader-confirmed facts, and keeps no more than three canonical reference photos per item.

## Review And Evidence

### REVIEW-001: Review Queue Actions

Goal: make approve/reject/request-more-proof fully trustworthy.

Status: hardened locally, awaiting ACP, 2026-07-14. Desktop/mobile QA verifies approve, reject, more-proof, follow-up submission replacement, stale review conflicts, queue removal, session item state, and visible confirmation feedback.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `backend/src/routes.js`

Subtasks:

- [x] Verify each decision updates submission, session row, queue, and dashboard counts.
- [x] Add success/error feedback near the acted item.
- [x] Keep the packet line in persistent confirmation feedback after an acted item leaves the queue.
- [x] Confirm a separate undo/reopen action is not needed; rejected and more-proof rows stay unresolved and accept later evidence.
- [x] Add desktop/mobile QA cases for each decision.

Definition of done:

- Review decisions are reflected everywhere immediately after action.

### REVIEW-002: Photo Proof Viewer

Goal: make submitted evidence easy to inspect.

Status: implemented locally, awaiting ACP, 2026-07-10. The review queue now has labeled current/history thumbnail strips and an accessible in-app evidence viewer with zoom, next/previous navigation, focus restoration, photo metadata, submission context, prior proof-request context, and responsive desktop/mobile layouts.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/styles.css`
- `qa/review-photo-viewer.spec.js`

Subtasks:

- [x] Add labeled thumbnail strips for current evidence and submission history in the review queue.
- [x] Add a fullscreen/lightbox viewer with zoom and next/previous controls.
- [x] Show serial, location, general, and damage photo labels and captions.
- [x] Show submitter, note, location, serial, and the most recent applicable proof request, including on resubmission.
- [x] Add keyboard/focus handling and desktop/mobile Playwright coverage.

Definition of done:

- A reviewer can judge proof without opening raw image links one by one.

### REVIEW-003: Single Open Review Cycle

Goal: guarantee that an item cannot require the leader to approve older proof after approving the newest proof.

Status: implemented locally and QA-covered, awaiting ACP, 2026-07-14.

Primary files:

- `backend/db/015_submission_review_supersession.sql`
- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`
- `qa/proof-review-reliability.spec.js`

Subtasks:

- [x] Preserve older submissions as `superseded` history while allowing only one actionable proof per item.
- [x] Resolve the prior evidence request when a response arrives.
- [x] Reject repeated, replaced, and closed-session review actions with a conflict.
- [x] Limit proof submissions to three photos in both API and UI.
- [x] Present pending proof as one role-specific action: `Awaiting review` for helpers or `Review proof` for leaders.

Definition of done:

- The newest proof appears once in the queue and one leader decision removes the item from review work.

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

Status: completed 2026-07-08. Safe for `USER-MANAGEMENT-003` and `USER-MANAGEMENT-004` to start. Coordinate before changing the same tenant People panel controls.

Primary files:

- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [x] Add role update API.
- [x] Add disable/remove member API.
- [x] Add UI menu for member role and status.
- [x] Prevent removing the last tenant admin.
- [x] Audit member changes.

Definition of done:

- A tenant admin can promote, demote, or disable members safely.

### USER-MANAGEMENT-005: Session Crew Codes

Goal: let a leader bring temporary helpers into one inventory without requiring Authentik account administration in the field.

Status: complete and focused-QA verified, 2026-07-14. Leaders have a mobile-first generate/copy/share/list/revoke flow for private invite links plus four-digit PINs, while temporary helpers receive a host-only HttpOnly session restricted to one active inventory. Atomic closeout revocation immediately invalidates API and media access and returns the number of crew sessions revoked.

Primary files:

- `backend/db/016_session_crew_access.sql`
- `backend/src/crew-auth.js`
- `backend/src/routes.js`
- `backend/src/media.js`
- `react-app/src/App.jsx`
- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/components/CrewAccessDialog.jsx`
- `react-app/src/components/CrewJoin.jsx`
- `backend/test/crew-auth.test.mjs`
- `qa/crew-access-api.spec.js`
- `qa/crew-access.spec.js`

Subtasks:

- [x] Generate a high-entropy private invite link plus a random, zero-padded four-digit PIN labeled with the helper's name.
- [x] Store only tenant-scoped keyed digests for the invite token and PIN; expire after at most seven days; consume exactly once under a row lock.
- [x] Exchange the code for a high-entropy, host-only HttpOnly session bound to one active inventory session.
- [x] Persistently rate-limit by fingerprint and tenant and return the same response for invalid, expired, consumed, or revoked codes.
- [x] Allow only exact-session read, self claim/release, upload, proof submission, authorized media, minimal profile, and logout.
- [x] Let leaders list and revoke grants without exposing consumed codes.
- [x] Revoke every temporary grant/session atomically when the inventory session closes, including immediate API/media invalidation.
- [x] Add a mobile-first `Invite crew` / `Use crew code` flow and closeout revocation count.
- [x] Cover cookie/origin/auth precedence in unit tests; atomic consumption, ownership, media, and closeout in focused API/database QA; and leader/helper flows at desktop/mobile widths.

Definition of done:

- A helper can use a shared private link and four-digit PIN once, work only the intended session, and loses API and media access immediately at leader revocation or closeout.

Lifecycle note: this flow never creates an Authentik login. Logout, leader removal, expiry, and closeout retire the local credential and release untouched claims. The local display-name identity remains audit-only so submitted proof keeps its attribution; define anonymization/retention separately if policy later requires removing that attribution.

### USER-MANAGEMENT-006: Permanent Authentik Provisioning

Goal: create a real permanent login, tenant group, and app membership from the Team screen.

Status: implementation and deployment foundation is in place behind a disabled-by-default feature flag, including authoritative database membership, intended-email matching, the additive identity/job schema, bounded Authentik 2026.5.3 client, durable reconciliation, API/UI states, and safe retry handling. Production activation remains pending a dedicated least-privilege service token, recovery Email Stage UUID, signed-in phone/desktop verification, and cleanup of the tagged test identity. Do not mark complete until that pass succeeds.

Primary files:

- `backend/src/`
- `backend/db/`
- `react-app/src/components/AdminConsole.jsx`
- deployment configuration and mocked integration tests

Subtasks:

- [x] Make explicit database membership authoritative for tenant role and disabled status.
- [x] Require intended-email matching when accepting the legacy invite, including platform admins.
- [x] Add idempotent provisioning jobs that create/link an Authentik identity and exact tenant group.
- [x] Implement per-tenant `Team member` or `Leader` membership plus Authentik enrollment behind the feature flag.
- [x] Persist Authentik identity ID plus an app-managed marker; retry partial failures without duplicating people.
- [x] Reconcile role/disable changes safely and expose provisioning failures without leaking credentials.
- [ ] Configure the dedicated Authentik service token and recovery Email Stage UUID, then activate production.
- [ ] Complete signed-in phone/desktop verification and clean up only the tagged integration-test identity.

Definition of done:

- A leader can enter name/email once, Authentik sends enrollment, and the new person signs in with the correct tenant-scoped role; the production smoke test and tagged-record cleanup are recorded.

### USER-MANAGEMENT-003: Authentik Group Sync Status

Goal: clarify why a user has access.

Status: access-source resolution remains implemented for platform operations, but tenant-facing diagnostics were retired on 2026-07-11. People & Invites now contains only member/invitation actions the platoon admin can perform.

Primary files:

- `backend/src/tenant.js`
- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`

Subtasks:

- [x] Include membership source in API responses.
- [x] Keep database/Authentik resolution and mismatch warnings available to platform operations.
- [x] Remove group/source internals from tenant-facing People and Settings pages.

Definition of done:

- Platform operators can diagnose access without exposing deployment internals to platoon users.

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

Status: completed by current Codex thread, 2026-07-08. Safe for `NEWSLETTER-003` and `PUBLIC-001` to continue; coordinate before changing the same public content block schema or editor flows.

Coordination note: public homepage content blocks, the FRG/newsletter content editor UI, related API routes, and published public rendering are implemented. Follow-up threads can build delivery/unsubscribe QA or public polish without owning the content-block CRUD path.

Primary files:

- `react-app/src/App.jsx`
- `react-app/src/components/AdminConsole.jsx`
- `backend/db/`
- `backend/src/routes.js`

Subtasks:

- [x] Define public content blocks: announcements, events, resources.
- [x] Add DB schema for content blocks.
- [x] Add admin editor.
- [x] Render published content on public homepage.
- [x] Keep content vague and public-safe.

Definition of done:

- FRG admins can update homepage content from the app.

### NEWSLETTER-003: Delivery And Unsubscribe QA

Goal: verify the email lifecycle.

Status: implemented locally and QA-covered, awaiting consolidated ACP. Do not treat the delivery/export/docs slice as deployed until the current shared worktree is committed and pushed.

Coordination note: safe test send, delivery record visibility/export, unsubscribe smoke coverage, and Brevo env docs are implemented. Live Brevo deliverability still requires production credential and sender validation.

Primary files:

- `backend/src/email.js`
- `backend/src/routes.js`
- `react-app/src/App.jsx`
- `react-app/src/components/AdminConsole.jsx`
- `docs/newsletter-delivery.md`

Subtasks:

- [x] Add safe test-send behavior.
- [x] Confirm delivery records.
- [x] Confirm unsubscribe flow.
- [x] Add export of subscribers and delivery status.
- [x] Document Brevo production envs without secrets.

Definition of done:

- Newsletter admin can publish and verify delivery results.

### NEWSLETTER-004: Newsletter Admin UX Pass

Goal: make newsletter administration clearer on desktop and usable on phones.

Status: implemented locally and QA-covered, awaiting consolidated ACP. Coordinate before changing newsletter admin tabs, subscriber review flows, or the current shared worktree.

Coordination note: newsletter admin mobile overflow, queue-first subscriber filtering, compact email status treatment, subscriber details disclosure, and public newsletter request helper copy are implemented and QA-covered.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`
- `react-app/src/styles.css`
- `qa/smoke.spec.js`

Subtasks:

- [x] Fix mobile horizontal overflow in newsletter admin shell.
- [x] Simplify newsletter issue/public content editing on mobile.
- [x] Make subscriber review queue default to pending/open requests.
- [x] Collapse subscriber delivery/review history behind details.
- [x] Replace repeated delivery warning with compact status treatment.
- [x] Shorten public signup placeholders and add helper text.
- [x] Verify desktop and mobile newsletter screenshots.

Definition of done:

- FRG admins can review signups, edit public content, and manage newsletter issues without clutter or mobile overflow.

## Public And Legacy

### PUBLIC-001: Public Landing And Portal Polish

Goal: keep public content vague and useful while routing approved users cleanly.

Status: implemented locally and QA-covered, awaiting consolidated ACP. The public/branding slice is not durable until the current shared worktree is committed and pushed.

Coordination note: public login/dropdown copy, logo/favicon/page title consistency, generic hero media, mobile hero framing, and public-safe newsletter wording are implemented and QA-covered.

Primary files:

- `react-app/src/App.jsx`
- `react-app/src/styles.css`

Subtasks:

- [x] Verify login dropdown copy.
- [x] Use logo/favicon consistently.
- [x] Keep heavy equipment imagery out of generic company homepage unless intentionally needed.
- [x] Ensure mobile hero works.
- [x] Confirm newsletter section is not too operationally specific.

Definition of done:

- Public visitors see FRG/company content; authorized users can reach the portal.

### LEGACY-001: Static App Cutover Cleanup

Goal: reduce confusion between the root static app and the React/Coolify app.

Status: complete, 2026-07-08. Static GitHub Pages pages are clearly labeled as legacy fallback and point users to the current Coolify portal/admin.

Primary files:

- `index.html`
- `admin.html`
- `script.js`
- `admin.js`
- `styles.css`
- `README.md`

Subtasks:

- [x] Label legacy static app clearly.
- [x] Remove or relabel admin links after React cutover.
- [x] Decide when GitHub Pages should stop serving inventory UI.
- [x] Preserve static fallback only if useful.

Definition of done:

- Users are not accidentally sent to old password/admin flows.

## UX System

### UX-001: Empty States And Action Labels

Goal: make every empty page tell the user what to do next.

Status: in progress, 2026-07-11. The full empty-state/action-label audit is complete. The first correctness slice now routes dashboard pending-row and card actions to existing sessions instead of the create-session wizard, removes duplicate Platform `Admin view` destinations, points fallback access to `Launch app`, and clarifies active legacy-viewer destinations. Broader empty-state next actions and packet/import label standardization remain.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`
- `react-app/src/styles.css`

Subtasks:

- [x] Audit empty states.
- [ ] Add next-action buttons when user has permission.
- [ ] Standardize labels: `Open workspace`, `Open session`, `Review queue`, `Import packet`, `Launch app`.
- [ ] Remove duplicate or vague copy.

Definition of done:

- Empty states reduce confusion instead of adding another dead end.

### UX-004: Product Name Branding

Goal: make the React app product name consistent.

Status: implemented locally, awaiting consolidated ACP. The app name is `Shadow Tracer`; keep `876 EN` and `Black Shadow Company` for organization/public-site context. `react-app/src/branding.js` is still untracked in the shared worktree.

Primary files:

- `react-app/src/branding.js`
- `react-app/src/App.jsx`
- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/components/AcceptInvite.jsx`
- `react-app/index.html`

Subtasks:

- [x] Add shared branding constants.
- [x] Rename visible app chrome from old inventory labels to `Shadow Tracer`.
- [x] Update Authentik launch/invite/admin shell labels.
- [x] Update the browser title.
- [x] Keep public company copy distinct from the inventory app name.

Definition of done:

- New app-facing screens say `Shadow Tracer` without renaming the public company website.

### UX-002: Mobile Toolbar And Table Pass

Goal: make mobile the primary supported layout.

Status: implemented locally, awaiting ACP, 2026-07-11. Platform navigation is an accessible off-canvas drawer; tenant/platform/viewer headers keep primary actions visible; secondary actions use contextual disclosures; session cards defer duplicated assignment/direct-check controls to the existing detail drawer; Platform and Reports tables use labeled mobile cards; closed drawers are inert; touch targets are at least 44px; and Pixel 7 plus 360px layout QA passes.

Primary files:

- `react-app/src/styles.css`
- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`

Subtasks:

- [x] Audit mobile width for platform admin.
- [x] Audit mobile width for tenant dashboard.
- [x] Convert wide tables into cards where needed.
- [x] Collapse secondary actions behind menus.
- [x] Ensure text never overlaps or clips.

Definition of done:

- Core workflows are usable on a phone.

### UX-003: Loading And Error State Pass

Goal: every async action should feel deliberate.

Status: in progress, 2026-07-14. The async-action audit is complete. Session Found/Not found and close/reopen mutations use synchronous duplicate guards, disable conflicting controls, expose reachable loading labels, preserve failure dialogs and reference-bearing feedback, and support retry. Proof submit/remove/cancel actions now have the same duplicate protection, field/control locking, and action-specific feedback with desktop/mobile QA. Legacy viewer login and public unsubscribe also reject repeat submissions while pending. Newsletter, packet upload, and remaining lower-frequency multi-row pending-state follow-ups remain.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`
- `react-app/src/lib/api.js`

Subtasks:

- [x] Audit all submit buttons.
- [ ] Add loading labels and disabled states.
- [ ] Keep success/failure messages close to the action.
- [ ] Distinguish validation errors from network/API errors.
- [ ] Verify repeated clicks do not duplicate data.

Definition of done:

- Users can tell when the app is working, done, or blocked.

### SEARCH-001: Search Behavior Audit

Goal: make search behavior consistent across app sections.

Status: implemented locally, awaiting ACP, 2026-07-11. Shared case/diacritic/punctuation-normalized AND-term matching now covers the legacy lookup, platform/newsletter lists, dashboard preview, current session rows and full proof history, review queue, people/invitations, and reports. Search is hidden on pages without a defined scope, queries reset between pages, clear/reset controls restore focus, and parallel-safe desktop/mobile fixtures plus unit/browser regressions pass.

Primary files:

- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`

Subtasks:

- [x] Define search scope per page.
- [x] Make dashboard search filter visible tables.
- [x] Make sessions search rows, serials, locations, and packet text.
- [x] Make review search submissions and proof notes.
- [x] Add clear/reset control where needed.

Definition of done:

- Search inputs do what their placeholder promises.

## Operations And Reliability

### OPS-001: API Error Observability

Goal: make live failures diagnosable without exposing sensitive details to normal users.

Status: implemented locally, awaiting ACP, 2026-07-10. API responses carry `X-Request-ID`, 4xx/5xx JSON includes the same ID and a safe error code, server logs contain structured route/tenant/subject context, client errors show the reference ID, and platform diagnostics retain the last failed request ID.

Coordination note: this task owns backend error payload shape, request IDs, and safe admin/support diagnostics. Coordinate with `UX-003`, `SESSION-005`, and `PACKET-004` before changing action-specific UI copy.

Primary files:

- `backend/src/routes.js`
- `backend/src/auth.js`
- `react-app/src/lib/api.js`
- `react-app/src/components/AdminConsole.jsx`
- `react-app/src/App.jsx`
- `qa/`

Subtasks:

- [x] Add a request ID to every API request and include it in 4xx/5xx JSON responses.
- [x] Log structured error context server-side: request ID, route, method, tenant/subdomain, authenticated subject when available, and safe error class.
- [x] Map known failures to safe client messages: tenant not found, unauthorized role, invalid packet input, missing storage path, database constraint, and upload size/type issues.
- [x] Surface the request ID in admin/support diagnostics without showing stack traces or secrets.
- [x] Add QA coverage that forces a known bad request and confirms the UI shows an actionable message plus request ID.

Definition of done:

- A live admin can report a failed action with a request ID, and the server logs can identify the real cause without leaking details in the browser.

### OPS-002: Credential Rotation And Secret Hygiene

Goal: close out a credential exposure noted during the project-thread audit without copying any secret into the repository.

Status: owner deferred verification on 2026-07-10. A production database connection string appeared in historical conversation context; local feature work may continue, but this task is not complete until the owner rotates it (if needed) and confirms the old value is rejected.

Primary files:

- Deployment secret stores only
- `.env.example` files for safe variable names/documentation
- Git history and current worktree for read-only secret scanning

Subtasks:

- [ ] Rotate the affected database password if this has not already happened.
- [ ] Update Coolify/production secret storage and restart dependent services safely.
- [ ] Verify the previous credential no longer authenticates.
- [ ] Confirm no live secret was committed to Git.

Definition of done:

- The exposed credential is unusable, the app uses the replacement, and no secret value is stored in tracked files.

### OPS-003: Evidence And Packet Media Access Control

Goal: ensure uploaded evidence and packet-source files are readable only by authorized users in the owning tenant.

Status: implemented locally, awaiting ACP, 2026-07-10. Anonymous static delivery is replaced by a tenant-path-scoped, short-lived HttpOnly media session; every request verifies the tenant and linked submission, known-item reference, or packet-import record. Packet sources remain platoon-admin-only, media responses are private/no-store and excluded from CORS, and desktop/mobile QA covers valid, anonymous, tampered, unlinked, cross-tenant, and wrong-role access.

Primary files:

- `backend/src/server.js`
- `backend/src/routes.js`
- `backend/src/auth.js`
- `react-app/src/lib/api.js`
- Evidence/source rendering components and QA specs

Subtasks:

- [x] Replace anonymous static media delivery with authenticated tenant-aware access.
- [x] Validate each storage key belongs to the requesting tenant and permitted record.
- [x] Preserve browser image viewing and source downloads without exposing bearer tokens in URLs or logs.
- [x] Define safe cache headers, short session expiry, and denied unlinked/deleted-file behavior.
- [x] Add QA proving authorized access works while anonymous and cross-tenant requests fail.

Definition of done:

- An evidence or packet-source URL cannot be used by an anonymous user or a member of another tenant, while authorized in-app previews and downloads still work.

### OPS-004: Upload Attachment Integrity And Lifecycle

Goal: ensure a staged upload can only become evidence or an inventory reference through an explicit, auditable relationship.

Status: implemented locally, awaiting ACP, 2026-07-10. Photo uploads now enter a tenant/uploader/purpose registry as expiring staged records and can be consumed exactly once by opaque upload ID. Submission and inventory-reference binding locks and validates the registry row, checks uploader/admin authority, purpose, expiry, tenant, and physical file size, then attaches it in the same transaction. Packet sources are registered immediately, attachment/staging events are audited, expired staged files have a safe cleanup command, and legacy record links remain readable without reopening arbitrary-key attachment.

Primary files:

- `backend/db/`
- `backend/src/routes.js`
- `backend/src/media.js`
- Upload/evidence clients and QA specs

Subtasks:

- [x] Add a database-backed upload registry with tenant, uploader, purpose, MIME type, actual size, expiry, and lifecycle state.
- [x] Return and attach opaque upload IDs instead of accepting an arbitrary client-supplied storage key.
- [x] Enforce uploader/admin ownership and one explicit attachment relationship in the submission and inventory-reference transactions.
- [x] Define cleanup: expired staged uploads are lock-claimed and removed by `npm --prefix backend run cleanup:media`; attached evidence/source files are retained on session close and must never be swept as staging.
- [x] Backfill submission and packet-source registry links and safely grandfather pre-cutover known-item metadata behind an explicit legacy flag.
- [x] Add desktop/mobile QA proving unknown, copied, cross-tenant, duplicate, wrong-purpose, and concurrently reused uploads fail without consuming valid staged media.

Definition of done:

- Every locally stored upload has an auditable owner and lifecycle, and evidence/reference attachment cannot be forged by copying a storage key.

## Audit And Compliance

### AUDIT-001: Audit Log UI

Goal: expose existing audit events to admins.

Status: implemented locally, awaiting ACP, 2026-07-11. Tenant admins and platform admins working inside a tenant now have a safe, responsive Activity Log with strict tenant isolation, actor/action/category/entity/date filters, stable cursor pagination, human-readable allowlisted details, and links back to related sessions. Contributors are denied in both UI and API. This is an operational activity feed, not an immutable compliance ledger; a cross-tenant platform feed remains an optional follow-up.

Primary files:

- `backend/src/routes.js`
- `react-app/src/components/AdminConsole.jsx`
- `backend/db/` if new indexes are needed

Subtasks:

- [x] Add tenant audit log route.
- [ ] Add platform audit log route if needed.
- [x] Add filters by actor, action, entity, date.
- [x] Link audit events to related records.

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
