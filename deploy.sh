#!/usr/bin/env bash
# Build and restart the rootless Stencil CNC service. Caddy and cloudflared are
# intentionally configured separately: changing either affects other apps.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
APP_CONFIG_DIR="${CONFIG_ROOT}/stencil-cnc"
ENV_FILE="${STENCIL_CNC_ENV_FILE:-${APP_CONFIG_DIR}/stencil-cnc.env}"
QUADLET_DIR="${CONFIG_ROOT}/containers/systemd"
QUADLET_FILE="${QUADLET_DIR}/stencil-cnc.container"
QUADLET_ANALIZA="${QUADLET_DIR}/stencil-cnc-analiza.container"
QUADLET_RETEA="${QUADLET_DIR}/stencil-cnc.network"
VENV="${PROJECT_ROOT}/.venv"

for executable in npm podman systemctl curl install; do
  command -v "$executable" >/dev/null || {
    echo "required executable not found: ${executable}" >&2
    exit 1
  }
done

if [[ ! -f "$ENV_FILE" ]]; then
  install -d -m 0700 "$APP_CONFIG_DIR"
  install -m 0600 "$PROJECT_ROOT/site.env.example" "$ENV_FILE"
  echo "Created ${ENV_FILE}. Set ADMIN_TOKEN, then run deploy.sh again." >&2
  exit 2
fi

if ! grep -Eq '^ADMIN_TOKEN=.{32,}$' "$ENV_FILE"; then
  echo "ADMIN_TOKEN is missing or too short in ${ENV_FILE}." >&2
  echo 'Generate one with: openssl rand -hex 32' >&2
  exit 2
fi

for kit_file in pwa-update.js sw-update.js sw.js bust.html; do
  [[ -f "$PROJECT_ROOT/web/$kit_file" ]] || {
    echo "missing pwa-kit integration: web/${kit_file}" >&2
    exit 1
  }
done
grep -q '__BUILD_VERSION__' "$PROJECT_ROOT/web/sw.js" || {
  echo 'web/sw.js has no __BUILD_VERSION__ marker for pwa-kit updates' >&2
  exit 1
}

npm --prefix "$PROJECT_ROOT" test

# The analysis service has its own suite. Skipped only when no local
# environment exists -- the container build still runs, so a machine without
# Python can deploy, it just cannot vouch for that half.
if [[ -x "$VENV/bin/python" ]]; then
  "$VENV/bin/python" -m unittest discover \
    -s "$PROJECT_ROOT/test/analiza" -p "test_*.py"
else
  echo "No ${VENV}; skipping the analysis tests." >&2
fi

podman build \
  --tag localhost/stencil-cnc:latest \
  --file "$PROJECT_ROOT/deploy/Containerfile" \
  "$PROJECT_ROOT"

podman build \
  --tag localhost/stencil-cnc-analiza:latest \
  --file "$PROJECT_ROOT/deploy/Containerfile.analiza" \
  "$PROJECT_ROOT"

install -d -m 0755 "$QUADLET_DIR"
install -m 0644 "$PROJECT_ROOT/deploy/quadlet/stencil-cnc.network" "$QUADLET_RETEA"
install -m 0644 "$PROJECT_ROOT/deploy/quadlet/stencil-cnc-analiza.container" "$QUADLET_ANALIZA"
install -m 0644 "$PROJECT_ROOT/deploy/quadlet/stencil-cnc.container" "$QUADLET_FILE"
systemctl --user daemon-reload
# No `systemctl enable` here: quadlet generates these units, and a generated
# unit cannot be enabled. `[Install] WantedBy=default.target` inside each
# .container file is what makes them start at login.
#
# Analysis first: the web app can start without it and answer its own health
# check, which would make a broken pair look deployed.
systemctl --user restart stencil-cnc-analiza.service
systemctl --user restart stencil-cnc.service

for attempt in $(seq 1 30); do
  if curl -fsS --max-time 2 http://127.0.0.1:8101/api/health >/dev/null 2>&1; then
    # The analysis service publishes no port, so it is checked from inside the
    # network rather than from the host -- which is the whole point of it.
    if podman exec stencil-cnc-analiza \
         python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health', timeout=3).status==200 else 1)" \
         >/dev/null 2>&1; then
      echo 'Deployed Stencil CNC; both services answered.'
      exit 0
    fi
  fi
  sleep 1
done

echo 'The images were built, but both services did not become ready in time.' >&2
systemctl --user --no-pager status stencil-cnc-analiza.service >&2 || true
systemctl --user --no-pager status stencil-cnc.service >&2 || true
exit 1
