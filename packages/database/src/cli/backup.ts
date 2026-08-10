import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createLogger, loadConfig } from '@p80/core';
import { backupDatabase, pruneBackups } from '../backup.js';
import { openDatabase } from '../client.js';

const config = loadConfig();
const logger = createLogger('backup', config.P80_LOG_LEVEL);
const handle = openDatabase(config.P80_DB_PATH);

try {
  const path = backupDatabase(handle.sqlite);
  logger.info({ path, bytes: statSync(path).size }, 'backup written');

  // Pruning lives here rather than in the timer unit so that one behaviour has one
  // definition and can be tested. Tagged backups — pre-migration and the like — are never
  // touched; see `pruneBackups`.
  const removed = pruneBackups(dirname(path));
  if (removed.length > 0) {
    logger.info({ removed: removed.length }, 'pruned routine backups past the window');
  }

  // Only the path on stdout: a caller pipes this straight into a restore.
  process.stdout.write(`${path}\n`);
} finally {
  handle.close();
}
