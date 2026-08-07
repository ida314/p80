import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

/**
 * Finds the repository root by walking up for `pnpm-workspace.yaml`.
 *
 * This exists because P80's processes do not share a working directory. `pnpm --filter
 * @p80/api dev` runs with `cwd` set to `apps/api`, and the worker's to `apps/worker`, so
 * a relative `P80_DB_PATH` of `./data/p80.db` resolves to a *different file per process*.
 * The symptom is not an error: every service starts, migrates, and reports healthy, and
 * the API simply cannot see anything the worker wrote.
 */
export function findRepoRoot(startDir: string = process.cwd()): string {
  let dir = resolve(startDir);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    // Reached the filesystem root without finding a workspace — fall back to the
    // starting directory rather than throwing, so a packaged or vendored copy still runs.
    if (parent === dir) return resolve(startDir);
    dir = parent;
  }
}

/** Resolves a possibly-relative path against the repository root, not `cwd`. */
export function resolveFromRepoRoot(path: string, startDir?: string): string {
  if (isAbsolute(path) || path === ':memory:') return path;
  return resolve(findRepoRoot(startDir), path);
}
