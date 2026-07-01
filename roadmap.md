# Inventory List Roadmap

## Current Product Shape

This is a lightweight inventory lookup tool for guard squad equipment accountability. Its real job is not generic inventory management; it is translating supply packet language into something a soldier can recognize quickly.

Primary field workflow:

1. Supply hands out a physical sub-hand-receipt packet with official Army names, LINs, NSNs, and quantities.
2. A user searches or scans an item line such as `A90594 ARMAMENT SUBSYS: M153`.
3. The app returns the friendly name, photo, description, and location.
4. Admins enrich the inventory with better names, photos, locations, and packet metadata.

Current architecture:

- Static public/admin frontend hosted from this repo, currently suitable for GitHub Pages.
- A separate Vite/React app now lives in `react-app/` for the future Coolify-hosted version.
- A separate Node/Fastify API now lives in `backend/` for the future multi-tenant Authentik/Coolify version.
- Read data comes from public S3 JSON files at `https://ms-inventories.s3.us-east-1.amazonaws.com`.
- Admin writes go through an AWS Lambda Function URL.
- Images are uploaded by presigned URL.
- Viewer password is a morale/convenience gate, not real security.
- Admin uses an admin key plus platoon password.
- OCR/PDF parsing is client-side and lazy-loaded:
  - Tesseract.js for paper/photo OCR.
  - PDF.js for text extraction from clean PDFs.
- The data model is flexible field arrays, now including `LIN`, `Army Name`, `Common Name`, `NSN`, `Description`, `Location`, quantity fields, and images.

## Packet Variability Assumptions

Do not assume every supply packet looks like the current sample.

Expected weirdness:

- Different units may export slightly different hand receipt layouts.
- Column names and column order may move.
- Some pages may include embedded photos, logos, seals, signatures, stamps, or extra headers.
- Some PDFs may be real text PDFs; others may be scanned image PDFs.
- Some pages may be rotated, skewed, cropped, low contrast, wrinkled, or partially blocked by hands/clips.
- Handwritten notes may appear near rows but should not be required for the app to work.
- OCR may split one item row across multiple lines or merge two rows together.
- The same item may appear by LIN, NSN, Army nomenclature, common name, or a shortened packet description.

Design implication: scanning should behave like a review/import wizard. It should extract likely candidates, show confidence and editable parsed fields, and make it easy to correct or ignore bad rows. It should not silently create records from a single guessed parse unless the user confirms it.

## Recommendation

Do not move on-prem or build full auth yet unless there is a concrete requirement: sensitive data, disconnected local network use, command policy, auditability, or multiple editors who need accountable logins.

For the current mission, the highest-value work is:

1. Make physical paper scanning and packet row selection more reliable.
2. Improve admin data quality so search results are good.
3. Add accountability-focused filters and reports.
4. Harden backups and admin safety.
5. Revisit auth/hosting only after the app is relied on by more people or the data becomes sensitive.

## Progress

- 2026-06-29: Scan candidate pickers now show parsed MPO, LIN, Army name, and confidence so users can review noisy packet results before choosing a row.
- 2026-06-29: Viewer search now shows closest-match suggestions when a strict packet search returns no exact results.
- 2026-06-29: Result cards now have a one-tap copy action for friendly name, LIN, Army name, NSN, and location.
- 2026-07-01: Added a separate Vite/React app under `react-app/` for the future Coolify deployment while leaving the root static GitHub Pages app intact.
- 2026-07-01: Added a SaaS architecture doc and backend scaffold for Authentik login, tenant subdomains, LT/NCO inventory sessions, evidence submissions, and LT review.

## Phase 1: Make Packet Lookup Excellent

Goal: users can decode supply packet items in seconds on a phone.

Features:

- Improve scan result selection:
  - Show likely packet rows grouped by page.
  - Show parsed `LIN`, `Army Name`, and `OH Qty` under each candidate row.
  - Add a "search this row" and "create admin draft" action from the same picker.
- Make scanning layout-tolerant:
  - Treat embedded photos and stamps as noise, not failure.
  - Ignore obvious document headers, logos, page numbers, signatures, and notes.
  - Allow users to crop/select a page region when a full-page scan is noisy.
  - Keep the one-line scan path as a fallback for badly formatted pages.
- Add an import review screen:
  - Show extracted candidates with confidence indicators.
  - Let the user edit parsed fields before searching or creating drafts.
  - Allow "ignore this row" so photos/headers/false positives do not pollute results.
- Add alias matching:
  - Store search aliases such as `CROWS`, `turret`, `M153`.
  - Search against `Army Name`, `Common Name`, `LIN`, `NSN`, aliases, description, and location.
