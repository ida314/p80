import { describe, expect, it } from 'vitest';
import {
  CONFIG_KEYS,
  allowedOrigins,
  isLanExposed,
  loadConfig,
} from '../src/config.js';

/**
 * Stage 1 exit criterion 7 (contract-derived).
 *
 * `CLAUDE.md` rule 14: P80 holds no API keys. This test makes that mechanical instead of
 * remembered — the set of environment keys the application reads is closed, and adding a
 * credential-shaped one fails here.
 */
describe('configuration', () => {
  const EXPECTED_KEYS = [
    'P80_ALLOW_LAN',
    'P80_API_PORT',
    'P80_BIND_HOST',
    'P80_DB_PATH',
    'P80_LOG_LEVEL',
    'P80_NLP_BASE_URL',
    'P80_NLP_PORT',
    'P80_VLLM_BASE_URL',
    'P80_VLLM_MODEL_ID',
    'P80_WEB_PORT',
  ];

  it('reads exactly the committed key allowlist', () => {
    expect([...CONFIG_KEYS]).toEqual(EXPECTED_KEYS);
  });

  it('reads no key that looks like a credential', () => {
    const forbidden = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)$/;
    const offenders = CONFIG_KEYS.filter((k) => forbidden.test(k));
    expect(offenders).toEqual([]);
  });

  it('defaults to loopback with LAN exposure off', () => {
    const config = loadConfig({});
    expect(config.P80_BIND_HOST).toBe('127.0.0.1');
    expect(config.P80_ALLOW_LAN).toBe(false);
    expect(isLanExposed(config)).toBe(false);
  });

  it('treats a non-loopback bind host as LAN exposure even without the flag', () => {
    const config = loadConfig({ P80_BIND_HOST: '0.0.0.0' });
    expect(isLanExposed(config)).toBe(true);
  });

  it('allows only loopback web origins', () => {
    const config = loadConfig({ P80_WEB_PORT: '5173' });
    expect(allowedOrigins(config)).toEqual([
      'http://127.0.0.1:5173',
      'http://localhost:5173',
    ]);
  });

  it('rejects an invalid port rather than falling back to a default', () => {
    expect(() => loadConfig({ P80_API_PORT: 'not-a-port' })).toThrow(
      /Invalid P80 configuration/,
    );
  });
});
