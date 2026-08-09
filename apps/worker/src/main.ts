import { createLogger, loadConfig } from '@p80/core';
import { migrate, openDatabase } from '@p80/database';
import { createWorker } from './loop.js';
import { createRegistry } from './registry.js';

const config = loadConfig();
const logger = createLogger('worker', config.P80_LOG_LEVEL);
const handle = openDatabase(config.P80_DB_PATH);

// The worker may win the race to start. Migrating here too means neither process has to
// wait for the other, and `migrate` is a no-op when the API got there first.
migrate(handle.sqlite, { logger });

const worker = createWorker({
  handle,
  registry: createRegistry({ config }),
  logger,
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    logger.info('shutdown requested; finishing the current job');
    worker.stop();
  });
}

await worker.run();
handle.close();
