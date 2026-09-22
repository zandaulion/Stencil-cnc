# Kerfloom backup and isolated restore

Kerfloom's canonical state is the complete `stencil-cnc-data` volume plus the
environment secrets that can decrypt it. A database-only or files-only copy is
not a usable backup. Never print encryption keys into a log, shell history, or
support ticket.

## Current evidence and objective

Checked on 2026-09-16: the repository contains no backup automation, and no
Kerfloom backup appeared in the deployment user's or host's systemd timers.
The active volume is `stencil-cnc-data`. External provider snapshots or other
out-of-band backups remain unverified. Therefore the measured recovery point
is currently **unknown/unbounded**, and the operational recovery time has not
yet been established.

The proposed service objective is **RPO <= 1 hour** and **RTO <= 4 hours**:
hourly encrypted off-host copies, daily retention for 30 days, and a quarterly
isolated restore drill. This target is not met until an off-host destination,
retention policy, failure alert, and owner are chosen.

An isolated cold-snapshot drill completed successfully on 2026-09-16 against
the production volume and its active `admin-derived-v1` key source. The
verifier opened all 16 active projects and recovered 16 source images, 8
checkpoints, and 2 export artifacts. The disposable snapshot was deleted after
verification; this proves the restore procedure, not continuing backup
coverage.

## What must travel together

- the entire `stencil-cnc-data` volume, including the SQLite database, WAL/SHM
  files if present, `projects/`, `project-assets/`, and `shares/`;
- the protected deployment environment file containing the active admin,
  project, share, and retained previous project keys;
- the application image or Git commit used for the snapshot.

Protect the environment file separately from the volume archive. Possession of
only the encrypted volume must not imply possession of its decryption keys.

## Create a consistent cold snapshot

Use a backup directory on encrypted storage. The stop/start window makes the
SQLite database and files one point in time.

```sh
systemctl --user stop stencil-cnc.service
podman volume export stencil-cnc-data --output /secure/off-host/kerfloom-data-YYYYMMDDTHHMMSSZ.tar
systemctl --user start stencil-cnc.service
curl -fsS http://127.0.0.1:8101/api/health
```

Copy `~/.config/stencil-cnc/stencil-cnc.env` to the separately protected key
backup using the chosen secret-management process. Record the Git commit and
archive checksum in the backup catalogue. If any command fails after stopping
the service, start it again before investigating.

## Rehearse an isolated restore

Never import a drill over the live volume. Use a uniquely named disposable
volume and the protected environment file recovered through the secret store.

```sh
podman volume create kerfloom-restore-drill-YYYYMMDD
podman volume import kerfloom-restore-drill-YYYYMMDD /secure/off-host/kerfloom-data-YYYYMMDDTHHMMSSZ.tar
podman run --rm \
  --env-file /secure/restore-drill/stencil-cnc.env \
  --env KERFLOOM_RESTORE_DRILL=1 \
  --volume kerfloom-restore-drill-YYYYMMDD:/restore:Z \
  localhost/stencil-cnc:latest \
  node scripts/verify-project-restore.mjs /restore
```

The verifier refuses the configured live data directory. Success means every
non-deleted project can be authenticated, decrypted, integrity-checked, and
parsed; its summary reports recovered source images, checkpoints, and export
artifacts without printing project names or secrets. Retain the drill log and
archive checksum as evidence, then remove only the explicitly named disposable
volume.

## Staged project-key rotation

1. Keep the existing secret and its key ID in
   `PROJECT_PREVIOUS_ENCRYPTION_KEYS=old-id=old-secret`.
2. Set a new `PROJECT_ENCRYPTION_KEY` and a never-reused
   `PROJECT_ENCRYPTION_KEY_ID`.
3. Restart and confirm existing projects open. Run
   `podman exec stencil-cnc node scripts/migrate-project-encryption.mjs`.
4. Take a new backup and complete the isolated restore drill with the same key
   ring. Do not remove the previous key while any migration failure remains.
5. After migration and restore evidence are retained, remove the old entry,
   restart, and verify again.

Files without a key ID from older releases remain readable while their secret
is retained. Migration rewrites project state and immutable asset files and
atomically changes each SQLite pointer; it never accepts a secret on the
command line or prints one. Do not retire a previous key until both the
`projects` and `projectAssets` failure counts are zero and any seven-day legacy
migration-backup window has expired.
