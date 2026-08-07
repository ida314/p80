import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.js';

export type SqliteDatabase = Database.Database;
export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DatabaseHandle {
  /** The raw connection. Needed for pragmas, the atomic job claim, and `.backup()`. */
  readonly sqlite: SqliteDatabase;
  /** The typed query interface. */
  readonly db: Db;
  readonly path: string;
  close(): void;
}

/**
 * Opens the local SQLite database with the pragmas the contracts depend on.
 *
 * `foreign_keys = ON` is not a nicety. SQLite defaults it *off*, and every cascade rule
 * in `02-database.md` — including invariant 5, which keeps approved learning items alive
 * when their video is deleted — is expressed as a foreign key. Without this line the
 * schema's referential guarantees are decorative.
 */
export function openDatabase(dbPath: string): DatabaseHandle {
  const isMemory = dbPath === ':memory:';
  const resolved = isMemory ? dbPath : resolve(dbPath);

  if (!isMemory) mkdirSync(dirname(resolved), { recursive: true });

  const sqlite = new Database(resolved);

  if (!isMemory) {
    // WAL lets the API read while the worker writes. Without it the two processes
    // contend on a single writer lock and the worker stalls the UI.
    sqlite.pragma('journal_mode = WAL');
  }
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');

  const db = drizzle(sqlite, { schema });

  return {
    sqlite,
    db,
    path: resolved,
    close: () => sqlite.close(),
  };
}

export { schema };
