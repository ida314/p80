/**
 * Domain enumerations, transcribed from `docs/contracts/01-domain-model.md` §2.
 *
 * These are the contract's values, not a convenient subset. Where the contract marks a
 * value ADDED or RESOLVED, the comment travels with it — the reasoning is load-bearing
 * for anyone tempted to add a fourth card type or a pipeline-written rejection reason.
 */

export const LEARNING_ITEM_TYPES = ['word', 'multiword_expression', 'construction'] as const;
export type LearningItemType = (typeof LEARNING_ITEM_TYPES)[number];

export const REGISTERS = [
  'neutral',
  'formal',
  'informal',
  'slang',
  'vulgar',
  'technical',
  'literary',
  'archaic',
] as const;
export type Register = (typeof REGISTERS)[number];

/** Lifecycle of an approved learning item. Learner-specific flags (markedKnown,
 *  starred) live on `learner_item_states`, not here. */
export const ITEM_STATUSES = ['active', 'suspended', 'archived'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const CANDIDATE_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'deferred',
  'quarantined',
  'merged',
] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

/** Written ONLY by human action. Under ADR 0008 the pipeline never rejects on value —
 *  "too_rare" and "proper_name" are reasons a person declines an item, not reasons the
 *  extractor discards one. */
export const REJECTION_REASONS = [
  'already_know',
  'too_rare',
  'proper_name',
  'bad_phrase_boundary',
  'bad_transcript',
  'bad_definition',
  'not_useful',
  'duplicate',
  'other',
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** Why a unit was surfaced into the inbox. Probe rows are analysed separately from the
 *  ordinary queue, so this cannot be inferred after the fact. */
export const SURFACE_REASONS = [
  'queue',
  'video_floor',
  'calibration_probe',
  'user_request',
] as const;
export type SurfaceReason = (typeof SURFACE_REASONS)[number];

/** Which MWE funnel layer surfaced a sequence (`07-extraction.md` §10.3). Also selects
 *  the unithood shrinkage prior (`06-scoring.md` §9.1). ADR 0011. */
export const MWE_PROMOTION_SOURCES = [
  'gazetteer',
  'contiguous',
  'dependency',
  'recurrence',
  'llm',
] as const;
export type MwePromotionSource = (typeof MWE_PROMOTION_SOURCES)[number];

export const SCHEDULER_RATINGS = ['again', 'hard', 'good', 'easy'] as const;
export type SchedulerRating = (typeof SCHEDULER_RATINGS)[number];

/** Transfer is a *presentation mode*, not a fourth card type — `reviews.context_mode`
 *  carries it. Giving transfer its own FSRS state would fragment one item's memory model
 *  across two schedules (`02-database.md`, RESOLVED). */
export const CARD_TYPES = [
  'audio_recognition',
  'contextual_cloze',
  'productive_recall',
] as const;
export type CardType = (typeof CARD_TYPES)[number];

export const CONTEXT_MODES = ['source', 'transfer'] as const;
export type ContextMode = (typeof CONTEXT_MODES)[number];

/**
 * ADR 0015 removed `youtube_embedded` and `authorized_youtube_owner`. P80 references a
 * local media file the user already holds; it never acquires media.
 *
 * `licensed_corpus` stays DEFERRED because it describes a shape that remains reachable —
 * media P80 is granted access to under terms — and is not what ADR 0015 closed.
 */
export const MEDIA_SOURCE_KINDS = [
  'local_media',
  'user_uploaded_transcript',
  // DEFERRED — recorded so the enum does not have to change when it arrives.
  'licensed_corpus',
] as const;
export type MediaSourceKind = (typeof MEDIA_SOURCE_KINDS)[number];

/** Where a transcript came from (ADR 0016). Load-bearing for Stage 4's
 *  `punct_confidence`, which keys on transcript provenance rather than on language. */
export const TRANSCRIPT_SOURCES = ['asr', 'upload'] as const;
export type TranscriptSource = (typeof TRANSCRIPT_SOURCES)[number];

/**
 * How precise a transcript's timing is (ADR 0017).
 *
 * `word` transcripts carry a `transcript_words` array and segments are index ranges over
 * it. `cue` transcripts — every uploaded VTT and SRT, always — have timing at cue
 * boundaries only. Stored rather than inferred from the absence of word rows, because
 * consumers branch on it and a capability read off a missing join is invisible in a
 * schema diagram.
 */
export const TIMING_GRANULARITIES = ['word', 'cue'] as const;
export type TimingGranularity = (typeof TIMING_GRANULARITIES)[number];

export const TRANSCRIPT_FORMATS = [
  'vtt',
  'srt',
  'pasted_timestamped',
  'internal_json',
] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

/**
 * How the transcript parser records an anomaly instead of discarding a cue (§14.2:
 * *never silently discard*). Consumed by `06-scoring.md` §4.2 as a transcript-quality
 * dimension, which is displayed separately from difficulty so a bad transcript is never
 * mistaken for a hard video.
 *
 * `subtitle_boilerplate` is ADR 0014's eighth member, and the only one describing the
 * *content* of a cue rather than the *structure* of the file. A matching cue is stored
 * like any other — ADR 0013 takes the pattern list and rejects the filter around it.
 *
 * The list lives here rather than in `packages/providers` because it is persisted
 * (`transcript_files.parse_warnings_json`) and therefore needs a runtime value: an inline
 * union cannot back a Zod schema, a severity map, or an exhaustiveness test.
 */
export const PARSE_WARNING_KINDS = [
  'overlapping_timestamps',
  'out_of_order',
  'missing_punctuation',
  'malformed_line',
  'unparsed_region',
  'encoding_fallback',
  'suspicious_duration',
  'subtitle_boilerplate',
  /**
   * ADR 0016. The ASR path only.
   *
   * ADR 0013 took a sibling project's subtitle-boilerplate regexes and noted that the
   * numeric checks around them — no-speech probability, average log-probability, and a
   * repeat window for a stuck decoder — did not transfer, because user-supplied
   * transcripts carry no such signals. ASR output does.
   */
  'low_asr_confidence',
  /**
   * ADR 0016. The forced aligner could not place a word in time.
   *
   * The only warning that changes what a consumer *can* do rather than what it should
   * believe: a word with no timestamp has no clip to play.
   */
  'unaligned_words',
] as const;
export type ParseWarningKind = (typeof PARSE_WARNING_KINDS)[number];

/**
 * `videos.transcript_status` — about the transcript.
 *
 * ADDED: neither spec §28 nor `02-database.md` names the values. The column is
 * `TEXT NOT NULL DEFAULT 'none'` with no CHECK, so `'none'` must be a member and the
 * vocabulary is enforced in code — see `TRANSCRIPT_STATUS_TRANSITIONS`.
 */
export const TRANSCRIPT_STATUSES = ['none', 'parsing', 'ready', 'failed'] as const;
export type TranscriptStatus = (typeof TRANSCRIPT_STATUSES)[number];

/**
 * The legal moves, asserted by the single write path in `@p80/database`.
 *
 * A CHECK constraint could only police membership. What actually goes wrong is a
 * *transition*: `none → ready` means segments appeared without a parse, which is the bug
 * this table exists to catch. Enforcing transitions is why no migration was needed.
 */
export const TRANSCRIPT_STATUS_TRANSITIONS: Readonly<
  Record<TranscriptStatus, readonly TranscriptStatus[]>
> = {
  // Upload accepted a file and enqueued PARSE_TRANSCRIPT.
  none: ['none', 'parsing'],
  // The worker finished, one way or the other. `parsing → parsing` is a retry.
  parsing: ['parsing', 'ready', 'failed', 'none'],
  // Replacement re-parses; DELETE returns to `none`.
  ready: ['ready', 'parsing', 'none'],
  failed: ['failed', 'parsing', 'none'],
};

/**
 * `videos.processing_status` — about the extraction pipeline, not the transcript.
 *
 * ADDED, same reasoning. Stage 2 writes only `none` and `transcript_ready`; the remaining
 * four are declared now so Stage 4 does not have to reopen the vocabulary, which is the
 * pattern `MEDIA_SOURCE_KINDS` already uses for its deferred members.
 */
export const PROCESSING_STATUSES = [
  'none',
  'transcript_ready',
  'queued',
  'processing',
  'complete',
  'failed',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export const RECOMMENDATION_FEEDBACK = [
  'helpful',
  'not_helpful',
  'too_easy',
  'too_difficult',
  'wrong_transcript',
  'wrong_item_association',
  'do_not_recommend_again',
] as const;
export type RecommendationFeedback = (typeof RECOMMENDATION_FEEDBACK)[number];

export const KNOWN_LEXICON_SOURCES = [
  'frequency_prior',
  'placement',
  'user_marked',
  'review_derived',
] as const;
export type KnownLexiconSource = (typeof KNOWN_LEXICON_SOURCES)[number];

export const IDIOMATICITY_EVIDENCE = ['dictionary', 'embedding', 'llm', 'none'] as const;
export type IdiomaticityEvidence = (typeof IDIOMATICITY_EVIDENCE)[number];
