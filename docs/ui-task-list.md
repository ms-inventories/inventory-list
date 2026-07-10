# UI Task List

This list is based on the current React UI and the recorded user flow from July 8, 2026. It focuses on controls that are dead, confusing, partially wired, or visually promising more than the app currently delivers.

Use this as the working backlog before turning individual items into implementation subtasks.

## Priority Rules

- P0: blocks the core inventory workflow or causes users to land in the wrong place.
- P1: visible UI control exists but is dead, misleading, or incomplete.
- P2: quality-of-life polish that makes the app feel finished.
- P3: later product depth.

## P0: Make The Main Flow Reliable

- [x] **UI-001: Fix Authentik launch routing**
  - Current issue: Authentik can land users on the admin route, which makes regular users hit a platform admin sign-in or access-denied path.
  - Desired behavior: the public login and any optional Authentik app tile launch `https://876en.org/#/launch`; the app routes platform admins, platoon admins, FRG admins, and regular platoon members to the correct workspace.
  - Controls affected: public `Login`, optional Authentik app tile, launch screen.

- [x] **UI-002: Make token/group diagnostics useful but not user-facing**
  - Current issue: launch errors expose raw-ish group/debug state and users can see `Use access token`.
  - Desired behavior: production users see a clean access message; admins can open diagnostics from a hidden/support path.
  - Controls affected: launch screen, admin sign-in card, invite accept screen.

- [x] **UI-003: Finish the packet upload path**
  - Status: completed by current Codex thread, 2026-07-09. Safe for `UI-004` to continue; coordinate before changing the tenant dashboard upload button, Sessions import wizard, or packet import empty states again.
  - Current issue: `Upload packet` moves users to Sessions, but the actual file picker only appears after a session exists.
  - Desired behavior: clicking `Upload packet` opens a guided flow: select/create session, choose PDF/spreadsheet, review parsed rows, import.
  - Controls affected: `Upload packet`, `New session`, `Import packet rows`, `Choose PDF or spreadsheet`.

- [x] **UI-004: Validate PDF packet import end to end**
  - Status: completed by current Codex thread, 2026-07-09. Added focused QA coverage for uploading the generated Army-style PDF through the packet wizard on desktop and mobile; safe for `UI-005` to continue.
  - Current issue: the UI suggests PDF import is supported, but the live flow needs verified parsing against Army-style packet docs.
  - Desired behavior: real PDF upload extracts likely item rows, shows low-confidence rows for review, and imports only after approval.
  - Controls affected: packet import wizard, review rows, import rows.

- [x] **UI-005: Resolve tenant callback/API failure states**
  - Status: completed by current Codex thread, 2026-07-09. API/network failures now use actionable routing copy and have focused QA coverage; safe for `UI-006` to continue.
  - Current issue: tenant routes can land on `Failed to fetch` after OIDC redirects.
  - Desired behavior: tenant callbacks exchange tokens cleanly, `/me` succeeds, and CORS/origin issues show a clear admin-only diagnostic.
  - Controls affected: `Continue with Authentik`, launch callback, tenant admin sign-in.

## P1: Wire Or Remove Dead Platform Controls

- [x] **UI-006: Platform sidebar Dashboard**
  - Status: completed by current Codex thread, 2026-07-09. Dashboard now routes to a real overview and has focused QA coverage for platform totals, recent platoons, and shortcut navigation; safe for `UI-007` to continue.
  - Current issue: `Dashboard` is a button with no action.
  - Desired behavior: either route to a platform overview page or hide it until implemented.
  - Suggested use: total platoons, active sessions, pending reviews, recent tenant creation, auth health.

- [x] **UI-007: Platform sidebar Users**
  - Status: completed by current Codex thread, 2026-07-09. Users now routes to the workspace access coverage view with focused desktop/mobile QA for the search, table headers, and empty-state behavior; safe for `UI-008` to continue.
  - Current issue: `Users` is a button with no action.
  - Desired behavior: route to a user management view or hide it.
  - Suggested use: search users, see Authentik-linked identity, tenant membership, roles, last activity.

- [x] **UI-008: Platform sidebar Roles**
  - Status: completed by current Codex thread, 2026-07-09. Roles now routes to the Authentik group mapping reference with focused desktop/mobile QA for the platform, FRG, platoon admin, and tenant member group names; safe for `UI-009` to continue.
  - Current issue: `Roles` is a button with no action.
  - Desired behavior: route to a role mapping/status view or hide it.
  - Suggested use: show configured Authentik groups: `876en-admins`, `876en-frg-admins`, `876en-platoon-admin`, and tenant groups like `876en-ms`.

