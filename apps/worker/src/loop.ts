import { setTimeout as sleep } from 'node:timers/promises';
import { hostname } from 'node:os';
import { ERROR_CODES, P80Error, type Logger } from '@p80/core';
import {
  claimNextJob,
  completeJob,
  failJob,
  reclaimStaleJobs,
  type DatabaseHandle,
} from '@p80/database';
import type { JobHandlerSource } from './registry.js';

export interface WorkerOptions {
  handle: DatabaseHandle;
  registry: JobHandlerSource;
  logger: Logger;
  /** How long to wait when there was nothing to claim. */
  pollIntervalMs?: number;
  /** A `running` job whose claim is older than this is assumed to belong to a dead
   *  worker and returns to the pool. */
  staleClaimMs?: number;
  workerId?: string;
}

export interface Worker {
  /** Runs until `stop()`. */
  run(): Promise<void>;
  /** Claims and runs at most one job. Returns the job id, or null if none was waiting.
   *  Exposed so tests can drive the loop deterministically instead of racing a timer. */
  tick(): Promise<string | null>;
  stop(): void;
  readonly workerId: string;
}

/**
 * SQLite-backed job polling. No Redis (spec §26.1).
 *
 * Polling rather than notification is a real choice: SQLite has no queue primitive, one
 * worker is enough for a local single-user application, and a poll loop is inspectable
 * with a `SELECT`. The cost is up to `pollIntervalMs` of latency on a freshly enqueued
 * job, which no MVP surface is sensitive to.
 */
export function createWorker(options: WorkerOptions): Worker {
  const {
    handle,
    registry,
    logger,
    pollIntervalMs = 500,
    staleClaimMs = 5 * 60_000,
  } = options;

  const workerId = options.workerId ?? `${hostname()}:${process.pid}`;
  const eligible = registry.types();
  let stopping = false;

  async function tick(): Promise<string | null> {
    // A worker that handles nothing must claim nothing. Passing an empty list down to
    // the claim query would drop the type filter entirely and let this worker grab —
    // and then fail — every job in the queue.
    if (eligible.length === 0) return null;

    reclaimStaleJobs(handle, staleClaimMs);

    const job = claimNextJob(handle, workerId, eligible);
    if (!job) return null;

    const jobLogger = logger.child({ jobId: job.id, jobType: job.jobType });
    const handler = registry.get(job.jobType);

    if (!handler) {
      // Claimed but unrunnable. Fail it loudly rather than leaving it `running`
      // forever — an invisible stuck job is worse than a visible failed one.
      //
      // Non-retryable, and definitionally so: no amount of waiting registers a handler in
      // a process that is already running. Two further attempts would only bury the one
      // useful line under two copies of itself (ADR 0027).
      failJob(
        handle,
        job.id,
        new P80Error(
          ERROR_CODES.JOB_NOT_RETRYABLE,
          `No handler registered for ${job.jobType}`,
          { statusCode: 500, retryable: false, details: { jobType: job.jobType } },
        ),
      );
      jobLogger.error('no handler registered');
      return job.id;
    }

    const startedAt = Date.now();
    try {
      const output = await handler({
        handle,
        logger: jobLogger,
        job,
        isCancelled: () => stopping,
      });
      completeJob(handle, job.id, output);
      jobLogger.info({ durationMs: Date.now() - startedAt }, 'job succeeded');
    } catch (error) {
      // Completed stages are preserved and the error is kept for inspection (§27.4).
      // Nothing is retried silently and no fallback result is fabricated.
      const status = failJob(handle, job.id, error);
      jobLogger.error(
        { err: error, durationMs: Date.now() - startedAt, status },
        status === 'pending' ? 'job failed, will retry' : 'job failed, attempts exhausted',
      );
    }
    return job.id;
  }

  return {
    workerId,
    async run() {
      logger.info({ workerId, handles: eligible }, 'worker started');
      while (!stopping) {
        const claimed = await tick();
        if (!claimed && !stopping) await sleep(pollIntervalMs);
      }
      logger.info({ workerId }, 'worker stopped');
    },
    tick,
    stop() {
      stopping = true;
    },
  };
}
