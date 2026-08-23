import { readFileSync } from 'node:fs';
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
  /** Where uploaded transcript files are kept (spec §7.2). Same anchoring hazard as
   *  `P80_DB_PATH`: the API writes and the worker reads, and `pnpm --filter` runs each in
   *  its own directory. */
  P80_STORAGE_PATH: z.string().min(1).default('./data/storage'),
  /**
   * The only directory P80 will read media from (ADR 0015, `CLAUDE.md` rule 4).
   *
   * **No default, deliberately.** Every other path here can be wrong quietly and recover;
   * this one decides what the containment check contains. A default of `./data/media`
   * would silently make an empty directory the library, and the symptom — "my file isn't
   * there" — points at the file rather than at the root. An unset value is a startup
   * error naming the variable.
   */
  P80_MEDIA_ROOT: z.string().min(1),
  P80_LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),
  P80_VLLM_BASE_URL: z.string().url().default('http://127.0.0.1:8000/v1'),
  P80_VLLM_MODEL_ID: z.string().default(''),
  P80_NLP_BASE_URL: z.string().url().default('http://127.0.0.1:5181'),

  /**
   * Transcription options (ADR 0016), read here rather than only in the sidecar since
   * ADR 0019 §5.
   *
   * They used to live in `asr.py` alone, which made them editable only by restarting the
   * Python process with a different environment. P80 now sends them with each
   * `POST /transcribe`, so this schema is where their defaults are defined and
   * `settings.ts` is where they become writable. `asr.py` keeps the identical table as a
   * fallback for direct callers, pinned by a test on each side.
   */
  P80_ASR_MODEL: z.string().min(1).default('large-v3'),
  P80_ASR_DEVICE: z.string().min(1).default('cuda'),
  P80_ASR_COMPUTE_TYPE: z.string().min(1).default('float16'),
  /** Default true: a missing GPU is a refusal naming the reason, not a silent downgrade
   *  to a device the caller did not ask for. How much slower CPU actually is depends
   *  entirely on the model — see ADR 0016 for the measurement and why the default stands
   *  anyway. */
  P80_ASR_REQUIRE_GPU: booleanish.default('true'),
  P80_ASR_ALIGN: booleanish.default('true'),
  P80_ASR_LANG_MIN_PROB: z.coerce.number().min(0).max(1).default(0.5),
  /** Default **false**, unlike the backend's own. Feeding each window the previous
   *  window's text lets a hallucination become the next window's prompt, which is the
   *  usual cause of an invented tail — two identical runs of one file differed by 18
   *  words, all of it in one region at the end. A transcript that varies run to run cannot
   *  be compared against another model's or kept as a fixture. */
  P80_ASR_CONDITION_ON_PREVIOUS_TEXT: booleanish.default('false'),

  /**
   * Extra browser origins the API will accept, comma-separated. Empty by default (ADR 0023).
   *
   * This exists for reverse proxies that serve P80 under a name that is not loopback — a
   * Tailscale `serve` mapping being the case it was written for. P80 still binds
   * `127.0.0.1`; the proxy is what listens, and the browser then sends an `Origin` the
   * loopback allowlist does not contain, which fails **every write** while reads keep
   * working. That asymmetry is why this is a config key rather than advice.
   *
   * **Setting it is an exposure decision and warns at startup**, like `P80_ALLOW_LAN`.
   * P80 has no authentication of any kind, so whatever reaches the API gets the whole
   * library. The proxy's own access control is the only gate, and naming an origin here is
   * a statement that one exists.
   *
   * Each entry must be a bare origin — `scheme://host[:port]`, no path, no credentials, and
   * no `*`. A wildcard is refused rather than interpreted: it would turn the allowlist into
   * a formality.
   */
  P80_TRUSTED_ORIGINS: z
    .string()
    .default('')
    .superRefine((raw, ctx) => {
      for (const entry of splitOriginList(raw)) {
        if (normalizeOrigin(entry) === null) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `${JSON.stringify(entry)} is not an origin. Use scheme://host[:port] with no path, and never "*".`,
          });
        }
      }
    }),
});

