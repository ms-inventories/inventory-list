# UI Task List

This list is based on the current React UI and the recorded user flow from July 8, 2026. It focuses on controls that are dead, confusing, partially wired, or visually promising more than the app currently delivers.

Use this as the working backlog before turning individual items into implementation subtasks.

## Priority Rules

- P0: blocks the core inventory workflow or causes users to land in the wrong place.
- P1: visible UI control exists but is dead, misleading, or incomplete.
- P2: quality-of-life polish that makes the app feel finished.
- P3: later product depth.

## P0: Make The Main Flow Reliable

- [x] **UI-045: Make one proof review resolve one item**
  - Source: live field feedback, 2026-07-14.
  - Current issue: submitting follow-up proof leaves the older pending/request-more-proof submission actionable, so the same item can reappear and require approval twice.
  - Desired behavior: only the newest proof is actionable, older evidence remains visible as history, one approval resolves the item, and stale review actions fail clearly.
  - Status: complete and QA-covered. New proof now supersedes the prior open review cycle atomically, resolves its evidence request, limits each submission to three photos, and stale/repeated review actions return a conflict instead of mutating the item again.

- [x] **UI-046: Streamline session rows, proof entry, and compact admin layouts**
  - Source: desktop-with-DevTools and mobile field screenshots, 2026-07-14.
  - Current issue: the proof form is squeezed into a flex row, selecting a photo makes the surface appear to move, pending items show competing actions, item cards repeat reference data, and the platform dashboard table clips at compact desktop widths.
  - Desired behavior: one stable proof drawer, one state-specific primary action, compact item cards, secondary facts behind disclosures, and contained platform tables at phone/tablet/docked-desktop widths.
  - Status: complete and under responsive QA. Proof entry is drawer-only, supports three removable photo selections, reuses already-staged photos after a failed retry, discards staged photos on remove/cancel, keeps the drawer stable during proof entry, shows contributors `Awaiting review` and leaders `Review proof`, moves secondary information into disclosures, and keeps the dashboard preview to a compact three-column table.

- [x] **UI-047: Add one-time session crew codes**
  - Source: MVP field workflow, 2026-07-14.
  - Desired behavior: a leader names a temporary helper, generates a private invite link plus one-time four-digit PIN valid for at most seven days, shares it, and the helper lands directly in that active session. Consumption is atomic and rate-limited; closing the session revokes every temporary session immediately.
  - Status: complete and focused-QA verified, 2026-07-14. PINs and high-entropy invite tokens are stored only as tenant-scoped keyed digests, consumed atomically once, capped at seven days, and protected by persistent invite/fingerprint/tenant attempt limits. The exchanged host-only HttpOnly session exposes only the intended active inventory, minimal profile/logout, claim/release, upload, proof, and authorized media; People, Settings, Reports, other sessions, and platform access remain unavailable. Leaders can generate, copy/share, list, and revoke private invites from a mobile-first flow, and closeout atomically reports and revokes every temporary session. Unit, API/database, and desktop/mobile browser coverage verify concurrent single use, session isolation, field work, logout/revoke, and immediate API/media invalidation.

- [ ] **UI-048: Provision permanent accounts through Authentik**
  - Source: MVP field workflow and live Authentik audit, 2026-07-14.
  - Current issue: the current invite creates only a database membership; a person without an existing Authentik identity cannot sign in to accept it.
  - Desired behavior: a leader enters name/email and selects `Team member` or `Leader`; the backend idempotently creates or links the Authentik identity, assigns the tenant group automatically, creates the authoritative per-tenant membership, and sends the enrollment email.
  - Status: implementation/deployment foundation is in place behind `AUTHENTIK_PROVISIONING_ENABLED=false`: database authority, identity/job persistence, the bounded Authentik 2026.5.3 client, durable reconciliation, safe API states, and the streamlined Team UI are implemented. Production completion is still pending a dedicated least-privilege service token, recovery Email Stage UUID, signed-in phone/desktop verification, and cleanup of the tagged test identity. Human administrator credentials must not be stored in the app.

- [ ] **UI-049: Reuse verified item records across sessions**
  - Source: MVP field workflow, 2026-07-14.
  - Desired behavior: approved location/serial/reference photos can become the known item record; later packet imports suggest likely matches; the leader confirms the match and chooses up to three canonical old/new photos without losing evidence history.
  - Status: planned after crew access and account provisioning. Requires explicit media-promotion and item-match APIs rather than treating every historical proof photo as permanent reference data.

