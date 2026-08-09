import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { P80Error } from '@p80/core';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * Stage 1 exit criterion 8 (contract-derived) — every failure leaves the API in the
 * envelope from `03-api.md` §1.
 *
 * The unexpected-throw case matters most: an exception message can carry a file path or
 * a query fragment, so the handler must not pass it through even though doing so would
 * be more convenient to debug.
 */
let api: TestApi;
beforeAll(async () => {
  api = await createTestApi();
  api.server.app.get('/api/__test/boom', async () => {
    throw new Error('/home/someone/secret/path/p80.db is locked');
  });
  api.server.app.get('/api/__test/known', async () => {
    throw new P80Error('CONFLICT', 'Two senses cannot be merged.', {
      statusCode: 409,
      retryable: false,
      details: { senseKeys: ['bank-river', 'bank-money'] },
    });
  });
  await api.server.app.ready();
});
afterAll(async () => api?.dispose());

const envelopeShape = (body: Record<string, unknown>) => {
  expect(body).toHaveProperty('error');
  const error = body.error as Record<string, unknown>;
  expect(typeof error.code).toBe('string');
  expect(error.code).toMatch(/^[A-Z][A-Z0-9_]*$/);
  expect(typeof error.message).toBe('string');
  expect(typeof error.retryable).toBe('boolean');
};

describe('error envelope', () => {
  it('wraps a known P80Error, keeping its code, status and details', async () => {
    const res = await api.server.app.inject({ url: '/api/__test/known' });
    expect(res.statusCode).toBe(409);
    envelopeShape(res.json());
    expect(res.json().error).toMatchObject({
      code: 'CONFLICT',
      retryable: false,
      details: { senseKeys: ['bank-river', 'bank-money'] },
    });
  });

  it('wraps an unexpected throw without leaking its message', async () => {
    const res = await api.server.app.inject({ url: '/api/__test/boom' });
    expect(res.statusCode).toBe(500);
    envelopeShape(res.json());
    expect(res.json().error.code).toBe('INTERNAL_ERROR');
    expect(res.payload).not.toContain('/home/someone/secret/path');
  });

  it('wraps a missing route', async () => {
    const res = await api.server.app.inject({ url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    envelopeShape(res.json());
    expect(res.json().error.code).toBe('NOT_FOUND');
  });

  it('reports a missing job as NOT_FOUND rather than an empty success', async () => {
    const res = await api.server.app.inject({ url: '/api/jobs/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('health', () => {
  it('reports the database and does not dial the LLM', async () => {
    const res = await api.server.app.inject({ url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      service: 'api',
      database: { reachable: true, migrationsApplied: 2 },
      // Spec §5.2: no provider configured is a normal state, not a degraded one. During
      // Stages 1-6 vLLM is simply not running.
      inference: { mode: 'local', configured: false },
    });
  });
});