function splitOriginList(raw: string): string[] {
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

/**
 * An origin, or `null` if the string is anything else.
 *
 * Deliberately narrow. `URL` accepts a great deal that is not an origin — paths, query
 * strings, credentials — and an allowlist that silently ignored the parts it did not
 * understand would match on less than the author wrote. A wildcard is rejected outright:
 * the point of the list is that it is a list.
 */
function normalizeOrigin(entry: string): string | null {
  if (entry.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.search !== '' || url.hash !== '') return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return url.origin;
}

/**
 * The complete, closed set of environment keys P80 reads. Any key not listed here is
 * ignored, and the guard test asserts this list matches the schema exactly.
 */
export const CONFIG_KEYS = Object.keys(configSchema.shape).sort() as ReadonlyArray<
  keyof typeof configSchema.shape
>;

export type Config = z.infer<typeof configSchema>;

/**
 * Read `.env.local` from the repository root, with the real environment winning.
 *
 * **Nothing was doing this**, which meant `.env.local` was documented, checked for by
 * `pnpm dev`, and then never read: the API and worker booted with a bare `process.env` and
 * died on `P80_MEDIA_ROOT: Required` the moment ADR 0015 made it mandatory. Vite loads the
 * file for the web client on its own, so the browser and the sidecar came up and the two
 * TypeScript services did not — which reads as "the API is broken", not as "the config file
 * is not loaded".
 *
 * Loaded here rather than in `dev.mjs` because six entry points call `loadConfig()` — the
 * API, the worker, the TUI, and the three database CLIs — and only one of them goes through
 * the dev script. Fixing it at the shared call site fixes all six.
 *
 * **The process environment takes precedence over the file.** `P80_API_PORT=5280 pnpm dev`
 * has to mean what it looks like it means, and a file that overrode an explicit export
 * would be the second silent-configuration bug in this file's history.
 */
function readEnvFile(startDir?: string): NodeJS.ProcessEnv {
  const path = resolveFromRepoRoot('.env.local', startDir);
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    // Absent is fine and is the documented default — `.env.example`'s values are the
    // schema's defaults, except for the one key that deliberately has none.
    return {};
  }

  const out: NodeJS.ProcessEnv = {};
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // Quotes are stripped, but nothing is interpolated: no `${VAR}`, no command
    // substitution. This file holds local endpoint config, not a shell script, and a
    // config loader that evaluates its input is a category of problem P80 does not need.
    const value = trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    out[key] = value;
  }
  return out;
}

/**
 * With no argument, reads the process environment layered over `.env.local`.
 *
 * **Passing an explicit `env` skips the file entirely.** Tests build a complete environment
 * and must not inherit whatever the developer running them happens to have in their
 * `.env.local` — a suite that passes on one machine because of a dotfile is worse than no
 * suite.
 */
export function loadConfig(env?: NodeJS.ProcessEnv): Config {
  const source = env ?? { ...readEnvFile(), ...process.env };
  const parsed = configSchema.safeParse(source);
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
    // Same reason, and the same failure would be just as quiet: the API writes the
    // uploaded file and the worker reads it back, so two roots means every parse fails
    // with a missing file that is plainly there.
    P80_STORAGE_PATH: resolveFromRepoRoot(parsed.data.P80_STORAGE_PATH),
    // Third instance of the same hazard, and the worst of the three: the API validates a
    // path against this root and the worker resolves it against this root, so a
    // per-process value would mean a path that passed containment in one process escapes
    // it in the other. Anchoring is a correctness property here, not tidiness.
    P80_MEDIA_ROOT: resolveFromRepoRoot(parsed.data.P80_MEDIA_ROOT),
  };
}

/**
 * Loopback unless the user has explicitly opted into LAN exposure (spec §32.5).
 * Callers are expected to log a warning when this returns true.
 */
export function isLanExposed(config: Config): boolean {
  return config.P80_ALLOW_LAN || config.P80_BIND_HOST !== '127.0.0.1';
}

/**
 * The only origins the API accepts by default (spec §32.5, `03-api.md` §10).
 *
 * Two ports, because the client is served from two places. Under `pnpm dev` it comes from
 * Vite on `P80_WEB_PORT` and every request is cross-origin. In a deployment the API serves
 * the built client itself, so the origin is the API's own — and that still needs to be
 * listed: browsers send `Origin` on same-origin requests whenever the method is not
 * GET or HEAD, so without this entry every `POST /api/items` from the deployed UI would
 * come back `ORIGIN_NOT_ALLOWED`.
 *
 * Both are loopback. This widens which loopback port may talk to the API, not who may.
 *
 * `P80_TRUSTED_ORIGINS` is the one way that changes, and it is empty unless somebody set
 * it (ADR 0023). Everything it adds is normalised through `normalizeOrigin`, so the list
 * compared against the request header holds origins and nothing else.
 */
export function allowedOrigins(config: Config): string[] {
  const ports = new Set([config.P80_WEB_PORT, config.P80_API_PORT]);
  const loopback = [...ports].flatMap((port) => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ]);
  return [...loopback, ...trustedOrigins(config)];
}

/**
 * The configured extra origins, normalised and deduplicated. Empty when unset.
 *
 * Validation already happened in the schema, so anything unparseable would have stopped
 * startup by name. This is the read side.
 */
export function trustedOrigins(config: Config): string[] {
  const seen = new Set<string>();
  for (const entry of splitOriginList(config.P80_TRUSTED_ORIGINS)) {
    const origin = normalizeOrigin(entry);
    if (origin !== null) seen.add(origin);
  }
  return [...seen];
}