- [x] **UI-009: Platform sidebar Organizations**
  - Status: completed by current Codex thread, 2026-07-09. Organizations now routes to the company overview and workspace totals view with focused desktop/mobile QA; safe for `UI-010` to continue.
  - Current issue: `Organizations` is a button with no action.
  - Desired behavior: either implement company/unit organization settings or remove the control.
  - Suggested use: company profile, base domain, default group prefix, FRG branding.

- [x] **UI-010: Platform sidebar Support**
  - Status: completed by current Codex thread, 2026-07-09. Support now routes to safe deployment diagnostics with focused desktop/mobile QA for core configuration fields; safe for `UI-011` to continue.
  - Current issue: `Support` is a button with no action.
  - Desired behavior: route to a diagnostics/support page or remove it.
  - Suggested use: copy deployment info, API health, auth issuer, storage driver, mail status, version.

- [x] **UI-011: Platform user card dropdown**
  - Status: completed by current Codex thread, 2026-07-09. Platform user card now opens a real account menu with profile context, app portal, diagnostics, copy diagnostics, and sign out, plus focused desktop/mobile QA coverage; safe for `UI-012` to continue.
  - Current issue: user card has a chevron but no menu.
  - Desired behavior: clicking it opens a small menu with profile, app portal, diagnostics, and sign out.

- [x] **UI-012: Make platform `Open` explicit**
  - Status: completed by current Codex thread, 2026-07-09. Platform tenant rows now show explicit `Open workspace`, `Admin view`, and `Copy link` actions with focused desktop/mobile QA coverage; safe for `UI-013` to continue.
  - Current issue: tenant row `Open` is ambiguous.
  - Desired behavior: replace with a small menu or clearer buttons: `Open workspace`, `Admin view`, `Copy link`.

## P1: Finish Tenant/Leader Controls

- [x] **UI-013: Tenant hamburger menu**
  - Status: completed by current Codex thread, 2026-07-09. Existing tenant shell behavior now has focused QA coverage for desktop sidebar collapse/expand and mobile drawer open/close; safe for `UI-014` to continue.
  - Current issue: hamburger icon exists but does not open/collapse anything.
  - Desired behavior: on mobile it opens the nav drawer; on desktop it collapses the sidebar.

- [x] **UI-014: Tenant notifications**
  - Status: completed by current Codex thread, 2026-07-09. Notification bell opens a real action panel on desktop/mobile, routes to sessions and review queue, and the review destination label now matches the nav/action label; safe for `UI-015` to continue.
  - Current issue: bell icon has no action.
  - Desired behavior: notification panel for new submissions, proof requests, assigned items, imports completed, and session status changes.

- [x] **UI-015: Tenant user card dropdown**
  - Status: completed by current Codex thread, 2026-07-09. Tenant user card opens account actions, shows profile/access details, and signs out cleanly with desktop/mobile QA coverage; safe for `UI-016` to continue.
  - Current issue: user card has a chevron but no menu.
  - Desired behavior: menu with profile, app portal, switch workspace, diagnostics, and sign out.

- [x] **UI-016: Start new inventory should be a wizard**
  - Status: completed by current Codex thread, 2026-07-09. `Start new inventory` now opens a guided modal, creates the session directly, and can either land in Sessions or continue into packet upload; desktop/mobile QA coverage added. Safe for `UI-017` to continue.
  - Current issue: it opens Sessions, but users still need to infer the next step.
  - Desired behavior: button opens a session creation modal/drawer with session name, packet source option, and start action.

- [ ] **UI-017: Pending item assignment**
  - Current issue: dashboard implies assignment/tasking, but assignment needs a complete workflow.
  - Desired behavior: tenant admin can assign rows to members; contributors see assigned rows; reassignment and "assign to me" update state.

- [ ] **UI-018: Review queue actions**
  - Current issue: approve/reject/request more proof exists conceptually, but needs full confidence in live behavior and status feedback.
  - Desired behavior: every review action updates the queue, item state, session progress, and notification state.

- [ ] **UI-019: Reports view**
  - Current issue: reporting exists as closeout export pieces, but there is no clear Reports page.
  - Desired behavior: reports page for session closeout, missing items, found items, proof status, CSV export, printable summary.

- [ ] **UI-020: Inventory guidance view**
  - Current issue: guidance is a natural nav item but not a real page yet.
  - Desired behavior: per-tenant instructions, where-to-look notes, packet handling tips, and common equipment reference notes.

## P1: People And Invite Flow

