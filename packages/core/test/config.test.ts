import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  allowedOrigins,
  isLanExposed,
  loadConfig,
  trustedOrigins,
} from '../src/config.js';
import { resolveFromRepoRoot } from '../src/paths.js';

/**
 * Stage 1 exit criterion 7 (contract-derived).
 *
 * `CLAUDE.md` rule 14: P80 holds no API keys. This test makes that mechanical instead of
 * remembered — the set of environment keys the application reads is closed, and adding a
 * credential-shaped one fails here.
 */
describe('configuration', () => {
  /**
   * `P80_MEDIA_ROOT` has no default (ADR 0015), so every `loadConfig` here supplies one.
   *
   * That is the cost of the decision and it is worth naming: a default would have made
   * these tests shorter and would have made a misconfigured install silently point at an
   * empty directory. The test below asserts the absence directly.
   */
  const REQUIRED = { P80_MEDIA_ROOT: '/media/library' };

  const EXPECTED_KEYS = [
    'P80_ALLOW_LAN',
    'P80_API_PORT',
    // The six ASR keys joined the allowlist with ADR 0019: they used to live only in
    // `asr.py`, and P80 now sends them with each transcription request so they can be
    // edited without restarting the Python process.
    'P80_ASR_ALIGN',
    'P80_ASR_COMPUTE_TYPE',
    'P80_ASR_DEVICE',
    'P80_ASR_LANG_MIN_PROB',
    'P80_ASR_MODEL',
    'P80_ASR_REQUIRE_GPU',
    'P80_BIND_HOST',
    'P80_DB_PATH',
    'P80_LOG_LEVEL',
    'P80_MEDIA_ROOT',
    'P80_NLP_BASE_URL',
    'P80_NLP_PORT',
    'P80_STORAGE_PATH',
    // ADR 0023. Not a credential and not a secret: it names browser origins a reverse
    // proxy serves P80 under, and it is empty unless somebody set it.
    'P80_TRUSTED_ORIGINS',
    'P80_VLLM_BASE_URL',
    'P80_VLLM_MODEL_ID',
    'P80_WEB_PORT',
  ];

  it('reads exactly the committed key allowlist', () => {
    expect([...CONFIG_KEYS]).toEqual(EXPECTED_KEYS);
  });

  it('refuses to start without a media root, rather than guessing one', () => {
    // The one required key. Every other path can be wrong quietly and recover; this one
    // decides what the containment check contains, so a wrong guess is a silent one.
    expect(() => loadConfig({})).toThrow(/P80_MEDIA_ROOT/);
  });

  it('reads no key that looks like a credential', () => {
    const forbidden = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)$/;
    const offenders = CONFIG_KEYS.filter((k) => forbidden.test(k));
    expect(offenders).toEqual([]);
  });

  it('defaults to loopback with LAN exposure off', () => {
    const config = loadConfig({ ...REQUIRED });
    expect(config.P80_BIND_HOST).toBe('127.0.0.1');
    expect(config.P80_ALLOW_LAN).toBe(false);
    expect(isLanExposed(config)).toBe(false);
  });

  it('treats a non-loopback bind host as LAN exposure even without the flag', () => {
    const config = loadConfig({ ...REQUIRED, P80_BIND_HOST: '0.0.0.0' });
    expect(isLanExposed(config)).toBe(true);
  });

  it('allows only loopback origins, on the web port and the API port', () => {
    // Two ports because the client is served from two places: Vite under `pnpm dev`, and
    // the API itself in a deployment. The API's own origin has to be listed — browsers
    // attach `Origin` to same-origin requests whenever the method is not GET or HEAD.
    const config = loadConfig({
      ...REQUIRED,
      P80_WEB_PORT: '5173',
      P80_API_PORT: '5180',
    });
    expect(allowedOrigins(config)).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
      'http://127.0.0.1:5180',
      'http://localhost:5180',
    ]);
  });

  it('does not list a port twice when the client and API share one', () => {
    const config = loadConfig({
      ...REQUIRED,
      P80_WEB_PORT: '5180',
      P80_API_PORT: '5180',
    });
    expect(allowedOrigins(config)).toEqual([
      'http://127.0.0.1:5180',
      'http://localhost:5180',
    ]);
  });

  it('rejects an invalid port rather than falling back to a default', () => {
    expect(() => loadConfig({ ...REQUIRED, P80_API_PORT: 'not-a-port' })).toThrow(
      /Invalid P80 configuration/,
    );
  });

  /**
   * ADR 0023 — a reverse proxy serving P80 under a non-loopback name needs its origin
   * listed, or every write comes back `ORIGIN_NOT_ALLOWED` while reads keep working.
   *
   * The validation tests matter more than the happy path. This key is the only thing that
   * widens who may talk to the API, and P80 has no authentication behind it, so a value
   * that is *nearly* an origin has to be refused at startup rather than half-honoured at
   * request time.
   */
  describe('P80_TRUSTED_ORIGINS', () => {
    it('is empty by default, so the allowlist is loopback until somebody says otherwise', () => {
      const config = loadConfig({ ...REQUIRED });
      expect(trustedOrigins(config)).toEqual([]);
      expect(allowedOrigins(config).every((o) => o.includes('127.0.0.1') || o.includes('localhost'))).toBe(true);
    });

    it('appends the configured origins to the loopback ones', () => {
      const config = loadConfig({
        ...REQUIRED,
        P80_WEB_PORT: '5180',
        P80_API_PORT: '5180',
        P80_TRUSTED_ORIGINS: 'https://p80.example.ts.net',
      });
      expect(allowedOrigins(config)).toEqual([
        'http://127.0.0.1:5180',
        'http://localhost:5180',
        'https://p80.example.ts.net',
      ]);
    });

    it('accepts a comma-separated list, trims it, and drops duplicates', () => {
      const config = loadConfig({
        ...REQUIRED,
        P80_TRUSTED_ORIGINS: ' https://a.example.ts.net ,https://b.example.ts.net, https://a.example.ts.net ',
      });
      expect(trustedOrigins(config)).toEqual([
        'https://a.example.ts.net',
        'https://b.example.ts.net',
      ]);
    });

    it('normalises a trailing slash, which is what a browser sends anyway', () => {
      const config = loadConfig({
        ...REQUIRED,
        P80_TRUSTED_ORIGINS: 'https://p80.example.ts.net/',
      });
      expect(trustedOrigins(config)).toEqual(['https://p80.example.ts.net']);
    });

    it('keeps a non-default port, because the port is part of the origin', () => {
      const config = loadConfig({
        ...REQUIRED,
        P80_TRUSTED_ORIGINS: 'https://gx.example.ts.net:5180',
      });
      expect(trustedOrigins(config)).toEqual(['https://gx.example.ts.net:5180']);
    });

    it.each([
      ['*', 'a bare wildcard'],
      ['https://*.example.ts.net', 'a wildcard subdomain'],
      ['p80.example.ts.net', 'a bare host with no scheme'],
      ['https://p80.example.ts.net/api', 'a path'],
      ['https://p80.example.ts.net?x=1', 'a query string'],
      ['https://user:pw@p80.example.ts.net', 'credentials'],
      ['ftp://p80.example.ts.net', 'a scheme that is not http(s)'],
      ['not a url', 'nonsense'],
    ])('refuses %o at startup — %s', (value) => {
      expect(() =>
        loadConfig({ ...REQUIRED, P80_TRUSTED_ORIGINS: value }),
      ).toThrow(/Invalid P80 configuration/);
    });

    it('names the offending entry rather than the whole list', () => {
      expect(() =>
        loadConfig({
          ...REQUIRED,
          P80_TRUSTED_ORIGINS: 'https://fine.example.ts.net,https://*.evil.example',
        }),
      ).toThrow(/\*/);
    });
  });

  /**
   * ADR 0012's first silent bug, now in its third incarnation. `pnpm --filter` runs the
   * API and the worker in their own package directories, so a relative path resolved
   * against `cwd` gives them different answers. For the database that meant two databases
   * and nothing errored; for storage it would mean the API writes a transcript file the
   * worker cannot find, and every parse fails on a file that is plainly there.
   *
   * `P80_MEDIA_ROOT` is the worst of the three, which is why it is in this list rather
   * than trusted to be absolute in practice. The API validates a user-supplied path
   * against this root and the worker resolves the stored path against it — a per-process
   * value means a path that passed containment in one process escapes it in the other.
   * Anchoring is a correctness property here, not tidiness.
   */
  /**
   * The fourth silent-configuration bug in this file's history, and the loudest.
   *
   * `.env.local` was documented in `SETUP.md`, checked for by `pnpm dev`, and **read by
   * nothing**. Vite loads it for the web client on its own, so the browser and the Python
   * sidecar came up and the API and worker died on `P80_MEDIA_ROOT: Required` — which
   * reads as a broken API rather than as an unloaded config file.
   *
   * Two properties, and the second is what keeps the fix from becoming the next bug: the
   * file is read, and an explicit environment variable still wins over it.
   */
  describe('.env.local', () => {
    it('is read when no environment is passed', () => {
      // The repository's own `.env.local` supplies `P80_MEDIA_ROOT`, which has no default.
      // Before the fix this threw, which is exactly what `pnpm dev` did.
      expect(() => loadConfig()).not.toThrow();
    });

    it('loses to a variable that is actually set in the environment', () => {
      // `P80_API_PORT=5280 pnpm dev` has to mean what it looks like it means.
      const previous = process.env.P80_API_PORT;
      process.env.P80_API_PORT = '5999';
      try {
        expect(loadConfig().P80_API_PORT).toBe(5999);
      } finally {
        if (previous === undefined) delete process.env.P80_API_PORT;
        else process.env.P80_API_PORT = previous;
      }
    });

    it('is not consulted when the caller passes an environment', () => {
      // Otherwise this suite would pass or fail depending on the dotfile of whoever runs
      // it, which is worse than having no suite.
      expect(() => loadConfig({})).toThrow(/P80_MEDIA_ROOT/);
    });
  });

  it.each(['P80_DB_PATH', 'P80_STORAGE_PATH', 'P80_MEDIA_ROOT'] as const)(
    'anchors %s to the repository root, not the working directory',
    (key) => {
      const config = loadConfig({ ...REQUIRED, [key]: './data/somewhere' });
      expect(isAbsolute(config[key])).toBe(true);
      expect(config[key]).toBe(resolveFromRepoRoot('./data/somewhere'));
    },
  );
});
