import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type Config } from '@p80/core';
import { buildServer, type ApiServer } from '../src/server.js';

export interface TestApi {
  server: ApiServer;
  config: Config;
  dispose(): Promise<void>;
}

/** A real server over a real temp database — `app.inject` exercises the whole
 *  request pipeline, including CORS and the error handler. */
export async function createTestApi(
  env: Partial<Record<string, string>> = {},
): Promise<TestApi> {
  const dir = mkdtempSync(join(tmpdir(), 'p80-api-'));
  const config = loadConfig({
    P80_DB_PATH: join(dir, 'p80.db'),
    P80_LOG_LEVEL: 'silent',
    ...env,
  });
  const server = await buildServer(config);

  return {
    server,
    config,
    async dispose() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
