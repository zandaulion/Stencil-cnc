# Stencil CNC

Stencil CNC turns photographs and prepared artwork into connected, manufacturing-aware geometry for CNC plasma cutting. It combines creative image treatments with panel layout, support design, physical validation, manual touch-ups, and export in one installable web application.

The central rule is simple: dark geometry represents retained metal and light geometry represents material to remove. The editor keeps the source treatment, structural frame, supports, manual edits, and automatic manufacturing repairs as separate inputs so the final panel can be rebuilt and checked consistently.

## What it does

- Converts line art locally in the browser and photographs through a private analysis service.
- Provides 13 cut styles: Line art, Poster stencil, Icon stencil, Graphic portrait, Silhouette, Negative-space linework, Icon / Woodcut, Contour bands, Slats, Hatch, Radial cuts, Variable dots, and Ornamental symmetry.
- Fits artwork proportionally to portrait or landscape stock without stretching it.
- Models a configurable panel frame and preserves unused letterbox areas as metal.
- Adds manual or filter-aware automatic supports, including portrait-aware dark-feature placement and organic slat stabilizers that can add one sparse station to avoid a face.
- Supports live freehand Add material and Remove material brushes, straight strokes, connected-region edits, and single-gesture undo.
- Simulates kerf and checks disconnected material, minimum openings, close cuts, and minimum-web strength.
- Builds reversible manufacturing-repair previews before changing the artwork.
- Saves projects and creative candidates locally in the browser.
- Exports validated geometry as SVG, DXF, or a shareable PNG.
- Runs as an installable, offline-capable PWA after an authorised device has loaded it.

## Workflow

1. **Prepare** — import an image, choose a cut style, and tune its visual parameters.
2. **Panel** — set stock dimensions, orientation, frame edges, artwork fitting, and plasma constraints.
3. **Support** — inspect connectivity, generate smart bridges, or draw and refine supports manually.
4. **Validate** — compare pre- and post-kerf geometry, locate problems, and preview manufacturing repairs.
5. **Export** — download the checked result as SVG, DXF, PNG, or a portable Stencil project.

Related manufacturing exports share the validation timestamp and use descriptive,
portable names: `project_297x420mm_slats_frame_cut_2026-09-15-162005.dxf`.
PNG files use `preview`, editable projects use `editable`, and exports without a
perimeter frame use `no-frame`.

The default panel is 1250 × 2500 mm. The default plasma profile requires a 2 mm minimum opening and a 3 mm finished gap/web; generated features include kerf allowance where appropriate.

## Architecture

```text
Browser PWA
├── editor state, IndexedDB projects, canvas previews
├── deterministic geometry core (masks, topology, repair, export)
└── authenticated requests for photographic styles
          │
          ▼
Node / Express service
├── invite-based device access
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
- Browser projects stay in local IndexedDB; portable project files omit the private source photograph.
- Invite redemption stores a random device credential only in a secure, host-only, HttpOnly cookie.
- Server-side device records contain token hashes rather than plaintext credentials.
- The Python analysis service is not exposed publicly.
- Administration requires a separately configured secret and fails closed when it is absent.
- Revocation takes effect on the next online request. Already cached offline application data cannot be remotely erased from a disconnected device.

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
