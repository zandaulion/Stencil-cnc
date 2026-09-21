# Kerfloom

**Art that holds together.**

Kerfloom turns photographs and prepared artwork into connected, manufacturing-aware geometry for CNC plasma cutting. It combines creative image treatments with panel layout, support design, physical validation, manual touch-ups, and export in one installable web application.

The central rule is simple: dark geometry represents retained metal and light geometry represents material to remove. The editor keeps the source treatment, structural frame, supports, manual edits, and automatic manufacturing repairs as separate inputs so the final panel can be rebuilt and checked consistently.

## Documentation

Select **Help** in the Kerfloom header for the searchable, mobile-responsive handbook. The existing question-mark button in each workflow stage opens that handbook directly at the relevant chapter. It covers the complete creative workflow, all style families, tone and placement, cutting-profile terminology, smart and manual supports, validation and reversible repairs, CAM hand-off, autosave and recovery, linked devices, sharing, keyboard/mobile use, privacy boundaries, troubleshooting, and a final release checklist.

The repository source of truth is [`docs/KERFLOOM_USER_GUIDE.md`](docs/KERFLOOM_USER_GUIDE.md). The separate [`docs/K14_MOBILE_ACCESSIBILITY_ACCEPTANCE.md`](docs/K14_MOBILE_ACCESSIBILITY_ACCEPTANCE.md) records the outstanding physical-device and assistive-technology acceptance matrix, [`docs/K16_PROCESSING_BASELINE.md`](docs/K16_PROCESSING_BASELINE.md) records the deterministic performance baseline and device-acceptance procedure, and [`docs/KERFLOOM_AUDIT_AND_ACTION_PLAN.md`](docs/KERFLOOM_AUDIT_AND_ACTION_PLAN.md) records the product audit and implementation history.

## What it does

- Converts line art locally in the browser and photographs through a private analysis service.
- Shows the actual light, midtone, and shadow interpretation before any cut pattern is applied.
- Provides 14 cut styles with representative visual swatches and concise intent descriptions: Line art, Poster stencil, Icon stencil, Graphic portrait, Silhouette, Negative-space linework, Icon / Woodcut, Flow engraving, Contour bands, Slats, Hatch, Radial cuts, Variable dots, and Ornamental symmetry.
- Suggests an explicit, reversible starting point for physical pattern dimensions from the current panel size and cutting-profile limits; mandatory clamps remain explained beside the changed controls.
- Flow engraving bends long, parallel cut ribbons around broad facial forms while enforcing the selected opening and finished-web limits during generation.
- Radial cuts use a directly controlled solid-hub diameter and split rays progressively toward the panel edge.
- Fits artwork proportionally to portrait or landscape stock without stretching it.
- Models a configurable panel frame and preserves unused letterbox areas as metal.
- Adds manual or filter-aware automatic supports, including portrait-aware dark-feature placement and organic slat stabilizers that can add one sparse station to avoid a face. Smart supports remain a dashed, reviewable proposal until accepted.
- Keeps manual Add, Remove, and Restore work as ordered, non-destructive operations in physical panel units. Freehand strokes can be smoothed, straight strokes can be angle-constrained, connected regions remain reversible, and an Edit tool can select, move, resize, hide, change, or delete one operation without rewinding later work.
- Simulates kerf and checks disconnected material, minimum openings, close cuts, and configured minimum-web geometry.
- Stores a versioned cutting-profile snapshot with each project and retained export: process, stock, machine/consumable, geometry limits, support assumptions, revision, and evidence status travel together.
- Builds reversible manufacturing-repair previews before changing the artwork.
- Reports each repair attempt's physical area, connectivity, full-width-core survival, raster uncertainty, stop reason, rejected-candidate counts, and next action against the exact cutting-profile revision and validation model.
- Keeps validation, repair planning, repair-choice evaluation, and smart-support planning off the interface thread. Each operation has visible progress and Cancel; stale results are rejected while the last accepted geometry remains usable. Private per-device timing diagnostics are available in Help.
- Autosaves complete projects to an encrypted server workspace, with a durable offline browser cache, searchable library, recoverable Trash, and recent recovery points.
- Publishes an explicit, encrypted project snapshot for one invited recipient when the owner creates a private share link.
- Exports validated geometry as SVG, DXF, or a shareable PNG. Variable Dots
  retain their generated circle primitives, so zoomed previews and CNC vector
  exports remain round instead of tracing raster stair steps.
