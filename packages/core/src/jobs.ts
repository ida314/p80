/**
 * Job types and states.
 *
 * The list is `docs/contracts/07-extraction.md` §12 — the RESOLVED pipeline — **not**
 * spec §27.1. The differences are deliberate: enrichment moves after ranking, two jobs
 * split into observe/consolidate pairs, and `RESCORE_OBSERVATIONS` is new (ADR 0008).
 * Using the spec's older list here would reintroduce the filter-first ordering.
 */
export const JOB_TYPES = [
  /** ADR 0015/0018. Hash the file, read its duration, and hand off to TRANSCRIBE. Split
   *  from `POST /api/videos` because reading a multi-gigabyte file is seconds, and seconds
   *  do not belong on a request that is supposed to return a job reference. */
  'INGEST_MEDIA',
  /** ADR 0016. Local ASR. The first job that takes minutes rather than milliseconds. */
  'TRANSCRIBE',
  'PARSE_TRANSCRIPT',
  'RECONSTRUCT_SENTENCES',
  'ANNOTATE_TRANSCRIPT',
  'OBSERVE_UNITS',
  'OBSERVE_NGRAMS',
  'CONSOLIDATE_OBSERVATIONS',
  'SCORE_OBSERVATIONS',
  'PROMOTE_CANDIDATES',
  'ENRICH_CANDIDATE',
  'DETECT_MWE_GAZETTEER',
  'DETECT_MWE_STATISTICAL',
  'PROPOSE_MWE_LLM',
  'EXTRACT_CONSTRUCTIONS',
  'RESCORE_OBSERVATIONS',
  'RECALCULATE_VIDEO_DIFFICULTY',
  'RECALCULATE_RECOMMENDATIONS',
  'EXPORT_DATA',
  /**
   * Stage 1 only. Does nothing, exists so the claim loop has something to claim and so
   * exit criterion 4 is a test rather than a promise. Never registered outside tests and
   * the smoke script.
   */
  'NOOP',
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/** Spec §27.2. */
export const JOB_STATES = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'needs_input',
] as const;
export type JobState = (typeof JOB_STATES)[number];

export const TERMINAL_JOB_STATES: readonly JobState[] = [
  'succeeded',
  'failed',
  'cancelled',
];

export interface JobRecord {
  id: string;
  jobType: JobType;
  entityType: string | null;
  entityId: string | null;
  status: JobState;
  attemptCount: number;
  maxAttempts: number;
  priority: number;
  inputJson: unknown;
  outputJson: unknown;
  errorJson: unknown;
  claimedBy: string | null;
  claimedAt: number | null;
  createdAt: number;
  startedAt: number | null;
  completedAt: number | null;
  /** The earliest this job may be claimed. Null is now; a value is a retry serving its
   *  backoff (ADR 0027). */
  availableAt: number | null;
}

/**
 * How long a failed job waits before it may be claimed again, indexed by the attempt that
 * just failed. The last entry repeats for any further attempts.
 *
 * A table rather than a formula, because with `max_attempts` of 3 there are only ever two
 * waits and an explicit pair is something an operator can predict. Sized against what a
 * retry is actually outlasting here: a sidecar container coming back up, or a model being
 * loaded for the first time. Long enough to be worth waiting for, short enough that a
 * transient failure does not look like a hang.
 */
export const RETRY_BACKOFF_MS: readonly number[] = [5_000, 30_000];

/** When a job that has just failed its `attempt`th try may be claimed again. */
export function retryAvailableAt(attempt: number, at: number): number {
  const index = Math.min(Math.max(attempt, 1), RETRY_BACKOFF_MS.length) - 1;
  return at + RETRY_BACKOFF_MS[index]!;
}
