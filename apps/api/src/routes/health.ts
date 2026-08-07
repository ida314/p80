import { z } from 'zod';
import type { Config } from '@p80/core';
import type { DatabaseHandle } from '@p80/database';
import type { App } from '../app.js';

const healthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  service: z.literal('api'),
  version: z.string(),
  database: z.object({
    reachable: z.boolean(),
    migrationsApplied: z.number(),
  }),
  /**
   * Reported, never checked at startup.
   *
   * Spec §5.2 requires P80 to work with no LLM configured, and under ADR 0005 "not
   * configured" mostly means "the vLLM server is not running" — which during Stages 1–6
   * is the ordinary case. Health says what is configured; it does not dial out, and an
   * absent model never makes the API unhealthy.
   */
  inference: z.object({
    mode: z.literal('local'),
    configured: z.boolean(),
  }),
});

export async function registerHealthRoutes(
  app: App,
  deps: { config: Config; handle: DatabaseHandle },
): Promise<void> {
  app.get(
    '/api/health',
    { schema: { response: { 200: healthResponse } } },
    async () => {
      let reachable = true;
      let migrationsApplied = 0;
      try {
        const row = deps.handle.sqlite
          .prepare('SELECT COUNT(*) AS n FROM _migrations')
          .get() as { n: number };
        migrationsApplied = row.n;
      } catch {
        reachable = false;
      }

      return {
        status: reachable ? ('ok' as const) : ('degraded' as const),
        service: 'api' as const,
        version: '0.0.0',
        database: { reachable, migrationsApplied },
        inference: {
          mode: 'local' as const,
          configured: deps.config.P80_VLLM_MODEL_ID !== '',
        },
      };
    },
  );
}
