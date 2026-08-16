import { statSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCliLogger, loadConfig } from '@p80/core';
import { backupDatabase, pruneBackups } from '../backup.js';
import { openDatabase } from '../client.js';

// `--reason <slug>` tags the snapshot, and a tagged snapshot is never pruned. That is the
// whole point of the flag: `scripts/deploy.sh` takes one before restarting the target,
// because the restart runs the migrate unit and a migration cannot be undone. A routine
// snapshot would expire on the ordinary 30-day window.
function readReason(argv: string[]): string | undefined {
  const index = argv.indexOf('--reason');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error('--reason needs a value, e.g. --reason predeploy');
  }
  return value;
}

const reason = readReason(process.argv.slice(2));

const config = loadConfig();
// Logs to stderr: stdout is this script's data channel — the last line is a path a caller
// pipes into a restore, and `scripts/deploy.sh` now captures it. Sharing fd 1 with pino,
// which buffers until exit, is what made `scripts/smoke.sh` flaky against `dev:noop`; the
// same collision was latent here and only lacked a consumer. See `createCliLogger`.
const logger = createCliLogger('backup', config.P80_LOG_LEVEL);
const handle = openDatabase(config.P80_DB_PATH);

try {
  const path = backupDatabase(handle.sqlite, reason === undefined ? {} : { reason });
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
