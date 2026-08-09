import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveFromRepoRoot } from '@p80/core';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * Regression test for the third silent Stage 1 bug (see ADR 0012's siblings).
 *
 * `scripts/smoke.sh` reads the new job's id with `pnpm dev:noop | tail -1`. The script
 * originally logged through the shared `createLogger`, which writes to **stdout** and
 * buffers until process exit — so the pino line and the `process.stdout.write` of the id
 * raced. Roughly two runs in five, `tail -1` returned the JSON log line, the smoke check
 * looked up a job id of `{"level":30,...`, and the API answered 404. The failure read as
 * "the worker never claimed the job", which is not what was wrong.
 *
 * The contract this pins: **stdout carries data, stderr carries logs.** Any CLI whose
 * output is parsed has to hold it, so the assertion is on the shape of the two streams
 * rather than on the logger's internals.
 */
const CLI = resolveFromRepoRoot('packages/database/src/cli/enqueue-noop.ts');
const TSX = resolveFromRepoRoot('node_modules/.bin/tsx');
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

let db: TempDatabase | undefined;

afterEach(() => {
  db?.dispose();
  db = undefined;
});

function runCli(): { stdout: string; stderr: string } {
  const temp = createTempDatabase();
  db = temp;

  const chunks: { stdout: string; stderr: string } = { stdout: '', stderr: '' };
  chunks.stdout = execFileSync(TSX, [CLI], {
    encoding: 'utf8',
    env: {
          ...process.env,
          P80_DB_PATH: temp.dir + '/p80.db',
          P80_MEDIA_ROOT: temp.dir + '/media',
        },
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: fileURLToPath(new URL('..', import.meta.url)),
  });
  return chunks;
}

describe('dev:noop CLI streams', () => {
  it('writes exactly the job id to stdout, and nothing else', () => {
    // Ten runs because the bug was a race: a single green run proved nothing before, and
    // the old code passed here about three times in five.
    for (let i = 0; i < 10; i += 1) {
      const { stdout } = runCli();
      const lines = stdout.trim().split('\n');

      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(ULID);
      expect(stdout).not.toContain('{');
      db?.dispose();
      db = undefined;
    }
  });

  it('still emits the log line, on stderr', () => {
    const temp = createTempDatabase();
    db = temp;

    const stderr = execFileSync(
      'sh',
      ['-c', `"${TSX}" "${CLI}" 2>&1 >/dev/null`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          P80_DB_PATH: temp.dir + '/p80.db',
          P80_MEDIA_ROOT: temp.dir + '/media',
        },
      },
    );

    // The log is not merely suppressed — moving it to stderr must not lose it.
    expect(stderr).toContain('"msg":"enqueued NOOP"');
    expect(stderr).toContain('"jobId":');
  });
});
