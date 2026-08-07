/**
 * Job types and states.
 *
 * The list is `docs/contracts/07-extraction.md` §12 — the RESOLVED pipeline — **not**
 * spec §27.1. The differences are deliberate: enrichment moves after ranking, two jobs
 * split into observe/consolidate pairs, and `RESCORE_OBSERVATIONS` is new (ADR 0008).
 * Using the spec's older list here would reintroduce the filter-first ordering.
 */
export const JOB_TYPES = [
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
}