- [x] **UI-041: Recover cleanly from abandoned packet/session flows**
  - Source: screen recording from 2026-07-09 21:34.
  - Status: implemented locally, awaiting ACP, 2026-07-10. Focused lifecycle/error tests pass, the packet-wizard session-loading race is covered, and `qa/recorded-packet-flow.spec.js` replays import, closeout, navigation, source history, stale-error checks, and screenshots on desktop/mobile.
  - Current issue: after backing out of packet/session work, the visible session can disappear while the page still shows `Internal server error`; closed or empty sessions make the page feel stuck even when the active work is gone.
  - Desired behavior: cancel/close/back navigation clears stale status, chooses the next valid session, and never leaves an old error banner attached to an empty view.
  - Controls affected: `Upload packet`, packet wizard close/cancel, `Close` session, dashboard/session reloads.

- [x] **UI-042: Make packet review trustworthy before import**
  - Source: screen recording from 2026-07-09 21:34.
  - Current issue: uploaded PDF text lands in a cramped raw textarea and the review modal makes users scroll through guessed rows without a clear "valid rows vs ignored text" summary.
  - Desired behavior: show a parser summary before review, separate accepted/ignored text, preserve the source filename/type, and make low-confidence rows obvious without making users inspect raw PDF noise.
  - Controls affected: packet wizard source step, review rows step, import history.
  - Status: completed by current Codex thread, 2026-07-09. The packet wizard now shows source, ready rows, low-confidence rows, ignored text counts, collapsed ignored text diagnostics, and parser regression coverage. Safe for `UI-043` to continue; coordinate before changing packet wizard review layout or parser analysis output again.

- [x] **UI-043: Clean up empty/duplicate session lifecycle**
  - Source: screen recording from 2026-07-09 21:34.
  - Status: complete for the focused behaviors. Empty drafts can be deleted, duplicate empty sessions are reused, closed sessions are secondary, and closeout requires confirmation; the combined recording replay remains in `UI-041`/`QA-003`.
  - Current issue: repeated empty `Test` sessions and closed sessions remain visually noisy; users can create duplicates, close them, and still feel like the app is holding onto bad work.
  - Desired behavior: support delete/archive for zero-row sessions, hide closed sessions by default, prevent accidental duplicate empty sessions, and make `Close` a deliberate closeout action.
  - Controls affected: `New session`, session list, closed session archive, close/reopen controls.

- [x] **UI-044: Make API failures actionable**
  - Source: live packet/session QA and current backend error handling.
  - Status: implemented locally, awaiting ACP, 2026-07-10. API failures now return safe codes and request IDs, structured server logs retain route/tenant/subject context, UI errors show a support reference, and platform diagnostics remember the last failed request ID.
  - Current issue: several flows collapse to a generic `Internal server error`, so admins cannot tell whether the failure is auth, tenant access, parser input, storage, database state, or a transient API problem.
  - Desired behavior: user-facing errors stay safe and specific to the action, while support/admin diagnostics include a request ID, route, tenant, and next step for checking logs.
  - Controls affected: session create/close, packet upload/import, dashboard loads, tenant launch, review actions.

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

- [x] **UI-017: Pending item assignment**
  - Current issue: dashboard implies assignment/tasking, but assignment needs a complete workflow.
  - Desired behavior: tenant admin can assign rows to members; contributors see assigned rows; reassignment and "assign to me" update state.
  - Status: completed and mobile-refined, 2026-07-13. The home page follows one selected active inventory, defaults to the user's own work when present, and opens exact items. Actionable work is partitioned into `Unclaimed`, `Mine`, and `Others`; completed items live in a separate collapsible history. Claim is visible on mobile, has row-specific progress/duplicate protection, moves the row to Mine, and opens labeled proof entry. Proof requires ownership, while admins retain reassignment/unassignment controls.

- [x] **UI-018: Review queue actions**
  - Current issue: approve/reject/request more proof exists conceptually, but needs full confidence in live behavior and status feedback.
  - Desired behavior: every review action updates the queue, item state, session progress, and notification state.
  - Status: hardened locally, awaiting ACP, 2026-07-14. Approve, reject, and more-proof have nearby feedback; follow-up submissions now supersede the older actionable proof so a single decision clears the item, with stale-action, queue, and desktop/mobile regression coverage.

- [x] **UI-019: Reports view**
  - Current issue: reporting exists as closeout export pieces, but there is no clear Reports page.
  - Desired behavior: reports page for session closeout, missing items, found items, proof status, CSV export, printable summary.
  - Status: implemented locally, awaiting ACP, 2026-07-10. Tenant admins have a dedicated cross-session Reports page with session/lifecycle/outcome/proof filters, tenant-isolated aggregate data, current-filter CSV and print output, approved-missing outcome handling, spreadsheet-formula neutralization, and desktop/mobile QA coverage.