- [ ] **UI-021: Invite helper needs full lifecycle**
  - Current issue: invite creation exists, but admin workflow needs resend/copy/revoke/expire clarity.
  - Desired behavior: invite list shows status, expiration, last sent, copy link, resend email, revoke.

- [ ] **UI-022: Member role editing**
  - Current issue: members are listed but role management needs a visible flow.
  - Desired behavior: tenant admin can promote/demote helper vs platoon admin and remove members.

- [ ] **UI-023: Authentik group sync status**
  - Current issue: Authentik groups and backend tenant memberships can feel disconnected.
  - Desired behavior: each member row shows source of access: tenant membership, Authentik group, or platform admin override.

## P1: FRG / Public Site Controls

- [ ] **UI-024: Public login dropdown**
  - Current issue: it should be verified against final launch behavior.
  - Desired behavior: public visitors see vague wording; authorized users land in the app launcher, not Authentik's tile dashboard.

- [ ] **UI-025: Newsletter signup and approval**
  - Current issue: signup exists, but live operational flow needs approval and email-send verification.
  - Desired behavior: public request, FRG admin approval/rejection, Brevo send path, unsubscribe path, export list.

- [ ] **UI-026: FRG content editor**
  - Current issue: newsletter/admin page exists, but the homepage still depends on curated app content.
  - Desired behavior: FRG admins can manage announcements, events, resources, and newsletter issues without touching code.

## P2: Reduce Clutter And False Promises

- [x] **UI-027: Hide QA/manual token controls in production**
  - Current issue: `Use access token` is useful during setup but confusing for real users.
  - Desired behavior: only visible when `ALLOW_DEV_AUTH=true` or an explicit diagnostics flag is enabled.

- [ ] **UI-028: Clean up legacy static app affordances**
  - Current issue: root static pages still have old admin/password flows and PDF upload wording.
  - Desired behavior: keep legacy app available intentionally, but label it as legacy or remove confusing admin links after cutover.

- [ ] **UI-029: Empty states should always give one next action**
  - Current issue: several empty states explain what is missing but do not always include a next button.
  - Desired behavior: empty states include the next action when the user has permission, such as `Create session`, `Upload packet`, `Invite helper`.

- [ ] **UI-030: Standardize action labels**
  - Current issue: similar actions use mixed labels: `Open`, `View all`, `Inventory`, `Admin view`, `Continue`.
  - Desired behavior: labels map to clear destinations: `Open workspace`, `Open session`, `Review queue`, `Import packet`, `Launch app`.

- [ ] **UI-031: Mobile-first toolbar cleanup**
  - Current issue: desktop layout is improving, but mobile needs repeated inspection.
  - Desired behavior: primary action is visible, secondary actions collapse into a menu, text does not wrap awkwardly, tables become cards.

## P2: Product Completion Tasks

- [ ] **UI-032: Session closeout flow**
  - Desired behavior: close session shows unresolved rows, review count, proof state, final report preview, and confirm close.

- [ ] **UI-033: Item detail page/drawer**
  - Desired behavior: clicking a row opens a detail drawer with photos, known location, packet line, proof history, notes, and actions.

- [ ] **UI-034: Photo proof viewer**
  - Desired behavior: review queue has a real evidence viewer with image zoom, serial photo grouping, location note, and request-more-proof context.

- [ ] **UI-035: Search behavior audit**
  - Desired behavior: tenant search filters dashboard tables, sessions, rows, proof submissions, and member views consistently.

- [ ] **UI-036: Loading and error states**
  - Desired behavior: every async button has loading text, disabled state, success state, and a useful failure message.

## P3: Later SaaS Depth

- [ ] **UI-037: Multi-workspace switcher**
  - Desired behavior: platform admins or users in multiple platoons can switch workspaces from the user menu.

- [ ] **UI-038: Audit log UI**
  - Desired behavior: platform and tenant admins can see who imported rows, changed status, approved proof, invited users, and closed sessions.

- [ ] **UI-039: Tenant settings**
  - Desired behavior: platoon admins can update display name, default guidance, permitted roles, and notification preferences.

- [ ] **UI-040: Admin setup checklist**
  - Desired behavior: platform admin sees setup completion for DNS, Authentik group, tenant admin invite, packet import, and storage.

## First Suggested Work Slice

1. UI-001: Authentik launch routing. Done for this pass; keep future work pointed at the app launcher, not Authentik's tile dashboard.
2. UI-027: Hide manual token controls in production.
3. UI-003: Packet upload wizard.
4. UI-006 through UI-010: hide or wire platform sidebar dead controls.
5. UI-013 through UI-015: wire tenant hamburger, notifications, and user menu.

That sequence removes the biggest "this button lied to me" moments before adding deeper features.
