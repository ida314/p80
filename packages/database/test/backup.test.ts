import { existsSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { backupDatabase } from '../src/backup.js';
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
});