- Add a "Did you mean?" fallback:
  - If exact token matching finds nothing, show closest partial matches.
  - Prioritize LIN and Army-name matches over generic text matches.
- Add recently searched items:
  - Keep local recent searches on device.
  - Useful during one inventory event where the same packet terms come up repeatedly.
- Add a one-tap "copy item info" action:
  - Copy friendly name, Army name, LIN, and location for texting or notes.

Acceptance criteria:

- A user can scan a full paper page, pick the correct row, and get the item result.
- If a page contains embedded photos or a slightly different table layout, the app still surfaces plausible rows or offers a clean fallback.
- A user can search either `J00697`, `JOINT CHMCL AGENT: DETECTOR`, or `chem detector` and reach the same item.
- Long locations never overlap item titles or photos.

## Phase 2: Admin Data Quality

Goal: make it easy to build and maintain a useful inventory without careful manual formatting.

Features:

- Add item quality indicators:
  - Missing photo.
  - Missing location.
  - Missing common name.
  - Missing LIN/Army name.
  - Placeholder image detected.
- Add admin filters:
  - `Needs photo`
  - `Needs location`
  - `Needs common name`
  - `Packet fields missing`
- Add duplicate detection:
  - Warn when another item has the same LIN, NSN, serial, or Army name.
- Add bulk draft creation from a packet page:
  - Upload/scan page.
  - Select multiple extracted rows.
  - Create draft items for each selected row.
  - Review and correct parsed fields before save.
  - Save ignored rows so the same false positives do not reappear during the same import session.
- Add image compression before upload:
  - Resize large phone photos client-side.
  - Keep uploads fast and reduce S3/storage cost.
- Add field presets:
  - Vehicle/equipment.
  - Commo.
  - Tools.
  - Medical.
  - Training aids.

Acceptance criteria:

- Admin can quickly see which records need enrichment.
- A packet page can create multiple draft items without repeated camera scans.
- Uploading phone photos does not create huge original-size images by default.

## Phase 3: Inventory Event Workflow

Goal: support the actual inventory event, not just lookup.

Features:

- Add inventory session mode:
  - Start session.
  - Mark item as `Found`, `Not found`, `Not checked`, or `Mismatch`.
  - Store session locally first; optionally save later.
- Add discrepancy notes:
  - Quantity mismatch.
  - Wrong location.
  - Damaged.
  - Needs follow-up.
- Add progress view:
  - Total packet items.
  - Checked.
  - Missing.
  - Needs review.
- Add export:
  - CSV/JSON for results.
  - Printable summary for leadership/supply.
- Add "unknown item" capture:
  - Photo + note + temporary name.
  - Admin can reconcile later.

Acceptance criteria:

- During an inventory, a squad leader can track what has been touched and what still needs work.
- After the event, the app can produce a discrepancy list.

## Phase 4: Safety, Backup, and Admin Hardening

Goal: reduce the chance of accidental data loss without turning the app into enterprise software.

Features:

- Add save conflict protection:
  - Track last-loaded timestamp/hash.
  - Warn if another admin saved newer data.
- Add basic version history:
  - Save dated JSON snapshots before writes.
  - Add a restore-from-backup admin action.
- Add audit metadata:
  - Last updated time.
  - Optional editor name.
  - Last changed fields.
- Add delete confirmations for item deletion, not only platoon deletion.
- Add CORS/origin restrictions on the write API.
- Add admin key rotation notes and a documented recovery process.

Acceptance criteria:

- Accidental item/platoon edits can be recovered.
- Two admins cannot silently overwrite each other without warning.
- There is a clear "how to recover" path.

## Phase 5: Hosting and Auth Decision

Keep the current static + S3 + Lambda design unless one of these becomes true:

- The inventory data is considered sensitive.
- More than a few admins need individual accountability.
- Users need CAC/SSO-style access.
- The app must work on an internal/offline network.
- AWS access/cost/ownership becomes a headache.
- Leadership requires audit logs and real access control.

### Option A: Keep Current Hosting

Best if the app remains internal-but-not-secret and mostly read-only.

Pros:

- Minimal ops burden.
- GitHub Pages is enough for static HTML/CSS/JS.
- S3/Lambda already match the current app.
- Cheap and simple.

Cons:

- Viewer password is not security.
- Public JSON data can be fetched by anyone who knows the URL.
- Admin identity is just a shared key.

Recommended improvements before changing hosting:

- Add backup/version history.
- Restrict Lambda write origin where practical.
- Rotate admin key periodically.
- Move config URLs into one `config.js`.

