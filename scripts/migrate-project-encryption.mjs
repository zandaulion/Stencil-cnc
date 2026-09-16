import path from 'node:path';

import { openDatabase } from '../server/db.js';
import { resolveProjectEncryption } from '../server/project-keys.js';
import { ProjectService } from '../server/projects.js';

const dataDirectory = process.env.DATA_DIR || path.join(process.cwd(), 'data');
const database = openDatabase(path.join(dataDirectory, 'stencil-cnc.db'));

try {
  const encryption = resolveProjectEncryption();
  const service = new ProjectService(database, {
    directory: path.join(dataDirectory, 'projects'),
    ...encryption,
  });
  const result = service.migrateEncryption();
  // Key IDs and counts are operational metadata. Secret material is never
  // written to stdout or accepted as a command-line argument.
  console.log(JSON.stringify(result));
  if (result.failed > 0) process.exitCode = 1;
} finally {
  database.close();
}
