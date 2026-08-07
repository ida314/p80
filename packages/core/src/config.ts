import { z } from 'zod';
import { resolveFromRepoRoot } from './paths.js';

/**
 * Local endpoint configuration. **There are no secrets here.**
 *
 * ADR 0005 moved all inference local, so P80 holds no API keys (spec §32.3,
 * `CLAUDE.md` rule 14). `CONFIG_KEYS` below is asserted against this schema in
 * `test/config.test.ts` — adding a credential-shaped key fails that test, which is the
 * point. The rule is mechanical rather than remembered.
 */
const booleanish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const port = z.coerce.number().int().min(1).max(65535);

export const configSchema = z.object({
  P80_BIND_HOST: z.string().min(1).default('127.0.0.1'),
  P80_ALLOW_LAN: booleanish.default('false'),
  P80_API_PORT: port.default(5180),
  P80_WEB_PORT: port.default(5173),
  P80_NLP_PORT: port.default(5181),
  P80_DB_PATH: z.string().min(1).default('./data/p80.db'),
  P80_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  P80_VLLM_BASE_URL: z.string().url().default('http://127.0.0.1:8000/v1'),
  P80_VLLM_MODEL_ID: z.string().default(''),
  P80_NLP_BASE_URL: z.string().url().default('http://127.0.0.1:5181'),
});

/**
 * The complete, closed set of environment keys P80 reads. Any key not listed here is
 * ignored, and the guard test asserts this list matches the schema exactly.
 */
export const CONFIG_KEYS = Object.keys(configSchema.shape).sort() as ReadonlyArray<
  keyof typeof configSchema.shape
>;

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid P80 configuration — ${detail}`);
  }

  return {
    ...parsed.data,
    // Anchored to the repository root, never to `cwd`. The API and worker are started by
    // `pnpm --filter`, which runs each in its own package directory, so a relative path
    // would silently give them one database each — see `resolveFromRepoRoot`.
    P80_DB_PATH: resolveFromRepoRoot(parsed.data.P80_DB_PATH),
  };
}

/**
 * Loopback unless the user has explicitly opted into LAN exposure (spec §32.5).
 * Callers are expected to log a warning when this returns true.
 */
export function isLanExposed(config: Config): boolean {
  return config.P80_ALLOW_LAN || config.P80_BIND_HOST !== '127.0.0.1';
}

/** The only origins the API accepts by default (spec §32.5, `03-api.md` §10). */
export function allowedOrigins(config: Config): string[] {
  return [
    `http://127.0.0.1:${config.P80_WEB_PORT}`,
    `http://localhost:${config.P80_WEB_PORT}`,
  ];
}
