import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * Stage 1 exit criterion 5 — "services reject unsupported remote origins".
 *
 * Strict CORS, loopback only (spec §32.5, `03-api.md` §10). This is the boundary that
 * keeps a page on the open web from reading a learner's library out of a local server
 * they left running.
 */
let api: TestApi;
beforeAll(async () => {
  api = await createTestApi({ P80_WEB_PORT: '5173', P80_API_PORT: '5180' });
});
afterAll(async () => api?.dispose());

describe('CORS', () => {
  it('accepts the API’s own origin, which a deployed client uses', async () => {
    // The deployed client is served by the API on the API's port, so its requests are
    // same-origin — but browsers still send `Origin` on anything that is not GET or
    // HEAD. Without this, every write from the deployed UI would be a 403.
    const res = await api.server.app.inject({
      method: 'PUT',
      url: '/api/profile',
      headers: { origin: 'http://127.0.0.1:5180' },
      payload: { dailyMinutes: 20 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:5180');
  });

  it('accepts the loopback web origin', async () => {
    for (const origin of ['http://127.0.0.1:5173', 'http://localhost:5173']) {
      const res = await api.server.app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { origin },
      });
      expect(res.statusCode, origin).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe(origin);
    }
  });

  it('rejects a remote origin', async () => {
    const res = await api.server.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://evil.example' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('ORIGIN_NOT_ALLOWED');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('rejects a LAN origin, not only a public one', async () => {
    const res = await api.server.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://192.168.1.24:5173' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects the right port on the right host', async () => {
    const res = await api.server.app.inject({
      method: 'GET',
      url: '/api/health',
      headers: { origin: 'http://127.0.0.1:9999' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a preflight from a remote origin', async () => {
    const res = await api.server.app.inject({
      method: 'OPTIONS',
      url: '/api/profile',
      headers: {
        origin: 'http://evil.example',
        'access-control-request-method': 'PUT',
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('allows a request with no Origin header, which is not a browser cross-origin call', async () => {
    // The TUI and `curl` send no Origin. ADR 0007's integration test — a shell script
    // completing a full review session — depends on this staying true.
    const res = await api.server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });
});