- [x] **UI-020: Inventory guidance view (retired)**
  - Current issue: guidance is a natural nav item but not a real page yet.
  - Desired behavior: per-tenant instructions, where-to-look notes, packet handling tips, and common equipment reference notes.
  - Status: retired from the tenant UI, 2026-07-11, after field review found the focused dashboard/session/proof flows sufficient. Existing guidance data and APIs are preserved for compatibility, but the page, navigation, Sessions shortcut, and settings editor are no longer user-facing.

## P1: People And Invite Flow

- [x] **UI-021: Invite helper needs full lifecycle**
  - Current issue: invite creation exists, but admin workflow needs resend/copy/revoke/expire clarity.
  - Desired behavior: invite list shows status, expiration, last sent, copy link, resend email, revoke.
  - Status: existing-account invite lifecycle completed in `USER-MANAGEMENT-001`, but this is not sufficient for new users because it does not provision an Authentik identity. `UI-047` and `UI-048` now own the usable field invitation paths.

- [x] **UI-022: Member role editing**
  - Current issue: members are listed but role management needs a visible flow.
  - Desired behavior: tenant admin can promote/demote helper vs platoon admin and remove members.
  - Status: completed in `USER-MANAGEMENT-002`, including last-active-admin protection.

- [x] **UI-023: Authentik group sync status**
  - Current issue: Authentik groups and backend tenant memberships can feel disconnected.
  - Desired behavior: each member row shows source of access: tenant membership, Authentik group, or platform admin override.
  - Status: operational diagnostics remain available to platform administrators, but tenant-facing group/source internals were removed on 2026-07-11. People & Invites now contains only actions a platoon admin can actually take, and Workspace Settings retains the workspace link without exposing Authentik group names.

## P1: FRG / Public Site Controls

- [x] **UI-024: Public login dropdown**
  - Current issue: it should be verified against final launch behavior.
  - Desired behavior: public visitors see vague wording; authorized users land in the app launcher, not Authentik's tile dashboard.
  - Status: implemented and QA-covered; durable auth routing is pushed, while the latest public wording/polish remains in the shared worktree awaiting ACP.

- [x] **UI-025: Newsletter signup and approval**
  - Current issue: signup exists, but live operational flow needs approval and email-send verification.
  - Desired behavior: public request, FRG admin approval/rejection, Brevo send path, unsubscribe path, export list.
  - Status: signup/approval is pushed; delivery, unsubscribe, and export are implemented locally and QA-covered but await consolidated ACP and real Brevo validation.

- [x] **UI-026: FRG content editor**
  - Current issue: newsletter/admin page exists, but the homepage still depends on curated app content.
  - Desired behavior: FRG admins can manage announcements, events, resources, and newsletter issues without touching code.
  - Status: completed in `NEWSLETTER-002`; later mobile/public polish remains in the shared worktree awaiting ACP.

## P2: Reduce Clutter And False Promises

- [x] **UI-027: Hide QA/manual token controls in production**
  - Current issue: `Use access token` is useful during setup but confusing for real users.
  - Desired behavior: only visible when `ALLOW_DEV_AUTH=true` or an explicit diagnostics flag is enabled.

- [x] **UI-028: Clean up legacy static app affordances**
  - Current issue: root static pages still have old admin/password flows and PDF upload wording.
  - Desired behavior: keep legacy app available intentionally, but label it as legacy or remove confusing admin links after cutover.
  - Status: completed in `LEGACY-001`; the static root is an explicitly labeled fallback.

- [ ] **UI-029: Empty states should always give one next action**
  - Current issue: several empty states explain what is missing but do not always include a next button.
  - Desired behavior: empty states include the next action when the user has permission, such as `Create session`, `Upload packet`, `Invite helper`.
  - Status: in progress, 2026-07-13. Dashboard work/review empty states now clear the active search or open the relevant session/queue, and Reports can reset all filters. Remaining People/invite and lower-frequency administration empty states still need the same treatment.

- [ ] **UI-030: Standardize action labels**
  - Current issue: similar actions use mixed labels: `Open`, `View all`, `Inventory`, `Admin view`, `Continue`.
  - Desired behavior: labels map to clear destinations: `Open workspace`, `Open session`, `Review queue`, `Import packet`, `Launch app`.
  - Status: in progress, 2026-07-13. Existing-work destinations now consistently say `Open session` or `Open item`; the one-action mobile overflow was replaced with a visible packet action; assignment lists use `Unclaimed`, `Mine`, and `Others`; review shortcuts say `Open review queue`. Packet/import wording and remaining platform/newsletter labels still need consolidation.

- [x] **UI-031: Mobile-first toolbar cleanup**
  - Current issue: desktop layout is improving, but mobile needs repeated inspection.
  - Desired behavior: primary action is visible, secondary actions collapse into a menu, text does not wrap awkwardly, tables become cards.
  - Status: implemented locally, awaiting ACP, 2026-07-11, through `UX-002`. Mobile platform/tenant navigation, compact headers, contextual secondary actions, drawer-backed session actions, real card labels, 44px targets, and viewport/focus/overflow QA now cover Pixel 7 and 360px layouts.

