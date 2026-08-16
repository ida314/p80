import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase, pruneBackups } from '../src/backup.js';
import { openDatabase } from '../src/client.js';
import { setSetting } from '../src/repositories/settings.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * Stage 1 exit criterion 9 (contract-derived) — `db:backup` produces a *restorable*
 * file, which is a stronger claim than "a file appeared".
 *
 * The database is left open and in WAL mode while the backup runs, because that is the
 * state it will actually be in: the API holds it, the worker writes to it, and the user
 * runs `pnpm db:backup`. A plain file copy would pass a weaker version of this test and
 * still lose the most recent writes.
 */
let temp: TempDatabase;
afterEach(() => temp?.dispose());

describe('database backup', () => {
  it('writes a snapshot that reopens with its data intact', () => {
    temp = createTempDatabase();
    setSetting(temp, 'theme', { mode: 'dark' });

    const path = backupDatabase(temp.sqlite);
    expect(existsSync(path)).toBe(true);

    const restored = openDatabase(path);
    try {
      const row = restored.sqlite
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get('theme') as { value_json: string } | undefined;
      expect(row).toBeDefined();
      expect(JSON.parse(row!.value_json)).toEqual({ mode: 'dark' });
    } finally {
      restored.close();
    }
  });

  it('captures writes that are still only in the WAL', () => {
    temp = createTempDatabase();
    expect(temp.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');

    // No checkpoint between the write and the backup — this is the case a file copy
    // gets wrong.
    setSetting(temp, 'unflushed', { written: true });

    const restored = openDatabase(backupDatabase(temp.sqlite));
    try {
      const row = restored.sqlite
        .prepare('SELECT value_json FROM settings WHERE key = ?')
        .get('unflushed');
      expect(row).toBeDefined();
    } finally {
      restored.close();
    }
  });

  it('refuses to back up an in-memory database rather than writing an empty file', () => {
    const memory = openDatabase(':memory:');
    try {
      expect(() => backupDatabase(memory.sqlite)).toThrow(/in-memory/);
    } finally {
      memory.close();
    }
  });

  it('tags a snapshot with its reason, and retention then spares it', () => {
    temp = createTempDatabase();
    const path = backupDatabase(temp.sqlite, { reason: 'predeploy' });

    expect(basename(path)).toMatch(/\.predeploy\./);
    // The claim that matters is not the filename but what retention does with it.
    expect(pruneBackups(dirname(path), { keepDays: 0, keepMinimum: 0 })).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });

  // A reason reaches the filename, and `pruneBackups` reads the filename to decide what is
  // routine. A dot would put a tagged snapshot back in the prunable set, which is discovered
  // by finding it missing.
  it.each(['pre.deploy', 'pre/deploy', '../escape', '', 'has space'])(
    'refuses the reason %o rather than sanitising it',
    (reason) => {
      temp = createTempDatabase();
      expect(() => backupDatabase(temp.sqlite, { reason })).toThrow(/backup reason/i);
    },
  );
});

/**
 * A daily timer needs a retention policy or it fills a disk. Deleting a backup is the only
 * destructive thing in this file, so the tests are about what it *refuses* to delete.
 */
describe('backup retention', () => {
  const DAY = 24 * 60 * 60 * 1000;
  let dir: string;

  const age = (name: string, days: number) => {
    const path = join(dir, name);
    writeFileSync(path, 'x');
    const seconds = (Date.now() - days * DAY) / 1000;
    utimesSync(path, seconds, seconds);
    return path;
  };

  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), 'p80-prune-'));
  };

  it('removes routine backups past the window', () => {
    setup();
    const old = age('p80.2020-01-01.db', 400);
    const recent = age('p80.2026-08-01.db', 1);
    for (let i = 0; i < 3; i += 1) age(`p80.filler-${i}.db`, 2);

    expect(pruneBackups(dir)).toEqual([old]);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });

  it('never removes a tagged backup, however old', () => {
    setup();
    // `pre-migration` backups exist because a migration is irreversible. Age is not a
    // reason to lose one.
    const tagged = age('p80.pre-migration.2019-01-01.db', 900);
    for (let i = 0; i < 5; i += 1) age(`p80.routine-${i}.db`, 900);

    const removed = pruneBackups(dir);
    expect(removed).not.toContain(tagged);
    expect(existsSync(tagged)).toBe(true);
  });

  it('keeps a floor of recent backups even when every one is past the window', () => {
    setup();
    for (let i = 0; i < 5; i += 1) age(`p80.old-${i}.db`, 100 + i);

    expect(pruneBackups(dir, { keepMinimum: 3 })).toHaveLength(2);
  });

  it('ignores anything that is not a backup', () => {
    setup();
    const stray = age('notes.txt', 900);
    // Distinct ages so "the oldest" is unambiguous rather than readdir order.
    age('p80.a.db', 903);
    age('p80.b.db', 902);
    age('p80.c.db', 901);
    age('p80.d.db', 900);

    expect(pruneBackups(dir)).toEqual([join(dir, 'p80.a.db')]);
    expect(existsSync(stray)).toBe(true);
  });

  it('is a no-op when nothing has ever been backed up', () => {
    setup();
    expect(pruneBackups(join(dir, 'never-created'))).toEqual([]);
  });
});
