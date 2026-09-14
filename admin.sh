#!/usr/bin/env bash
# Local administration fallback. The normal GUI is pwa-invite-console; this
# talks to the same contract directly over the loopback-only container port.
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_ROOT="${XDG_CONFIG_HOME:-${HOME}/.config}"
ENV_FILE="${STENCIL_CNC_ENV_FILE:-${CONFIG_ROOT}/stencil-cnc/stencil-cnc.env}"

if [[ -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090 -- the path is deliberately configurable.
  source "$ENV_FILE"
  set +a
fi

ADMIN_API="${ADMIN_API:-http://127.0.0.1:8101}"

pretty() { python3 -m json.tool 2>/dev/null || command cat; }
json_label() {
  python3 -c 'import json,sys; print(json.dumps({"label": " ".join(sys.argv[1:])}))' "$@"
}
request() {
  local method="$1" path="$2" body="${3:-}"
  : "${ADMIN_TOKEN:?Set ADMIN_TOKEN in ${ENV_FILE}}"
  if [[ -n "$body" ]]; then
    curl -fsS --max-time 15 -X "$method" \
      -H "X-Admin-Token: ${ADMIN_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data "$body" "${ADMIN_API}${path}"
  else
    curl -fsS --max-time 15 -X "$method" \
      -H "X-Admin-Token: ${ADMIN_TOKEN}" "${ADMIN_API}${path}"
  fi
}

usage() {
  command cat <<'USAGE'
Stencil CNC administration

usage: ./admin.sh <command>

  invite [label]       create an invite
  invites              list invites
  unvite <id>          revoke an unused invite
  devices              list registered devices
  revoke <id>          revoke a device
  unrevoke <id>        restore a device
  forget <id>          permanently delete a device
  name <id> <label>    rename a device
  prune-invites        delete spent, cancelled, and expired invites
  prune-devices        permanently delete revoked devices
  health               check service health

The shared pwa-invite-console is the normal interface. This script is useful
for first-install verification or recovery on the host.
USAGE
}

command_name="${1:-}"
case "$command_name" in
  invite)
    shift
    request POST /api/admin/invites "$(json_label "$@")" | pretty
    ;;
  invites)
    request GET /api/admin/invites | pretty
    ;;
  unvite)
    request POST "/api/admin/invites/${2:?invite id required}/revoke" '{}' | pretty
    ;;
  devices)
    request GET /api/admin/devices | pretty
    ;;
  revoke)
    request POST "/api/admin/devices/${2:?device id required}/revoke" '{"revoked":true}' | pretty
    ;;
  unrevoke)
    request POST "/api/admin/devices/${2:?device id required}/revoke" '{"revoked":false}' | pretty
    ;;
  forget)
    request DELETE "/api/admin/devices/${2:?device id required}" | pretty
    ;;
  name)
    device_id="${2:?device id required}"
    shift 2
    [[ $# -gt 0 ]] || { echo 'device label required' >&2; exit 2; }
    request POST "/api/admin/devices/${device_id}/label" "$(json_label "$@")" | pretty
    ;;
  prune-invites)
    request POST /api/admin/invites/prune '{}' | pretty
    ;;
  prune-devices)
    request POST /api/admin/devices/prune '{}' | pretty
    ;;
  health)
    curl -fsS --max-time 15 "${ADMIN_API}/api/health" | pretty
    ;;
  *)
    usage
    [[ -z "$command_name" ]] || exit 2
    ;;
esac
