/**
 * Enqueues a `NOOP` job so the worker has something to claim.
 *
 * A script rather than an endpoint, on purpose. `03-api.md` has no "enqueue an arbitrary
 * job" route and should not grow one — every real job is enqueued by the operation that
 * needs it, and a generic enqueue endpoint would be a way for a client to drive the
 * pipeline directly. This is a developer tool that writes to the same database the
 * worker polls.
 *
 *   pnpm dev:noop        (from the repo root)
 */
import { createCliLogger, loadConfig } from '@p80/core';
import { openDatabase } from '../client.js';
import { enqueueJob } from '../repositories/jobs.js';

const config = loadConfig();
// Logs to stderr: stdout is this script's data channel, and callers parse it. See the
// note on `createCliLogger` — sharing fd 1 made `scripts/smoke.sh` flaky.
const logger = createCliLogger('enqueue', config.P80_LOG_LEVEL);
const handle = openDatabase(config.P80_DB_PATH);

try {
  const job = enqueueJob(handle, 'NOOP', { entityType: 'smoke', entityId: 'manual' });
  logger.info({ jobId: job.id }, 'enqueued NOOP');
  process.stdout.write(`${job.id}\n`);
} finally {
  handle.close();
}
