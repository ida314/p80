import { statSync } from 'node:fs';
import { createLogger, loadConfig } from '@p80/core';
import { backupDatabase } from '../backup.js';
import { openDatabase } from '../client.js';

const config = loadConfig();
const logger = createLogger('backup', config.P80_LOG_LEVEL);
const handle = openDatabase(config.P80_DB_PATH);

try {
  const path = backupDatabase(handle.sqlite);
  logger.info({ path, bytes: statSync(path).size }, 'backup written');
  process.stdout.write(`${path}\n`);
} finally {
  handle.close();
}
