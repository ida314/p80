import { mkdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ERROR_CODES, P80Error } from '@p80/core';
import type { SqliteDatabase } from './client.js';

export interface BackupOptions {
  /** Defaults to `<db dir>/backups`. */
  dir?: string;
  /** Appears in the filename, e.g. `pre-migration`. */
  reason?: string;
}

/**
 * Snapshots the database (Stage 1 step 14, `pnpm db:backup`).
 *
 * Uses `VACUUM INTO`, not a file copy. In WAL mode the `.db` file alone is an incomplete
 * picture — recent commits live in the `-wal` sidecar — so copying it while the API holds
 * it open yields a file that is missing writes or is outright torn. `VACUUM INTO` asks
 * SQLite for a consistent, fully checkpointed copy without blocking readers.
 */
export function backupDatabase(
  sqlite: SqliteDatabase,
  options: BackupOptions = {},
): string {
  const source = sqlite.name;
  if (source === ':memory:' || source === '') {
    throw new P80Error(
      ERROR_CODES.BAD_REQUEST,
      'Cannot back up an in-memory database.',
    );
  }

  const dir = options.dir ?? join(dirname(source), 'backups');
  mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = options.reason ? `.${options.reason}` : '';
  const target = join(dir, `${basename(source, '.db')}${suffix}.${stamp}.db`);

  sqlite.prepare('VACUUM INTO ?').run(target);
  return target;
}
