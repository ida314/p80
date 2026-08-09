import type { Config, JobRecord, JobType, Logger } from '@p80/core';
import type { DatabaseHandle } from '@p80/database';
import { createAsrProvider } from '@p80/providers';
import { createIngestMediaHandler } from './handlers/ingest-media.js';
import { createParseTranscriptHandler } from './handlers/parse-transcript.js';
import { createTranscribeHandler } from './handlers/transcribe.js';

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
 * `NOOP` — does nothing, deliberately.
 *
 * It exists so Stage 1's exit criterion 4, "worker can claim and complete a test job", is
 * a test rather than a promise. It stays because `scripts/smoke.sh` and `pnpm dev:noop`
 * still use it to prove the claim loop is alive without needing real work to do.
 */
export function createNoopRegistry(): JobRegistry {
  return new JobRegistry().register('NOOP', async ({ job }) => ({
    noop: true,
    jobId: job.id,
  }));
}

/**
 * The registry the worker actually runs.
 *
 * `registry.types()` is what the claim loop filters on, so a job type with no handler here
 * is never claimed — it sits `pending` rather than being claimed and failed. That is why
 * the annotation chain's seventeen types can exist in `JOB_TYPES` from Stage 1 without the
 * worker choking on one.
 */
export function createRegistry(deps: { config: Config }): JobRegistry {
  // Constructed, not dialled. Building the client opens no socket, so a sidecar that is
  // down stays an ordinary runtime state rather than a startup failure — the same rule
  // §5.2 sets for the LLM provider, and the reason nothing here checks for a provider.
  const asr = createAsrProvider(deps.config.P80_NLP_BASE_URL);

  return createNoopRegistry()
    .register('INGEST_MEDIA', createIngestMediaHandler({ config: deps.config }))
    .register('TRANSCRIBE', createTranscribeHandler({ config: deps.config, asr }))
    .register('PARSE_TRANSCRIPT', createParseTranscriptHandler({ config: deps.config }));
}
