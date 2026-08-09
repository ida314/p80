import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { findRepoRoot, resolveFromRepoRoot } from '../src/paths.js';

/**
 * Regression guard for a bug that produced no error at all.
 *
 * `pnpm --filter @p80/api dev` runs with `cwd = apps/api` and the worker's with
 * `cwd = apps/worker`, so the default relative `P80_DB_PATH` of `./data/p80.db` gave
 * each process its own database. Every service started, migrated, and reported healthy;
 * the API just could not see anything the worker wrote. Anchoring to the repository root
 * is what makes them one system.
 */
describe('path resolution', () => {
  it('resolves the database path identically from any package directory', () => {
    const fromRoot = loadConfig({ P80_MEDIA_ROOT: '/media/library' }).P80_DB_PATH;
    const fromApi = resolveFromRepoRoot('./data/p80.db', join(process.cwd(), 'apps/api'));
    const fromWorker = resolveFromRepoRoot(
      './data/p80.db',
      join(process.cwd(), 'apps/worker'),
    );

    expect(isAbsolute(fromRoot)).toBe(true);
    expect(fromApi).toBe(fromWorker);
    expect(fromRoot).toBe(fromApi);
  });

  it('leaves an absolute path alone', () => {
    const config = loadConfig({ P80_DB_PATH: '/var/lib/p80/custom.db', P80_MEDIA_ROOT: '/media/library' });
    expect(config.P80_DB_PATH).toBe('/var/lib/p80/custom.db');
  });

  it('leaves :memory: alone', () => {
    expect(resolveFromRepoRoot(':memory:')).toBe(':memory:');
  });

  it('falls back to the starting directory outside a workspace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'p80-noroot-'));
    try {
      // No pnpm-workspace.yaml above a temp dir, so the walk reaches / and gives up.
      // Falling back beats throwing: a vendored or packaged copy still runs.
      expect(findRepoRoot(dir)).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
