import { createLogger, loadConfig } from '@p80/core';
import { openDatabase } from '../client.js';
import { migrate } from '../migrate.js';

const config = loadConfig();
const logger = createLogger('migrate', config.P80_LOG_LEVEL);
const handle = openDatabase(config.P80_DB_PATH);

try {
  const result = migrate(handle.sqlite, { logger });
  if (result.applied.length === 0) {
    logger.info(
      { alreadyApplied: result.alreadyApplied.length },
      'database is up to date',
    );
  } else {
    logger.info({ applied: result.applied }, 'migrations applied');
  }
} finally {
  handle.close();
}
