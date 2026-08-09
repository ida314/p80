import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '@p80/core';
import { buildServer, type ApiServer } from '../src/server.js';

export interface TestApi {
  server: ApiServer;
  config: Config;
  /** Create a fake media file under the test's media root and return its relative path.
   *  Bytes only — nothing here decodes, and no test needs a real container. */
  writeMedia(relativePath: string, contents?: string | Buffer): string;
  dispose(): Promise<void>;
}

/** A real server over a real temp database — `app.inject` exercises the whole
 *  request pipeline, including CORS and the error handler. */
export async function createTestApi(
  env: Partial<Record<string, string>> = {},
): Promise<TestApi> {
  const dir = mkdtempSync(join(tmpdir(), 'p80-api-'));
  const mediaRoot = join(dir, 'media');
  mkdirSync(mediaRoot, { recursive: true });

  const config = loadConfig({
    P80_DB_PATH: join(dir, 'p80.db'),
    // Uploaded transcripts are written to disk (spec §7.2), so a test that uploads one
    // must not leave it in the repository's own storage directory.
    P80_STORAGE_PATH: join(dir, 'storage'),
    // ADR 0015. Separate from the storage root on purpose, and asserted as separate by
    // `test/media-policy.test.ts` — collapsing the two is how a read-through reference
    // quietly becomes a stored copy.
    P80_MEDIA_ROOT: mediaRoot,
    P80_LOG_LEVEL: 'silent',
    ...env,
  });
  const server = await buildServer(config);

  return {
    server,
    config,
    writeMedia(relativePath, contents = 'not a real container, and no test decodes it') {
      const full = join(mediaRoot, relativePath);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, contents);
      return relativePath;
    },
    async dispose() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
