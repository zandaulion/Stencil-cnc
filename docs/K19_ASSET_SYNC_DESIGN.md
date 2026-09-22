# K19 asset-based project synchronization

Status: implementation in progress, migration-compatible.

## Storage contract

Kerfloom separates frequently changing editable state from large immutable
binary assets:

- `legacy-bundle-v1` remains readable and writable for rollback compatibility.
- `asset-manifest-v1` stores the project, recovery points, and references to
  immutable source/export assets.
- `GET /api/projects/:id/state` returns the exact stored state object.
- `GET /api/projects/:id/bundle` always returns a complete portable version 1
  bundle. For a manifest-backed project, the server hydrates its asset
  references. Older clients and project sharing therefore continue to work.

An ordinary project edit uploads a small new manifest after its referenced
assets have been accepted once. It does not upload the source photograph or
unchanged exports again.

## Authorization and privacy

Assets receive random opaque UUIDs. Every database lookup includes the
authenticated workspace ID. A valid asset ID from another workspace and an
unknown ID both return the same `404 asset_not_found` response.

SHA-256 is used for integrity and deduplication only inside one workspace. A
digest is never an asset URL or an authorization credential, so guessing a
hash cannot reveal whether another workspace stores those bytes.

Assets and manifests are encrypted independently at rest with domain-separated
keys derived from the configured project-encryption secret. Key IDs are stored
with each encrypted object to retain the existing staged key-rotation model.

## Durability and migration

Legacy project files are never rewritten merely because this feature is
enabled. A project moves to the manifest format only after all referenced
assets have been durably uploaded. The manifest revision then becomes the
SQLite committed pointer through the existing write-file/fsync/transaction
protocol.

Deleting or replacing a manifest removes its reference rows, not its asset
bytes. Unreferenced assets use a conservative seven-day grace period before
cleanup. This protects interrupted uploads, rollback, candidates, shares, and
release recovery. Cleanup always rechecks references in the delete statement.

Workspace quota accounts for both live project-state files and unique asset
bytes. Identical bytes are deduplicated only within the same workspace.

## Client rollout

The browser rollout is intentionally staged:

1. Upload immutable source/export blobs and retain their returned opaque IDs.
2. Queue an `asset-manifest-v1` snapshot containing those references.
3. Fetch project metadata and thumbnails first.
4. Fetch editable state for the active/opened project; fetch source and export
   bytes on demand.
5. Provide an explicit “Available offline” action that pins every referenced
   asset in IndexedDB.

Until all five steps are deployed, the compatibility bundle route is the safe
fallback and no existing revision is discarded by migration.

