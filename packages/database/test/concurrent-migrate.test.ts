import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase, type DatabaseHandle } from '../src/client.js';
import { migrate } from '../src/migrate.js';

/**
 * The API and the worker both migrate on start, and under `pnpm dev` they start at the
 * same moment against the same file.
 *
 * Before the fix this was masked by a second bug — each process resolved a relative
 * `P80_DB_PATH` against its own `cwd` and got its own database, so the race never
 * happened and both logged "applied migration". With one shared file it is real:
 * reading the ledger outside the write lock lets both see zero applied migrations, and
 * the loser dies on `table already exists`.
 */
let dir: string;
let handles: DatabaseHandle[] = [];

afterEach(() => {
  for (const h of handles) h.close();
  handles = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function open(path: string): DatabaseHandle {
  const handle = openDatabase(path);
  handles.push(handle);
  return handle;
}

describe('concurrent migration', () => {
  it('lets exactly one of two processes apply the migration', () => {
    dir = mkdtempSync(join(tmpdir(), 'p80-race-'));
    const path = join(dir, 'p80.db');

    const api = open(path);
    const worker = open(path);

    const first = migrate(api.sqlite);
    const second = migrate(worker.sqlite);

    // One applied it; the other found the work already done and did not throw.
    const appliedCounts = [first.applied.length, second.applied.length].sort();
    expect(appliedCounts).toEqual([0, 1]);

    // And the result is one coherent schema, not a half-built one.
    const tables = worker.sqlite
      .prepare(
        `SELECT COUNT(*) AS n FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'`,
      )
      .get() as { n: number };
    expect(tables.n).toBe(36);

    const ledger = worker.sqlite
      .prepare('SELECT COUNT(*) AS n FROM _migrations')
      .get() as { n: number };
    expect(ledger.n).toBe(1);
  });

  it('shares one database between two connections', () => {
    dir = mkdtempSync(join(tmpdir(), 'p80-share-'));
    const path = join(dir, 'p80.db');

    const api = open(path);
    migrate(api.sqlite);
    const worker = open(path);

    api.sqlite
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('written-by-api', '{"ok":true}', Date.now());

    const seen = worker.sqlite
      .prepare('SELECT value_json FROM settings WHERE key = ?')
      .get('written-by-api');
    expect(seen).toBeDefined();
  });
});
