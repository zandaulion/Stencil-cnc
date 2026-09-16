# Kerfloom

**Art that holds together.**

Kerfloom turns photographs and prepared artwork into connected, manufacturing-aware geometry for CNC plasma cutting. It combines creative image treatments with panel layout, support design, physical validation, manual touch-ups, and export in one installable web application.

The central rule is simple: dark geometry represents retained metal and light geometry represents material to remove. The editor keeps the source treatment, structural frame, supports, manual edits, and automatic manufacturing repairs as separate inputs so the final panel can be rebuilt and checked consistently.

## What it does

- Converts line art locally in the browser and photographs through a private analysis service.
- Shows the actual light, midtone, and shadow interpretation before any cut pattern is applied.
- Provides 13 cut styles: Line art, Poster stencil, Icon stencil, Graphic portrait, Silhouette, Negative-space linework, Icon / Woodcut, Contour bands, Slats, Hatch, Radial cuts, Variable dots, and Ornamental symmetry.
- Radial cuts use a directly controlled solid-hub diameter and split rays progressively toward the panel edge.
- Fits artwork proportionally to portrait or landscape stock without stretching it.
- Models a configurable panel frame and preserves unused letterbox areas as metal.
- Adds manual or filter-aware automatic supports, including portrait-aware dark-feature placement and organic slat stabilizers that can add one sparse station to avoid a face.
- Supports live freehand Add material and Remove material brushes, straight strokes, connected-region edits, and single-gesture undo.
- Simulates kerf and checks disconnected material, minimum openings, close cuts, and minimum-web strength.
- Builds reversible manufacturing-repair previews before changing the artwork.
- Autosaves complete projects to an encrypted server workspace, with a durable offline browser cache, searchable library, recoverable Trash, and recent recovery points.
- Publishes an explicit, encrypted project snapshot for one invited recipient when the owner creates a private share link.
- Exports validated geometry as SVG, DXF, or a shareable PNG. Variable Dots
  retain their generated circle primitives, so zoomed previews and CNC vector
  exports remain round instead of tracing raster stair steps.
- Runs as an installable, offline-capable PWA after an authorised device has loaded it.

## Workflow

1. **Prepare** — import an image, inspect Original → Tone → Artwork, choose a cut style, and tune its visual parameters.
2. **Panel** — set stock dimensions, orientation, frame edges, artwork fitting, and plasma constraints.
3. **Support** — inspect connectivity, generate smart bridges, or draw and refine supports manually.
4. **Validate** — compare pre- and post-kerf geometry, locate problems, and preview manufacturing repairs.
5. **Export** — download the checked result as SVG, DXF, PNG, or a portable Kerfloom project.

Related manufacturing exports share the validation timestamp and use descriptive,
portable names: `project_297x420mm_slats_frame_cut_2026-09-15-162005.dxf`.
PNG files use `preview`, editable projects use `editable`, and exports without a
perimeter frame use `no-frame`.

The default panel is 1250 × 2500 mm. The default plasma profile starts with a 2 mm minimum opening and a conservative 3 mm finished gap/web; a machine-verified gap/web may be reduced to 2 mm. New projects store and export intended finished-part boundaries: apply inside/outside kerf compensation exactly once in CAM. Older projects remain explicitly marked as legacy until the user upgrades and re-renders them.

## Project library

Select **Projects** in the desktop header or the permanent mobile Tools bar to browse the encrypted server workspace. Project cards show a processed-geometry thumbnail, panel size, cut style, validation status, modification time, and whether the original source image is included. Projects can be opened, renamed, duplicated, downloaded, shared, or moved to Trash; trashed projects remain recoverable until they are explicitly deleted forever.

Autosave reports `Saving…`, `Saved to server`, an offline queued state, or a retry action if synchronization fails. Every change is written to IndexedDB first and placed in a durable upload queue; the UI reports a server save only after the server acknowledges the revision. Synchronization isolates failures per project, repairs a damaged queued package from its complete local copy when possible, and gives retries of the same edit one stable conflict-copy identity. A problem in an older project therefore cannot block a healthy current project or multiply conflict copies. Pending changes are flushed before opening or replacing a panel, and `Ctrl/Cmd+S` requests an immediate save. Kerfloom retains up to ten recovery points per project after validation, manufacturing repair, smart-support generation, and export.

The canonical encrypted package contains the editable geometry, original photograph, candidates, supports, repairs, recovery points, and retained SVG, DXF, and PNG exports. Portable `.stencil.json` downloads intentionally omit the source photograph.

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
