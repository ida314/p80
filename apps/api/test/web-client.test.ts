import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * The API serves the built browser client on its own port.
 *
 * Under `pnpm dev` Vite compiles the client and proxies `/api/*` here, so the two live on
 * different ports. A deployment has no Vite: the API hands out `apps/web/dist` itself and
 * everything is one origin. Both states have to work — an unbuilt repository is the
 * normal development case, not a broken one.
 */

const SHELL = '<!doctype html><title>P80</title><div id="root"></div>';

describe('with a built client', () => {
  let dir: string;
  let api: TestApi;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'p80-web-'));
    mkdirSync(join(dir, 'assets'), { recursive: true });
    writeFileSync(join(dir, 'index.html'), SHELL);
    writeFileSync(join(dir, 'assets', 'app.js'), 'export const ok = true;\n');
    api = await createTestApi({}, { webRoot: dir });
  });

  afterAll(async () => {
    await api?.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('serves the shell at the root', async () => {
    const res = await api.server.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('id="root"');
  });

  it('serves build assets', async () => {
    const res = await api.server.app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('export const ok');
  });

  it('answers a client-side route with the shell, so a refresh works', async () => {
    // React Router owns these paths. Without the fallback, reloading any page below the
    // root is a 404 — the classic single-page-app deployment bug.
    for (const url of ['/videos', '/items/itm_abc', '/review/session/1']) {
      const res = await api.server.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(200);
      expect(res.body, url).toContain('id="root"');
    }
  });

  it('keeps an unknown API route a JSON error, not the shell', async () => {
    // The fallback must never reach `/api/*`. A typo in a `curl` that returned HTML with
    // a 200 would be a genuinely confusing failure, and ADR 0007's standing test is a
    // shell script.
    const res = await api.server.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('does not answer a non-GET miss with the shell', async () => {
    const res = await api.server.app.inject({ method: 'POST', url: '/videos' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('still serves the API', async () => {
    const res = await api.server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ok');
  });
});

describe('without a built client', () => {
  let api: TestApi;

  beforeAll(async () => {
    // The default: `createTestApi` points at a directory that was never built.
    api = await createTestApi();
  });
  afterAll(async () => api?.dispose());

  it('starts anyway and serves the API', async () => {
    const res = await api.server.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
  });

  it('returns the ordinary 404 envelope at the root', async () => {
    const res = await api.server.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});
