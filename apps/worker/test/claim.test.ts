import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@p80/core';
import {
  claimNextJob,
  enqueueJob,
  getJob,
  migrate,
  openDatabase,
  reclaimStaleJobs,
  type DatabaseHandle,
} from '@p80/database';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorker } from '../src/loop.js';
import { JobRegistry, createNoopRegistry } from '../src/registry.js';

/**
 * Stage 1 exit criterion 4 — "worker can claim and complete a test job".
 *
 * The three cases below are the ones that make the loop trustworthy for the thirteen
 * real job types that follow: a job completes, two workers racing produce exactly one
 * winner, and a crashed worker's job comes back.
 */
const logger = createLogger('test', 'silent');

let dir: string;
let handles: DatabaseHandle[] = [];

afterEach(() => {
  for (const h of handles) h.close();
  handles = [];
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function open(): DatabaseHandle {
  const handle = openDatabase(join(dir, 'p80.db'));
  handles.push(handle);
  return handle;
}

function fresh(): DatabaseHandle {
  dir = mkdtempSync(join(tmpdir(), 'p80-worker-'));
  const handle = open();
  migrate(handle.sqlite);
  return handle;
}

describe('job claim loop', () => {
  it('claims a pending job and marks it succeeded', async () => {
    const handle = fresh();
    const job = enqueueJob(handle, 'NOOP', { entityType: 'test', entityId: 'x' });
    expect(job.status).toBe('pending');

    const worker = createWorker({ handle, registry: createNoopRegistry(), logger });
    expect(await worker.tick()).toBe(job.id);

    const done = getJob(handle, job.id)!;
    expect(done.status).toBe('succeeded');
    expect(done.attemptCount).toBe(1);
    expect(done.startedAt).not.toBeNull();
    expect(done.completedAt).not.toBeNull();
    expect(done.outputJson).toMatchObject({ noop: true });
  });

  it('returns null when nothing is waiting', async () => {
    const handle = fresh();
    const worker = createWorker({ handle, registry: createNoopRegistry(), logger });
    expect(await worker.tick()).toBeNull();
  });

  it('gives one job to exactly one of two competing workers', () => {
    // Two connections to the same file, as the API and worker would be. The claim is a
    // single atomic statement, so a select-then-update race is not possible.
    const a = fresh();
    const b = open();

    const job = enqueueJob(a, 'NOOP');

    const first = claimNextJob(a, 'worker-a', ['NOOP']);
    const second = claimNextJob(b, 'worker-b', ['NOOP']);

    expect(first?.id).toBe(job.id);
    expect(second).toBeNull();
    expect(getJob(b, job.id)!.claimedBy).toBe('worker-a');
  });

  it('claims in priority then age order', async () => {
    const handle = fresh();
    const low = enqueueJob(handle, 'NOOP', { priority: 0 });
    const high = enqueueJob(handle, 'NOOP', { priority: 10 });

    const worker = createWorker({ handle, registry: createNoopRegistry(), logger });
    expect(await worker.tick()).toBe(high.id);
    expect(await worker.tick()).toBe(low.id);
  });

  it('returns a crashed worker’s job to the pool', () => {
    const handle = fresh();
    const job = enqueueJob(handle, 'NOOP');

    claimNextJob(handle, 'worker-that-died', ['NOOP']);
    expect(getJob(handle, job.id)!.status).toBe('running');

    // Backdate the claim past the staleness window.
    handle.sqlite
      .prepare('UPDATE jobs SET claimed_at = ? WHERE id = ?')
      .run(Date.now() - 600_000, job.id);

    expect(reclaimStaleJobs(handle, 300_000)).toBe(1);

    const reclaimed = getJob(handle, job.id)!;
    expect(reclaimed.status).toBe('pending');
    expect(reclaimed.claimedBy).toBeNull();
    // attemptCount is NOT reset: a job that reliably kills its worker should exhaust its
    // attempts rather than crash-loop forever.
    expect(reclaimed.attemptCount).toBe(1);
  });

  it('does not reclaim a claim that is still fresh', () => {
    const handle = fresh();
    enqueueJob(handle, 'NOOP');
    claimNextJob(handle, 'busy-worker', ['NOOP']);
    expect(reclaimStaleJobs(handle, 300_000)).toBe(0);
  });
});

describe('failure handling', () => {
  it('retries while attempts remain, then fails with the error preserved', async () => {
    const handle = fresh();
    const registry = new JobRegistry().register('NOOP', async () => {
      throw new Error('provider unreachable');
    });
    const worker = createWorker({ handle, registry, logger });
    const job = enqueueJob(handle, 'NOOP', { maxAttempts: 2 });

    await worker.tick();
    const afterFirst = getJob(handle, job.id)!;
    expect(afterFirst.status).toBe('pending');
    expect(afterFirst.attemptCount).toBe(1);

    await worker.tick();
    const afterSecond = getJob(handle, job.id)!;
    expect(afterSecond.status).toBe('failed');
    expect(afterSecond.attemptCount).toBe(2);
    // §27.4: the failure is inspectable and no fallback result was fabricated.
    expect(afterSecond.errorJson).toMatchObject({ message: 'provider unreachable' });
    expect(afterSecond.outputJson).toBeNull();

    // Exhausted, so the loop leaves it alone.
    expect(await worker.tick()).toBeNull();
  });

  it('fails a claimed job with no registered handler instead of leaving it running', async () => {
    const handle = fresh();
    const job = enqueueJob(handle, 'NOOP', { maxAttempts: 1 });

    // A source that advertises NOOP but cannot run it. An invisible stuck `running` row
    // is worse than a visible failed one, so the loop must not simply skip it.
    const worker = createWorker({
      handle,
      registry: { types: () => ['NOOP'], get: () => undefined },
      logger,
    });

    expect(await worker.tick()).toBe(job.id);
    const failed = getJob(handle, job.id)!;
    expect(failed.status).toBe('failed');
    expect(failed.errorJson).toMatchObject({ message: /No handler registered/ });
  });

  it('claims nothing at all when it handles nothing', async () => {
    const handle = fresh();
    const job = enqueueJob(handle, 'PARSE_TRANSCRIPT');

    const worker = createWorker({
      handle,
      registry: { types: () => [], get: () => undefined },
      logger,
    });

    expect(await worker.tick()).toBeNull();
    // Untouched — not claimed, not failed. Another worker can still take it.
    expect(getJob(handle, job.id)!.status).toBe('pending');
  });
});
