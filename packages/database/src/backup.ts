import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { ERROR_CODES, P80Error } from '@p80/core';
import type { SqliteDatabase } from './client.js';

export interface BackupOptions {
  /** Defaults to `<db dir>/backups`. */
  dir?: string;
  /** Appears in the filename, e.g. `pre-migration`. Letters, digits, `-`, and `_` only. */
  reason?: string;
}

/**
 * A reason becomes a filename segment, and `pruneBackups` decides what is routine by
 * counting segments. A reason containing a dot would produce `p80.pre.deploy.<stamp>.db`,
 * which is four segments and therefore not routine — but a dot in the *last* position, or
 * an empty reason, can push a file back into the routine set and get it deleted. The
 * failure mode is finding that the snapshot taken before an irreversible act is gone, at
 * the moment it is needed, so this refuses rather than sanitising.
 */
const REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

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

  if (options.reason !== undefined && !REASON_PATTERN.test(options.reason)) {
    throw new P80Error(
      ERROR_CODES.BAD_REQUEST,
      `Invalid backup reason ${JSON.stringify(options.reason)}. ` +
        'Letters, digits, hyphens, and underscores only — a dot or a separator would ' +
        'change how retention reads the filename.',
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

export interface PruneOptions {
  /** Backups older than this survive only if the minimum has not been met. */
  keepDays?: number;
  /** Newest-first floor, whatever the age. */
  keepMinimum?: number;
}

/**
 * Deletes old *routine* backups, and only those.
 *
 * A daily timer that never prunes fills a disk eventually, but deleting a backup is the
 * one operation here that destroys something, so it is narrow on purpose:
 *
 * - **Only untagged snapshots.** `backupDatabase` writes a `reason` into the filename for
 *   backups tied to an event — `p80.pre-migration.<stamp>.db`. Those are safety artifacts
 *   for a specific irreversible act and are kept forever. Only `p80.<stamp>.db` is
 *   routine, and only routine files are considered.
 * - **A floor as well as a window.** A machine that was off for two months would otherwise
 *   come back, run one backup, and delete every older one on the same schedule. `keepMinimum`
 *   means there is always something to restore from.
 *
 * Returns what it removed so the caller can say so rather than deleting quietly.
 */
export function pruneBackups(dir: string, options: PruneOptions = {}): string[] {
  const keepDays = options.keepDays ?? 30;
  const keepMinimum = options.keepMinimum ?? 3;

  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // Nothing has ever been backed up. Not a failure.
  }

  // `<name>.<stamp>.db` — exactly two dots' worth of structure. A `reason` segment adds a
  // third, which is what excludes tagged backups without having to know their names.
  const routine = entries
    .filter((name) => /^[^.]+\.[^.]+\.db$/.test(name))
    .map((name) => join(dir, name))
    .flatMap((path) => {
      try {
        return [{ path, mtime: statSync(path).mtimeMs }];
      } catch {
        return []; // Vanished between readdir and stat. Someone else's problem.
      }
    })
    .sort((a, b) => b.mtime - a.mtime);

  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  const removed: string[] = [];

  for (const [index, entry] of routine.entries()) {
    if (index < keepMinimum || entry.mtime >= cutoff) continue;
    rmSync(entry.path, { force: true });
    removed.push(entry.path);
  }

  return removed;
}
