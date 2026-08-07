import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../src/client.js';
import { migrate } from '../src/migrate.js';

export interface TempDatabase extends DatabaseHandle {
  dir: string;
  dispose(): void;
}

/**
 * A fresh on-disk database per test file, with migrations applied.
 *
 * On-disk rather than `:memory:` on purpose — WAL mode, `VACUUM INTO`, and the
 * cross-process claim behaviour are all properties of a real file, and testing them
 * against an in-memory database would verify something P80 never runs.
 */
export function createTempDatabase(options: { migrate?: boolean } = {}): TempDatabase {
  const dir = mkdtempSync(join(tmpdir(), 'p80-test-'));
  const handle = openDatabase(join(dir, 'p80.db'));
  if (options.migrate !== false) migrate(handle.sqlite);

  return Object.assign(handle, {
    dir,
    dispose() {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  });
}