### Option B: Static Frontend + Real Auth API

Best if the public viewer needs real access control but you want to keep the static frontend.

Architecture:

- Keep GitHub Pages or another static host.
- Put all inventory reads/writes behind an API.
- Use a real auth provider such as AWS Cognito, Google/Microsoft OAuth, or another identity layer.
- Make S3 inventory JSON private.

Pros:

- Stronger security without rebuilding the whole app.
- Still low ops.
- Can add roles like `viewer`, `editor`, `admin`.

Cons:

- More moving pieces.
- Auth flows are work.
- Requires changing all read paths, not just admin writes.

### Option C: Coolify / On-Prem Self-Hosted App

Best if you need internal-network control, no AWS dependency, or a real database-backed app.

Architecture:

- Containerized app deployed through Coolify.
- Backend API with real sessions.
- SQLite/Postgres database.
- Local file storage, network share, or S3-compatible storage such as MinIO.
- Optional reverse proxy and HTTPS via Coolify.

Pros:

- Full control of data and auth.
- Easier to add real user accounts, audit logs, and a database.
- Good fit if you already maintain a server.

Cons:

- You own uptime, backups, patching, and server security.
- More complexity than the current mission likely needs.
- Phone access may be harder if users are not on the same network/VPN.

Recommendation: do not move to Coolify yet unless you also plan to build inventory sessions, real user accounts, and a database. Moving the current static app on-prem just relocates complexity without adding much user value.

## Phase 6: Possible Full App Rewrite

Only consider React/Svelte/Vue or a backend rewrite when the UI state becomes hard to manage in plain JavaScript.

Rewrite triggers:

- Multi-item packet import becomes complex.
- Inventory sessions require lots of local state.
- Real auth and roles are added.
- Admin editing needs validation, autosave, undo, and history.
- Multiple users need concurrent editing.

Potential stack:

- Frontend: SvelteKit, React, or plain Vite.
- Backend: Node/Express, Fastify, or serverless functions.
- Database: SQLite for on-prem single-server, Postgres for multi-user.
- Storage: S3/MinIO/local volume.
- Auth: session cookies for on-prem, OAuth/OIDC for hosted.

Do not rewrite just for style. The current static app is still valid until workflow complexity forces a framework.

## Suggested Next 12 Issues

1. Add layout-tolerant packet parsing with row confidence and page grouping.
2. Add a crop/region-select fallback for noisy physical paper scans.
3. Add item quality indicators and admin filters for missing photo/location/common name.
4. Add aliases field and improve search ranking.
5. Improve packet candidate rows to parse and display `MPO`, `LIN`, `Army Name`, `NSN`, and `OH Qty`.
6. Add bulk draft creation from packet scan/PDF with review and ignore controls.
7. Add client-side image compression before upload.
8. Add inventory session mode with `Found`, `Missing`, `Mismatch`, and notes.
9. Add CSV export for inventory session results.
10. Add JSON backup snapshots and restore UI.
11. Add duplicate detection warnings in admin.
12. Add a real README with deployment, data format, admin key, and recovery notes.

## Technical Debt

- Configuration is hard-coded in both `script.js` and `admin.js`.
- `admin.js` is large and should be split by responsibility if features continue growing.
- Data is a flexible field array, which is convenient but makes validation/search harder.
- Viewer password is stored in the public inventory JSON.
- No automated tests currently cover search parsing, OCR candidate extraction, or admin save payloads.
- OCR/document parsing currently depends on heuristics and should gain fixtures for multiple hand receipt layouts.
- CDN dependencies are unpinned at the integrity level.
- `package-lock.json` is untracked and should either be removed or committed only if a real package manifest is added.
- README is empty.

## Immediate Recommendation

Stay on GitHub Pages + S3/Lambda for now.

Build the next few features around field use:

1. Better scan row selection and layout-tolerant parsing.
2. Admin data quality filters.
3. Bulk packet import into draft items with review/ignore controls.
4. Inventory session mode.
5. Backup/version history.

Revisit Coolify/on-prem once the app needs real users, real audit logs, or an internal-only deployment. Until then, on-prem hosting is probably more operational weight than mission value.

## Reference Docs

- GitHub Pages: https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages
- GitHub Pages project site overview: https://pages.github.com/
- AWS Lambda Function URLs: https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html
- Lambda Function URL access control: https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html
- Amazon S3 static website hosting: https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteHosting.html
- Coolify docs: https://coolify.io/docs
- Coolify self-hosted overview: https://coolify.io/self-hosted/
