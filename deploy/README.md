# Deployment and access boundary

Stencil CNC runs as two rootless containers on a private Podman network.
Express serves the PWA and invite API from container port 3000 and proxies
photograph conversion to the unexposed analysis container. The web Quadlet is
published only on `127.0.0.1:8101`. Caddy is the sole origin, and cloudflared
reaches a separate loopback-only Caddy listener for
`stencil-cnc.zandaulion.com`.

## First installation

1. Run `./deploy.sh` once. It creates
   `~/.config/stencil-cnc/stencil-cnc.env` with mode 0600 and stops.
2. Generate an admin secret with `openssl rand -hex 32`, put it in that file as
   `ADMIN_TOKEN`, then copy the same value to a root-owned Caddy environment
   file as `STENCIL_CNC_ADMIN_TOKEN`. Do not put either secret in this repo.
3. Install `deploy/Caddyfile.snippet` into the current Caddy configuration.
   The public block uses port 8017 by default; choose a free, SELinux-labelled
   HTTP port if 8017 is already allocated and set `STENCIL_CNC_CADDY_PORT` for
   Caddy.
4. Add a Cloudflare Tunnel ingress mapping for
   `stencil-cnc.zandaulion.com` to `http://127.0.0.1:8017` (or the selected
   Caddy port). The tunnel is outbound; do not publish 8101 in the firewall.
5. Validate and reload Caddy, then run `./deploy.sh` again. It runs the test
   suite, builds the image, installs the user Quadlet, restarts it, and waits
   for `/api/health`.

If the user service must survive logout, enable lingering for the deployment
account once (`loginctl enable-linger <deployment-user>`).

## Project-share storage

Private project links store encrypted bundle files in the web container's
existing `/data` volume. Set `SHARE_ENCRYPTION_KEY` to a stable value generated
with `openssl rand -hex 32` when sharing should survive an `ADMIN_TOKEN`
rotation. When it is blank or omitted, a domain-separated key is derived from
`ADMIN_TOKEN`; changing that token then makes earlier bundles unreadable.

`SHARE_MAX_BYTES` limits one complete package, while
`SHARE_OWNER_MAX_BYTES` and `SHARE_OWNER_MAX_ACTIVE` bound storage per sharing
device. Expired package files are removed during later share operations and
revoked packages are removed immediately. Include the named Podman volume in
normal encrypted backups if active project links must survive host loss.

## Invite console

The shared console needs this entry in `pwa-invite-console/apps.json`:

```json
{
  "id": "stencil-cnc",
  "name": "Stencil CNC",
  "api": "/stencil-cnc",
  "push": false,
  "message": "Salut! Îți trimit acces la Stencil CNC — transformă fotografii și desene în șabloane conectate, gata de verificat și exportat pentru CNC.\\n\\nDeschide linkul:\\n{link}\\n\\nCodul este valabil {days} zile și înregistrează un singur dispozitiv."
}
```

Redeploy the console after changing the JSON. Its page contains no credential.
The tailnet-only Caddy handle injects `X-Admin-Token`; the application compares
it in constant time with `ADMIN_TOKEN` and fails closed when the secret is not
configured.

On the public listener, `/api/admin` and all children are answered with 404
before proxying. Both `X-Admin` and `X-Admin-Token` are stripped from every
other public request. These Caddy controls are defence in depth: the server
also returns 404 unless the secret matches.

## Device gate and PWA updates

Redeeming an invite sets a host-only `__Host-` cookie with `Secure`,
`HttpOnly`, `SameSite=Lax`, and a 400-day browser-compatible lifetime. The
token is random, stored only as a SHA-256 hash, and never returned in JSON or
made available to client JavaScript. Revoking a device invalidates it on its
next online request.

The public shell, CSS, manifest, icons, `app.js`, and pwa-kit bootstrap remain
reachable so a new device can display the invite gate. The server requires a
valid cookie for `/editor.js`, `/storage.js`, everything under `/core/`, and
everything under `/workers/`. Put every future operational module or WASM
worker under one of those protected prefixes.

There is an unavoidable offline boundary: once an authorised browser has
cached the editor and local projects, a server cannot erase or revoke those
bytes while that browser is disconnected. The network-first pwa-kit worker
enforces revocation on the next successful online check. This limitation is
shown in the bootstrap's offline behaviour and must not be described as remote
wipe.

The server derives `__BUILD_VERSION__` from the entire `web/` directory at
startup. A changed image therefore produces a changed worker without a manual
version bump. `sw.js` and the shell are served with revalidation/no-store
headers, `/bust` remains outside the worker, and protected modules are marked
private while still being explicitly cacheable by the service worker for
authorised offline use.