- Reports the export mask's effective X/Y millimetres per cell and retains a
  tamper-evident release manifest with exact geometry/output hashes, units,
  cutting-profile snapshot, compensation contract, and validation evidence.
  The manifest travels inside encrypted synchronized and shared artefacts.
- Runs as an installable, offline-capable PWA after an authorised device has loaded it.

## Workflow

1. **Prepare** — import an image, inspect Original → Tone → Artwork, choose a visually identified cut style, optionally apply its panel/profile-guided starting dimensions, and tune its creative parameters. The canvas distinguishes a quick provisional preview from the current processed style geometry; processing completion is not manufacturing validation.
2. **Panel** — set stock dimensions, orientation, frame edges, artwork fitting, and plasma constraints.
3. **Support** — inspect connectivity, preview and accept smart bridges, or create supports by dragging or tapping start/end points. A keyboard-accessible list can select, locate, move numerically, rotate, resize, or delete each support; Pan never edits geometry.
4. **Validate** — compare pre- and post-kerf geometry, locate problems, and preview manufacturing repairs.
5. **Export** — download the checked result as SVG, DXF, PNG, or a portable Kerfloom project.

### Mobile and keyboard workflow

On screens up to 720 px wide, the canvas remains fixed in the available app viewport. Tap any numbered stage, or **Adjust _stage_**, to open that stage's controls in a compact bottom sheet; close it to inspect the result without scrolling past the controls. **Candidates/Problems** opens the review sheet. Projects, synchronization state, Undo/Redo, and editing tools remain in the bottom rail, while **Fit** remains visible in the two-row canvas toolbar. The tool rail scrolls horizontally when the screen cannot hold every editing tool.

Workflow, review, and project-library tabs use Left/Right Arrow, Home, and End. Visible focus is retained throughout the editor, and transient visual notices are mirrored into persistent polite or urgent live regions. In **Pan**, one finger moves the canvas and browser pinch zoom remains available. Add/Remove/Restore/Artwork/Support modes reserve one primary pointer for the active edit and cancel safely on browser interruption; switch back to Pan for page-level pinch zoom. Hold Space for temporary Pan while the canvas has focus. Support creation and editing also have tap-start/tap-end, numeric, list, and keyboard alternatives.

This is an accessibility-oriented interaction pass, not a blanket WCAG conformance claim. The current physical-device and assistive-technology acceptance matrix is recorded in [`docs/K14_MOBILE_ACCESSIBILITY_ACCEPTANCE.md`](docs/K14_MOBILE_ACCESSIBILITY_ACCEPTANCE.md).

### Flow engraving

Choose **Lines and engraving → Flow engraving** for portraits made from long,
coherent cut ribbons rather than straight slats or independent woodcut marks.
The filter begins with a parallel rhythm, then bends the shared ribbon field
around broad tonal forms such as hair, brows, cheeks, clothing, and shadow.
Highlights open into wider ribbons while deep shadows remain retained metal.

The filter exposes six direct controls:

- **Ribbon pitch** sets the centre-to-centre spacing of neighbouring cuts.
- **Maximum cut width** controls how far a bright ribbon may open. Kerfloom
  limits it automatically so the configured finished web still fits beside it.
- **Base direction** rotates the underlying parallel rhythm before local form
  bends it.
- **Follow features** controls the strength of that local bending. At zero the
  result is straight; higher values follow the photograph more strongly.
- **Flow smoothing** chooses the physical scale of forms that influence the
  bend. Larger values ignore skin texture and follow broader facial volumes.
- **Dark-area cutoff** suppresses cuts in hair and deep shadow. The shared Tone
  controls remain available for adjusting the interpretation before ribbons
  are generated.

**Remove the background** produces an isolated positive portrait like a
graphic engraving. Turn it off to cut the same flowing ribbons into an
otherwise solid plate. Smart and manual supports align across the ribbon
direction, while the normal Support and Validate stages remain responsible for
connecting the portrait to the selected frame or anchor edges.

Flow engraving generates against the selected minimum opening and finished-web
limits rather than relying on automatic repair afterwards. Each ribbon starts
at a cuttable width, adjacent ribbons reserve the required metal between them,
and a locally over-curved area remains solid when it cannot meet the configured widths for both.
This preserves the visual rhythm without creating a knowingly destructive
repair step.

