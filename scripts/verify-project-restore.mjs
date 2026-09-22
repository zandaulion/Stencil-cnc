import fs from 'node:fs';
import path from 'node:path';

import { openDatabase } from '../server/db.js';
import { ProjectAssetService } from '../server/project-assets.js';
import { resolveProjectEncryption } from '../server/project-keys.js';
import { ProjectService } from '../server/projects.js';
import { parseBundle } from '../server/shares.js';

const restoredDirectory = path.resolve(process.argv[2] || '');
const liveDirectory = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
if (process.env.KERFLOOM_RESTORE_DRILL !== '1' || !process.argv[2]) {
  throw new Error('Set KERFLOOM_RESTORE_DRILL=1 and pass the isolated restored data directory.');
}
if (restoredDirectory === liveDirectory) {
  throw new Error('Refusing to run the restore drill against the configured live data directory.');
}
const databaseFile = path.join(restoredDirectory, 'stencil-cnc.db');
const projectDirectory = path.join(restoredDirectory, 'projects');
const projectAssetDirectory = path.join(restoredDirectory, 'project-assets');
if (!fs.existsSync(databaseFile) || !fs.existsSync(projectDirectory)) {
  throw new Error('The isolated restore must contain stencil-cnc.db and projects/.');
}

const database = openDatabase(databaseFile);
try {
  const encryption = resolveProjectEncryption();
  const assets = new ProjectAssetService(database, {
    directory: projectAssetDirectory,
    ...encryption,
    recoverOnStart: false,
  });
  const service = new ProjectService(database, {
    directory: projectDirectory,
    ...encryption,
    assets,
    recoverOnStart: false,
  });
  const rows = database.prepare(`
    SELECT workspace_id, client_project_id FROM server_projects
    WHERE deleted_at IS NULL
  `).all();
  let sources = 0;
  let artifacts = 0;
  let checkpoints = 0;
  for (const row of rows) {
    const stored = service.bundle(row.workspace_id, row.client_project_id);
    const bundle = parseBundle(stored.buffer);
    if (bundle.source) sources += 1;
    artifacts += bundle.artifacts.length;
    checkpoints += bundle.checkpoints.length;
  }
  console.log(JSON.stringify({
    ok: true,
    projects: rows.length,
    sources,
    artifacts,
    checkpoints,
    keyId: service.keyId,
  }));
} finally {
  database.close();
}
