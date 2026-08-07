import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES, P80Error, type Logger } from '@p80/core';
import type { SqliteDatabase } from './client.js';
import { backupDatabase } from './backup.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
  backupPath: string | null;
}

/**
 * Migrations are explicit, numbered, forward-only files, checked into source control
 * before they run (`02-database.md` §3). Nothing here generates SQL — the files are the
 * authority, and this only decides which have not run yet.
 */
export function loadMigrations(dir = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return {
        name,
        sql,
        checksum: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

function ensureLedger(sqlite: SqliteDatabase): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

/**
 * Applies pending migrations. Runs automatically on API start (Stage 1 exit criterion 2)
 * and is a no-op when everything is already applied.
 *
 * Each file runs inside a transaction, so a half-applied migration is not a state the
 * database can be left in.
 *
 * A checksum mismatch on an already-applied file is a hard error rather than a warning:
 * an edited migration means the database in front of you and the migration history in
 * source control disagree about what the schema is, and guessing which is right is
 * exactly the failure §3 rule 1 exists to prevent.
 */
export function migrate(
  sqlite: SqliteDatabase,
  options: { dir?: string; logger?: Logger } = {},
): MigrateResult {
  const migrations = loadMigrations(options.dir ?? MIGRATIONS_DIR);
  ensureLedger(sqlite);

  const insert = sqlite.prepare(
    'INSERT INTO _migrations (name, checksum, applied_at) VALUES (?, ?, ?)',
  );

  /**
   * The whole read-decide-apply sequence runs inside one `BEGIN IMMEDIATE`.
   *
   * The API and the worker both migrate on start, and both start at once under
   * `pnpm dev`. Reading the ledger outside the write lock lets both see zero applied
   * migrations, and the loser then fails on `table already exists`. Taking the write
   * lock first means the loser blocks (`busy_timeout`), re-reads the ledger *after* the
   * winner commits, and correctly finds nothing to do.
   */
  const run = sqlite.transaction((): MigrateResult => {
    const rows = sqlite
      .prepare('SELECT name, checksum FROM _migrations')
      .all() as Array<{ name: string; checksum: string }>;
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    for (const m of migrations) {
      const seen = applied.get(m.name);
      if (seen !== undefined && seen !== m.checksum) {
        throw new P80Error(
          ERROR_CODES.MIGRATION_FAILED,
          `Migration ${m.name} has changed since it was applied. Migrations are ` +
            `forward-only — add a new file instead of editing an applied one.`,
          { details: { migration: m.name } },
        );
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.name));
    if (pending.length === 0) {
      return {
        applied: [],
        alreadyApplied: migrations.map((m) => m.name),
        backupPath: null,
      };
    }

    // §3 rule 3: a migration that rewrites existing data takes a backup first. We cannot
    // tell from the SQL alone whether this one does, so back up whenever there is data
    // to lose — cheap insurance, and it makes the rule mechanical rather than remembered.
    //
    // `VACUUM INTO` cannot run inside a transaction, so this happens before the lock is
    // taken, in `migrate` below.
    for (const m of pending) {
      sqlite.exec(m.sql);
      insert.run(m.name, m.checksum, Date.now());
      options.logger?.info({ migration: m.name }, 'applied migration');
    }

    return {
      applied: pending.map((m) => m.name),
      alreadyApplied: [...applied.keys()],
      backupPath: null,
    };
  });

  const backupPath = backupIfNeeded(sqlite, migrations, options.logger);

  try {
    return { ...run.immediate(), backupPath };
  } catch (cause) {
    if (cause instanceof P80Error) throw cause;
    throw new P80Error(
      ERROR_CODES.MIGRATION_FAILED,
      'A migration failed and was rolled back.',
      { cause },
    );
  }
}

/**
 * Takes a pre-migration snapshot when there is existing data and work to do.
 *
 * Read outside the transaction on purpose: `VACUUM INTO` cannot run inside one. The
 * check is therefore advisory — if two processes race, one may take a backup it did not
 * strictly need, which costs a file and protects the same data.
 */
function backupIfNeeded(
  sqlite: SqliteDatabase,
  migrations: MigrationFile[],
  logger?: Logger,
): string | null {
  if (sqlite.name === ':memory:' || sqlite.name === '') return null;

  const rows = sqlite.prepare('SELECT name FROM _migrations').all() as Array<{
    name: string;
  }>;
  if (rows.length === 0) return null;

  const applied = new Set(rows.map((r) => r.name));
  if (migrations.every((m) => applied.has(m.name))) return null;

  const backupPath = backupDatabase(sqlite, { reason: 'pre-migration' });
  logger?.info({ backupPath }, 'took a pre-migration backup');
  return backupPath;
}
