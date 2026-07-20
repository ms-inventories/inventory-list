# Production UI Audit — July 19, 2026

This audit combines a live production walkthrough with a source review. The current local change set now gives the selected inventory, assignment tabs, claim action, and review action priority over administrative utilities on phones. Production verification is still pending after deployment.

## Demonstration Data Now Available

The following production demo data was created through the signed-in administrator UI. The existing MS Platoon data was not removed or altered.

| Workspace | Inventories | Demonstrated states |
| --- | --- | --- |
| Demo 1st Platoon | Two active, one closed baseline | Unclaimed, assigned to another user, claimed by the current user, completed, awaiting review, saved item history, approved prior location, and prior photo |
| Demo 2nd Platoon | Two active | Unclaimed, assigned to a leader, claimed by the current user, completed, and waiting temporary crew |
| Demo Maintenance Platoon | Two active | Unclaimed, assigned to a member, claimed by the current user, completed, and waiting temporary crew |

Each demo workspace has a platoon administrator, a member or viewer, and a temporary crew record waiting to join a session. Permanent accounts provision through Authentik immediately, so the administrator UI does not currently offer a reliable email-free `Pending` permanent-account state. Temporary session crew demonstrate the intended waiting state without exposing invite links or PINs in this document.

## Release Blockers

### P0 — Authenticated work is interrupted by reconnects (fixed locally; provider configuration pending)

During ordinary tenant work, the app repeatedly displayed `Reconnect to continue`. The current page remained visible, but an open form could be lost and the user had to complete an SSO round trip before continuing. A close-session action also had to be retried after authentication failed.

Production diagnosis: the deployed frontend requests `openid profile email groups ak_user_uuid` and omits `offline_access`. The Inventory Authentik provider also does not currently advertise the built-in `offline_access` scope. The notification poll is not logging the user out; it is simply the first request to discover that the short-lived access token expired and no renewable refresh-token cookie exists.

Implementation status: silent API renewal now happens without replacing or remounting the work surface. If renewal truly cannot recover, a native top-layer reconnect dialog keeps the current page and draft mounted; only the user's explicit `Sign in again` action starts an SSO redirect. The build also rejects a production OIDC scope that omits `offline_access`. The Authentik provider mapping and Coolify environment value below still have to be corrected before this behavior can be verified in production.

Required deployment correction:

1. Attach Authentik's built-in `offline_access` scope mapping to the Inventory OAuth2/OpenID provider and retain the refresh-token grant.
2. Set the provider's refresh-token lifetime to the intended signed-in period.
3. Set the frontend Coolify value to `VITE_OIDC_SCOPE=openid profile email groups offline_access ak_user_uuid` and redeploy.
4. Sign out and back in once to replace existing non-renewable browser sessions.

Expected behavior: after the initial sign-in, navigation and background updates remain silent until the renewable session truly expires or the user signs out. A recoverable background renewal may show a small non-blocking activity indicator, but it must not replace the work surface or discard a draft.

Acceptance checks:

- Keep an authenticated tenant page open for longer than one access-token lifetime without a reconnect prompt.
- Navigate backward and forward across platform and tenant routes without another sign-in.
- Leave a proof or user form partially completed while renewal occurs; all entered values remain intact.
- Notification polling never redirects, remounts the page, or clears form state.

### P0 — Dashboard state becomes stale after inventory mutations (fixed locally; production verification pending)

The dashboard, session workspace, and review queue keep separate data snapshots. In the live walkthrough, approved progress remained at 0%, a closed inventory still appeared active, and `No proof waiting` remained visible immediately after proof was submitted. Opening another panel or reconnecting eventually refreshed the values.

Implementation status: the current change set adds shared inventory revisions, guarded dashboard reloads, fallback-session propagation, mutation invalidation, and external-change refreshes. Desktop and phone regressions cover submission, approval, close, create, and manual refresh behavior. This item remains in the production gate only until the corrected build is deployed and verified against the live demo workspaces.

Expected behavior: successful create, import, assignment, proof, review, close, reopen, or delete actions invalidate every visible inventory summary without remounting the workflow or losing the selected inventory.

Acceptance checks:

- Submitting proof immediately updates `Needs review` and the dashboard review preview.
- Approving proof immediately removes it from the preview and updates resolved progress.
- Closing the selected inventory decrements the active count and selects the next active inventory.
- The workspace refresh control refreshes inventory and review data as well as identity metadata.

## Mobile Workflow and Visual Hierarchy

