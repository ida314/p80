import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  allowedOrigins,
  isLanExposed,
  loadConfig,
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
    'P80_BIND_HOST',
    'P80_DB_PATH',
    'P80_LOG_LEVEL',
    'P80_MEDIA_ROOT',
    'P80_NLP_BASE_URL',
    'P80_NLP_PORT',
    'P80_STORAGE_PATH',
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

  it('allows only loopback web origins', () => {
    const config = loadConfig({ ...REQUIRED, P80_WEB_PORT: '5173' });
    expect(allowedOrigins(config)).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]);
  });

  it('rejects an invalid port rather than falling back to a default', () => {
    expect(() => loadConfig({ ...REQUIRED, P80_API_PORT: 'not-a-port' })).toThrow(
      /Invalid P80 configuration/,
    );
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
  it.each(['P80_DB_PATH', 'P80_STORAGE_PATH', 'P80_MEDIA_ROOT'] as const)(
    'anchors %s to the repository root, not the working directory',
    (key) => {
      const config = loadConfig({ ...REQUIRED, [key]: './data/somewhere' });
      expect(isAbsolute(config[key])).toBe(true);
      expect(config[key]).toBe(resolveFromRepoRoot('./data/somewhere'));
    },
  );
});