Related manufacturing exports share the validation timestamp and use descriptive,
portable names: `project_297x420mm_slats_frame_cut_2026-09-15-162005.dxf`.
PNG files use `preview`, editable projects use `editable`, and exports without a
perimeter frame use `no-frame`.

The default panel is 1250 × 2500 mm. The reusable General plasma profile starts with a 2 mm minimum opening and a conservative 3 mm finished gap/web; 2 mm is available as a lower exploration limit but must be confirmed for the selected stock and machine. Profiles remain **Provisional** unless the operator records a material, thickness, machine, verification source, evidence note, verifier, and date from machine documentation or a shop test. New projects store and export intended finished-part boundaries: apply inside/outside kerf compensation exactly once in CAM. Older projects retain their exact numeric constraints and artwork under an explicit **Legacy project settings · Provisional** snapshot.

## Project library

Select **Projects** in the desktop header or the permanent mobile Tools bar to browse the encrypted server workspace. Project cards show a processed-geometry thumbnail, panel size, cut style, validation status, modification time, and whether the original source image is included. Projects can be opened, renamed, duplicated, downloaded, shared, or moved to Trash; trashed projects remain recoverable until they are explicitly deleted forever.

Select **Projects → Devices** to connect a phone, tablet, or another computer to the same live workspace. Name the device, then scan the one-time QR code or privately send its link. The credential is carried in the URL fragment so it is not included in HTTP request logs, expires automatically, and can be cancelled before use. The Devices screen shows every linked device and its last connection time; another linked device can revoke a lost device, while Kerfloom prevents the current device from accidentally revoking itself. If a browser already belongs to a different workspace, it must explicitly confirm replacing that connection. Device linking gives both devices access to the same projects and is intentionally distinct from **Share**, which creates an independent editable copy.

Autosave reports `Saving…`, `Saved to server`, an offline queued state, or a retry action if synchronization fails. Every change is written to IndexedDB first and placed in a durable upload queue; the UI reports a server save only after the server acknowledges the revision. Synchronization isolates failures per project, repairs a damaged queued package from its complete local copy when possible, and gives retries of the same edit one stable conflict-copy identity. A problem in an older project therefore cannot block a healthy current project or multiply conflict copies. Pending changes are flushed before opening or replacing a panel, and `Ctrl/Cmd+S` requests an immediate save. Kerfloom retains up to ten recovery points per project after validation, manufacturing repair, accepted smart-support changes, and export.

Accepted manufacturing repairs remain active while the user completes manual material and support corrections. A hand-painted cell overrides only an opposite generated edit at that cell; unaffected generated repairs remain reversible and active. The combined geometry is checked automatically after each committed manual gesture. Changing the underlying artwork, panel geometry, or cutting limits still marks dependent repair work stale and requires regeneration.

The canonical encrypted package contains the editable geometry, original photograph, candidates, supports, repairs, recovery points, and retained SVG, DXF, and PNG exports. Each project and newly retained export records its full cutting-profile snapshot rather than only a mutable preset name. Portable `.stencil.json` downloads intentionally omit the source photograph.

### Private project sharing

Select **Share** on a project card to create a server-hosted snapshot. The share package contains the editable project, original source image when it remains available, creative candidates, manual edits, supports, repairs, up to ten recovery points, and export artefacts retained by the current browser. SVG, DXF, and PNG exports are retained locally from this release onward; files downloaded by older versions cannot be recovered from the browser's Downloads folder automatically.

Share packages are encrypted at rest and protected by a random secret that appears only in the link and the creating browser. A recipient must open that link on an invited Kerfloom device. The first recipient device claims the snapshot and can import an independent editable local copy. Shares expire after 7, 30, or 90 days and the owner can revoke them from the same project's Share dialog. Revocation prevents another download but cannot erase a copy the recipient already imported.

Sharing creates an independent copy for the recipient. It does not grant access to the owner's live server project, and neither copy changes when the other person edits theirs.

## Architecture

