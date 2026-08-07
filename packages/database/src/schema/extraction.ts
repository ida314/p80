import { integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * The observed tier (ADR 0008) and the candidate queue.
 *
 * Capture is complete; ranking decides visibility. Nothing here is ever dropped for
 * being low value — only for not being a language item at all.
 */

/**
 * Language-scoped, not profile-scoped: the saturation curve is a property of a language
 * and a corpus rather than of a learner, and learner state joins from `knownLexicon` at
 * read time.
 */
export const observedUnits = sqliteTable(
  'observed_units',
  {
    id: text('id').primaryKey(),
    targetLanguage: text('target_language').notNull(),
    lemma: text('lemma').notNull(),
    normalizedForm: text('normalized_form').notNull(),
    pos: text('pos').notNull(),
    unitType: text('unit_type').notNull(),
    firstSeenVideoId: text('first_seen_video_id'),
    firstSeenAt: integer('first_seen_at').notNull(),
    videoCount: integer('video_count').notNull(),
    totalCount: integer('total_count').notNull(),
    score: real('score'),
    scoreBreakdownJson: text('score_breakdown_json'),
    scoredAt: integer('scored_at'),
    /** Marks units needing rescore after a material learner-state change, so
     *  `RESCORE_OBSERVATIONS` works incrementally rather than sweeping the pool. */
    isDirty: integer('is_dirty').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [unique().on(t.targetLanguage, t.lemma, t.pos)],
);

export const observedUnitOccurrences = sqliteTable('observed_unit_occurrences', {
  id: text('id').primaryKey(),
  observedUnitId: text('observed_unit_id').notNull(),
  videoId: text('video_id').notNull(),
  sentenceId: text('sentence_id').notNull(),
  tokenIndex: integer('token_index').notNull(),
  surfaceForm: text('surface_form').notNull(),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
});

/**
 * The observed tier for MWEs — a materialized index over `tokens`, not an irreplaceable
 * record. Any write policy is reversible by a backfill that re-derives spans, which is
 * what makes the write threshold a performance decision rather than a recall decision.
 *
 * `score` holds **unithood** (`06-scoring.md` §9.1), not importance: the table has no
 * `profileId`, so it structurally cannot hold a learner-specific number.
 */
export const ngramObservations = sqliteTable(
  'ngram_observations',
  {
    id: text('id').primaryKey(),
    targetLanguage: text('target_language').notNull(),
    hash: text('hash').notNull(),
    lemmaSeq: text('lemma_seq').notNull(),
    n: integer('n').notNull(),
    videoCount: integer('video_count').notNull(),
    totalCount: integer('total_count').notNull(),
    /** Which funnel layer surfaced it, so layer precision is measurable individually
     *  rather than only in aggregate. Also selects the shrinkage prior in §9.1. */
    promotionSource: text('promotion_source').notNull(),
    firstSeenVideoId: text('first_seen_video_id'),
    firstSeenSentenceId: text('first_seen_sentence_id'),
    firstSeenAt: integer('first_seen_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
    score: real('score'),
    scoreBreakdownJson: text('score_breakdown_json'),
    isDirty: integer('is_dirty').notNull(),
    /** Nullable until enrichment runs. `idiomaticityVerified` is true only for a
     *  dictionary hit, per the rule that the dictionary is the lexical authority. */
    idiomaticity: real('idiomaticity'),
    idiomaticityEvidence: text('idiomaticity_evidence'),
    idiomaticityVerified: integer('idiomaticity_verified').notNull(),
  },
  (t) => [unique().on(t.targetLanguage, t.hash)],
);

/**
 * A candidate is a **promoted** observed unit, not everything the pipeline found.
 * Exactly one of `observedUnitId` or `ngramObservationId` is set.
 *
 * `scoreBreakdownJson` is not optional: the score decides visibility, so an unexplained
 * score is an unexplained absence. `rejectionReason` is written only by human action.
 */
export const candidates = sqliteTable('candidates', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  observedUnitId: text('observed_unit_id'),
  ngramObservationId: text('ngram_observation_id'),
  videoId: text('video_id'),
  canonicalForm: text('canonical_form').notNull(),
  normalizedForm: text('normalized_form').notNull(),
  proposedType: text('proposed_type').notNull(),
  proposedSense: text('proposed_sense'),
  score: real('score'),
  scoreBreakdownJson: text('score_breakdown_json'),
  extractionConfidence: real('extraction_confidence'),
  definitionConfidence: real('definition_confidence'),
  status: text('status').notNull(),
  rejectionReason: text('rejection_reason'),
  mergedIntoItemId: text('merged_into_item_id'),
  surfacedAt: integer('surfaced_at').notNull(),
  surfaceReason: text('surface_reason').notNull(),
  /** Null until `ENRICH_CANDIDATE` completes. A promoted-but-unenriched candidate is
   *  valid and must render, marked as awaiting enrichment (§27.4). */
  enrichedAt: integer('enriched_at'),
  pipelineVersion: text('pipeline_version'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const candidateOccurrences = sqliteTable('candidate_occurrences', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id').notNull(),
  sentenceId: text('sentence_id').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  surfaceForm: text('surface_form').notNull(),
  confidence: real('confidence'),
});
