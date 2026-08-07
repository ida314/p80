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

export const MEDIA_SOURCE_KINDS = [
  'youtube_embedded',
  'user_uploaded_transcript',
  // DEFERRED — recorded so the enum does not have to change when they arrive.
  'local_media',
  'licensed_corpus',
  'authorized_youtube_owner',
] as const;
export type MediaSourceKind = (typeof MEDIA_SOURCE_KINDS)[number];

export const TRANSCRIPT_FORMATS = [
  'vtt',
  'srt',
  'pasted_timestamped',
  'internal_json',
] as const;
export type TranscriptFormat = (typeof TRANSCRIPT_FORMATS)[number];

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