### P0 — Field work is buried below session administration (fixed locally; production verification pending)

At phone widths, the session layout becomes a single column. Summary metrics, `New session`, and the full session list appear before the selected inventory's assignment tabs and items. With several inventories, a field user must scroll through administration before reaching work.

Implementation status: the selected-inventory switcher, assignment tabs, and item list now precede inventory management at phone widths. The full inventory list and creation controls remain secondary.

### P0 — Dashboard and work queue behave like two dashboards stacked together (fixed locally; production verification pending)

Opening an inventory leaves the leader overview visible above an embedded inventory workspace. The page reads as `Leader Dashboard`, `Active inventory`, `Current inventory`, `Work queue`, `Inventory tasking`, and `Sessions` before the user reaches an item.

Implementation status: opening an inventory now replaces the dashboard body while preserving the app shell. `Back to dashboard` returns to the overview once.

### P1 — Administrative utilities precede the work list (fixed locally; production verification pending)

Closeout, import history, packet import, session creation, delete/close actions, and summary badges compete with claim and review work.

Implementation status: the item tabs and work list now follow the selected inventory. Closeout, import history, packet controls, and lifecycle actions are grouped under `Inventory tools`.

### P1 — Packet upload is duplicated (fixed locally; production verification pending)

`Upload packet` can appear on the dashboard, in the selected inventory, and again in an empty-inventory state. This makes it unclear which action begins a new inventory and which adds items to an existing one.

Implementation status: packet import is now contextual. An empty inventory offers `Add items from packet`; an existing populated inventory exposes one secondary `Add packet` action under inventory tools.

### P1 — The current inventory is not visually clear when several are active (fixed locally; production verification pending)

The selected session differs mainly by a subtle border/background, while platform cards say `Current inventory` even when multiple inventories are active. Newly created blank inventories can also become the platform card's primary inventory, hiding the more useful in-progress demonstration.

Implementation status: a labeled current-inventory selector and progress summary remain visible above the work tabs.

### P1 — Too many actions receive equal emphasis (fixed locally; production verification pending)

Full-width start, upload, invite, claim, and review actions compete on phones.

Implementation status: field actions retain primary emphasis while crew and administrative actions use secondary treatments.

## Copy and Polish

### P1 — Incorrect session summary label (fixed locally; production verification pending)

The session summary counts open inventories but labels the value `Open rows`.

Recommendation: label the existing count `Open inventories`, or change the metric to the actual unresolved item count.

### P2 — Incorrect plural (fixed locally; production verification pending)

Platform cards display `active inventorys`.

Recommendation: use the explicit plural `active inventories`.

### P2 — Technical import language leaks into field work (fixed locally; production verification pending)

Terms such as `packet rows`, `Packet import`, and similar parser-oriented copy appear on the main work surface.

Implementation status: the field workflow now uses `items`; packet/parser terminology is confined to packet and import tools.

### P2 — Desktop density is still useful evidence for mobile

The desktop layout fits more controls, but that masks the same hierarchy problem rather than resolving it. Mobile acceptance should be the primary gate; desktop should then use the extra width to support, not redefine, the workflow.

## Responsive Acceptance Gate

- At 360 × 800, the selected inventory, assignment tabs, and either the first item or a useful empty state are visible without scrolling past session administration.
- Opening an inventory does not leave dashboard cards above it.
- Only one packet-upload entry is visible in any context.
- A user can switch among three active inventories in one tap plus selection.
- Claim and review remain visually primary while closeout, import, and session management remain secondary.
- Counts and plurals are correct for zero, one, and multiple inventories.
- Outside the import flow, inventory entries are called `items`, not `rows`.

## Verification Completed

- The production frontend build and repository checks pass.
- Desktop Chromium: 170 executable checks passed; 8 phone-only checks were intentionally skipped.
- Pixel-sized mobile Chromium: 155 executable checks passed; 23 desktop/API-only checks were intentionally skipped.
- Combined matrix: 325 passed and 31 intentional skips, covering all 356 project/test entries.
- Authentication renewal, back/forward navigation, inventory and review search, direct claiming, proof review, prior-item history/photos, mobile users, notifications, reports, settings, packet upload, and newsletter layout were exercised in the local QA environment.
- QA exercised local newsletter publish and test-send endpoints with SMTP disabled; no message left the local stack and no production newsletter endpoint was written.
- All destructive resets were limited to the local `inventory-list-qa` Docker data. This verification performed no production-data writes.
