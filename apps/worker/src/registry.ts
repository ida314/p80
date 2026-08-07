import type { JobRecord, JobType, Logger } from '@p80/core';
import type { DatabaseHandle } from '@p80/database';

export interface JobContext {
  handle: DatabaseHandle;
  logger: Logger;
  job: JobRecord;
  /** Resolves true once shutdown has begun. A long handler should check this between
   *  units of work and stop cleanly rather than being killed mid-write. */
  isCancelled(): boolean;
}

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/** What the loop needs from a registry. An interface rather than the class so tests can
 *  supply a source that reports a type it cannot actually handle — the case the loop's
 *  missing-handler branch exists for. */
export interface JobHandlerSource {
  get(type: JobType): JobHandler | undefined;
  types(): JobType[];
}

/**
 * Handlers are registered, not imported by the loop.
 *
 * Every job must be idempotent, retryable, inspectable, cancellable where possible, and
 * versioned (§27.3). Those are properties of the loop plus the handler contract, which
 * is why the loop is worth getting right once here rather than thirteen times later.
 */
export class JobRegistry implements JobHandlerSource {
  readonly #handlers = new Map<JobType, JobHandler>();

  register(type: JobType, handler: JobHandler): this {
    this.#handlers.set(type, handler);
    return this;
  }

  get(type: JobType): JobHandler | undefined {
    return this.#handlers.get(type);
  }

  types(): JobType[] {
    return [...this.#handlers.keys()];
  }
}

/**
 * The Stage 1 registry: one handler that does nothing.
 *
 * `NOOP` exists so exit criterion 4 — "worker can claim and complete a test job" — is a
 * test rather than a promise. Real handlers arrive with the stages that need them:
 * `PARSE_TRANSCRIPT` in Stage 2, the annotation chain in Stage 4.
 */
export function createStage1Registry(): JobRegistry {
  return new JobRegistry().register('NOOP', async ({ job }) => ({
    noop: true,
    jobId: job.id,
  }));
}