## P2: Product Completion Tasks

- [x] **UI-032: Session closeout flow**
  - Desired behavior: close session shows unresolved rows, review count, proof state, final report preview, and confirm close.
  - Status: implemented locally, awaiting ACP, 2026-07-10. Closeout now includes unresolved/status summaries, explicit confirmation, print/copy/CSV output, closed-session archiving, and a clear reopen action; focused and recorded-flow QA passes.

- [x] **UI-033: Item detail page/drawer**
  - Desired behavior: clicking a row opens a detail drawer with photos, known location, packet line, proof history, notes, and actions.
  - Status: implemented locally, awaiting ACP, 2026-07-10. The responsive drawer centralizes packet and known-item fields, source batch, assignment, full evidence history, nested photo viewing, role-aware actions, live feedback, keyboard/focus behavior, and closed-session read-only safeguards. Desktop/mobile QA passes.

- [x] **UI-034: Photo proof viewer**
  - Desired behavior: review queue has a real evidence viewer with image zoom, serial photo grouping, location note, and request-more-proof context.
  - Status: implemented locally, awaiting ACP, 2026-07-10. Current and historical evidence now use labeled thumbnails; the responsive viewer provides zoom, keyboard/touch-sized navigation, captions, submitter/location/serial/note details, and the prior request context for resubmitted proof. Desktop/mobile QA coverage passes.

- [x] **UI-035: Search behavior audit**
  - Desired behavior: tenant search filters dashboard tables, sessions, rows, proof submissions, and member views consistently.
  - Status: implemented locally, awaiting ACP, 2026-07-11, through `SEARCH-001`. A shared normalized multi-term matcher now drives page-scoped dashboard, session/proof-history, review, people/invitation, reports, platform/newsletter, and legacy-lookup search with clear/reset, query-aware empty states, focus behavior, and desktop/mobile coverage.

- [ ] **UI-036: Loading and error states**
  - Desired behavior: every async button has loading text, disabled state, success state, and a useful failure message.
  - Status: in progress, 2026-07-13. Assignment and claim actions now use row-scoped pending locks and `Claiming...`/saving feedback without freezing unrelated rows. Session lifecycle/direct-check actions already have scoped locks; remaining upload, people, and newsletter actions still need a systematic pass.
  - Status: in progress, 2026-07-11, through `UX-003`. Session direct-check and close/reopen mutations now have duplicate guards, conflicting-control locks, loading labels, failure references, and retry QA; public unsubscribe and legacy viewer login also lock while pending. Remaining newsletter and multi-row action audits are documented follow-ups.

## P3: Later SaaS Depth

- [ ] **UI-037: Multi-workspace switcher**
  - Desired behavior: platform admins or users in multiple platoons can switch workspaces from the user menu.

- [x] **UI-038: Audit log UI**
  - Desired behavior: platform and tenant admins can see who imported rows, changed status, approved proof, invited users, and closed sessions.
  - Status: implemented locally, awaiting ACP, 2026-07-11, through `AUDIT-001`. The tenant-scoped Activity Log provides safe human-readable event details, actor/action/category/entity/date filters, stable cursor pagination, related-session navigation, tenant isolation, and contributor denial. Platform admins can inspect it through their tenant override; a global cross-tenant feed is a later option.

- [x] **UI-039: Tenant settings**
  - Desired behavior: platoon admins can update the workspace display name and notification preferences without seeing deployment-only identity configuration.
  - Status: field-refined, 2026-07-11, through `TENANT-004`. Display name and in-app/email preferences remain editable, the workspace link remains copyable, and retired guidance plus read-only slug/Authentik group internals are no longer tenant-facing.

- [ ] **UI-040: Admin setup checklist**
  - Desired behavior: platform admin sees setup completion for DNS, Authentik group, tenant admin invite, packet import, and storage.

## Current Suggested Work Order

1. Publish and production-verify the completed `UI-045`/`UI-046` proof polish and `UI-047` crew-code flow at phone, tablet, and docked-desktop widths.
2. Make database membership authoritative, fix invite-email matching, and implement `UI-048` permanent Authentik provisioning behind a safe feature flag.
3. Implement `UI-049` verified-item reuse and canonical-photo selection.
4. Complete `UI-036`, `UI-029`, and `UI-030` while touching each remaining surface; keep `OPS-002` as an owner-only deferred verification.

This order follows the actual field event: leader starts work, brings the crew in, people claim and prove items, the leader closes the event, and the next event benefits from verified history.