```text
Browser PWA
├── editor state, offline IndexedDB cache and durable sync outbox
├── deterministic geometry core (masks, topology, repair, export)
└── authenticated project synchronization and photographic styles
          │
          ▼
Node / Express service
├── invite-based device access
├── isolated workspaces and encrypted canonical project bundles
├── encrypted, expiring project-share packages
├── static PWA and protected editor modules
└── private proxy to the analysis service
          │
          ▼
Python / FastAPI analysis service
└── OpenCV + MediaPipe portrait analysis and style rendering
```

The two server processes are intentionally separate. The Node service owns authentication and the public HTTP boundary. The Python service has no public port and performs only image analysis and mask generation.

## Local development

Requirements:

- Node.js 24 or newer
- Python 3.11
- The native libraries required by OpenCV and MediaPipe

Install the JavaScript and Python dependencies:

```bash
npm ci
python3 -m venv .venv
.venv/bin/pip install -r analiza/requirements.txt
```

Start the analysis service in one terminal:

```bash
MODEL_DIR="$PWD/models" \
PYTHONPATH="$PWD/analiza" \
.venv/bin/uvicorn app:app --host 127.0.0.1 --port 8000
```

Start the web service in another terminal. Use a newly generated development-only token; never store it in the repository.

```bash
ADMIN_TOKEN="$(openssl rand -hex 32)" \
PROJECT_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
ANALIZA_URL="http://127.0.0.1:8000" \
DATA_DIR="$PWD/data" \
BIND_HOST="127.0.0.1" \
PORT="3000" \
npm start
```

The editor is device-gated even in development. With the same `ADMIN_TOKEN` available in your shell, create a local invite through the administration script:

```bash
ADMIN_API="http://127.0.0.1:3000" ./admin.sh invite "Local browser"
```

Then open `http://127.0.0.1:3000` and redeem the generated one-time code.

## Testing

Run the JavaScript server, geometry, workflow, security, and deployment tests:

```bash
npm test
```

Run the Python image-processing tests:

```bash
.venv/bin/python -m unittest discover -s test/analiza -p "test_*.py"
```

The geometry core is deterministic and covered independently of the browser UI. Validation and export consume the same final mask so an export option cannot silently bypass the geometry that was checked.

## Deployment

Production deployment uses two rootless Podman containers on a private network. The web container is bound to loopback; Caddy is the only origin, and the analysis container is reachable only from the private container network.

```bash
./deploy.sh
```

On first use, the script creates a private environment-file template and stops so an administrator can add a strong token. It subsequently runs both test suites, builds the containers, installs the user Quadlets, restarts the services, and verifies both health endpoints.

See [deploy/README.md](deploy/README.md) for the complete Caddy, tunnel, invite-console, and service setup.

## Privacy and security

- Original photographs and generated previews are ignored by Git by default.
- Complete projects are encrypted at rest in an isolated server workspace; IndexedDB is an offline cache and durable upload queue.
- Original photographs, recovery points, and retained exports are included in canonical server packages. Portable project downloads still omit the photograph.
- Revision checks prevent one device from silently overwriting another; a conflicting edit is preserved as a separate project.
- Share secrets are stored as hashes on the server; encrypted bundle files live under the private data volume and are removed after revocation or expiry cleanup.
- Invite redemption stores a random device credential only in a secure, host-only, HttpOnly cookie.
- Server-side device records contain token hashes rather than plaintext credentials.
- The Python analysis service is not exposed publicly.
- Administration requires a separately configured secret and fails closed when it is absent.
- Revocation takes effect on the next online request. Already cached offline application data cannot be remotely erased from a disconnected device.
- Backups must include the SQLite database, the entire `/data/projects` directory, and the active project encryption key. Restore procedures should be tested regularly.

Never commit `.env` files, the runtime `data/` directory, database files, photographs, generated previews, certificates, private keys, or real invite/admin credentials. The repository's [.gitignore](.gitignore) excludes these by default.

## Project layout

```text
analiza/       Python analysis and photographic style generation
deploy/        Containerfiles, rootless Quadlets, and Caddy guidance
models/        Bundled local analysis model
server/        Express application, authentication, and persistence
test/          JavaScript and Python test suites
web/           PWA shell, editor, storage, and deterministic geometry core
admin.sh       Loopback administration helper
deploy.sh      Tested build-and-deploy entry point
```

## License

The application is licensed under GPL-3.0-or-later. Third-party notices are recorded in [NOTICE.md](NOTICE.md).
