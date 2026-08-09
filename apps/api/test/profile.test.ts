import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@p80/core';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

/**
 * Stage 1 exit criterion 3 — "application persists profile settings".
 *
 * Persistence is verified across a full close-and-reopen, not within one process. An
 * in-process read proves the object is still in memory, which is not the claim.
 */
let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function open() {
  const config = loadConfig({
    P80_DB_PATH: join(dir, 'p80.db'),
    // Required, with no default (ADR 0015). Nothing in this file touches media; the value
    // just has to exist for the config to load.
    P80_MEDIA_ROOT: join(dir, 'media'),
    P80_LOG_LEVEL: 'silent',
  });
  return buildServer(config);
}

describe('profile', () => {
  it('survives a restart', async () => {
    dir = mkdtempSync(join(tmpdir(), 'p80-profile-'));

    const first = await open();
    const written = await first.app.inject({
      method: 'PUT',
      url: '/api/profile',
      payload: { dailyMinutes: 45, newItemLimit: 7, proficiencyLabel: 'intermediate' },
    });
    expect(written.statusCode).toBe(200);
    const id = written.json().id;
    await first.close();

    const second = await open();
    const read = await second.app.inject({ method: 'GET', url: '/api/profile' });
    await second.close();

    expect(read.statusCode).toBe(200);
    expect(read.json()).toMatchObject({
      id,
      dailyMinutes: 45,
      newItemLimit: 7,
      proficiencyLabel: 'intermediate',
    });
  });

  it('creates exactly one profile, however many times it is asked', async () => {
    dir = mkdtempSync(join(tmpdir(), 'p80-profile-'));

    const server = await open();
    await server.app.inject({ method: 'GET', url: '/api/profile' });
    await server.app.inject({ method: 'GET', url: '/api/profile' });
    const count = server.handle.sqlite
      .prepare('SELECT COUNT(*) AS n FROM profiles')
      .get() as { n: number };
    await server.close();

    expect(count.n).toBe(1);
  });

  it('ships German → English (ADR 0001)', async () => {
    dir = mkdtempSync(join(tmpdir(), 'p80-profile-'));
    const server = await open();
    const res = await server.app.inject({ method: 'GET', url: '/api/profile' });
    await server.close();

    expect(res.json()).toMatchObject({ targetLanguage: 'de', nativeLanguage: 'en' });
  });

  it('rejects an out-of-range value in the contracted envelope', async () => {
    dir = mkdtempSync(join(tmpdir(), 'p80-profile-'));
    const server = await open();
    const res = await server.app.inject({
      method: 'PUT',
      url: '/api/profile',
      payload: { dailyMinutes: -5 },
    });
    await server.close();

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'VALIDATION_FAILED',
      retryable: false,
    });
  });
});
