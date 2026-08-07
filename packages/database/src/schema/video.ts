import { integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const videos = sqliteTable(
  'videos',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    sourceType: text('source_type').notNull(),
    externalVideoId: text('external_video_id').notNull(),
    url: text('url').notNull(),
    title: text('title'),
    targetLanguage: text('target_language').notNull(),
    durationMs: integer('duration_ms'),
    speakerLabel: text('speaker_label'),
    regionLabel: text('region_label'),
    transcriptStatus: text('transcript_status').notNull(),
    processingStatus: text('processing_status').notNull(),
    estimatedCoverage: real('estimated_coverage'),
    difficultyLabel: text('difficulty_label'),
    pipelineVersion: text('pipeline_version'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  // Stage 2's duplicate-video detection is this constraint, not application logic.
  (t) => [unique().on(t.profileId, t.sourceType, t.externalVideoId)],
);

export const videoInterests = sqliteTable('video_interests', {
  videoId: text('video_id').notNull(),
  interestId: text('interest_id').notNull(),
  relevance: real('relevance').notNull(),
});

export const transcriptFiles = sqliteTable('transcript_files', {
  id: text('id').primaryKey(),
  videoId: text('video_id').notNull(),
  format: text('format').notNull(),
  originalFilename: text('original_filename'),
  storagePath: text('storage_path'),
  checksum: text('checksum').notNull(),
  parserVersion: text('parser_version').notNull(),
  parseWarningsJson: text('parse_warnings_json'),
  createdAt: integer('created_at').notNull(),
});

/** Never mutated after ingestion. Corrections live in `transcriptCorrections`. */
export const transcriptSegments = sqliteTable('transcript_segments', {
  id: text('id').primaryKey(),
  videoId: text('video_id').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  speakerLabel: text('speaker_label'),
  rawText: text('raw_text').notNull(),
  normalizedText: text('normalized_text').notNull(),
  confidence: real('confidence'),
  sequenceIndex: integer('sequence_index').notNull(),
});

export const transcriptCorrections = sqliteTable('transcript_corrections', {
  id: text('id').primaryKey(),
  videoId: text('video_id').notNull(),
  transcriptSegmentId: text('transcript_segment_id').notNull(),
  beforeText: text('before_text'),
  afterText: text('after_text'),
  beforeStartMs: integer('before_start_ms'),
  afterStartMs: integer('after_start_ms'),
  beforeEndMs: integer('before_end_ms'),
  afterEndMs: integer('after_end_ms'),
  createdAt: integer('created_at').notNull(),
});

export const sentences = sqliteTable('sentences', {
  id: text('id').primaryKey(),
  videoId: text('video_id').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  text: text('text').notNull(),
  normalizedText: text('normalized_text').notNull(),
  complexityScore: real('complexity_score'),
  languageConfidence: real('language_confidence'),
  tokenCount: integer('token_count').notNull(),
  sequenceIndex: integer('sequence_index').notNull(),
});

export const sentenceSegments = sqliteTable('sentence_segments', {
  sentenceId: text('sentence_id').notNull(),
  transcriptSegmentId: text('transcript_segment_id').notNull(),
  sequenceIndex: integer('sequence_index').notNull(),
});

/**
 * Immutable, and the observed tier for multiword expressions — any span is
 * reconstructible from `(sentenceId, sequenceIndex range)`, so no span rows exist.
 *
 * `headIndex` and `depRelation` are load-bearing, not optional: MWE generation runs on
 * the dependency graph rather than the token sequence, because German separable verbs
 * are discontinuous and no n-gram window recovers them (ADR 0009).
 */
export const tokens = sqliteTable('tokens', {
  id: text('id').primaryKey(),
  sentenceId: text('sentence_id').notNull(),
  videoId: text('video_id').notNull(),
  sequenceIndex: integer('sequence_index').notNull(),
  surface: text('surface').notNull(),
  normalized: text('normalized').notNull(),
  lemma: text('lemma'),
  pos: text('pos'),
  morphJson: text('morph_json'),
  headIndex: integer('head_index'),
  depRelation: text('dep_relation'),
  isEntity: integer('is_entity').notNull(),
  entityType: text('entity_type'),
  startChar: integer('start_char'),
  endChar: integer('end_char'),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
  isTargetLanguage: integer('is_target_language').notNull(),
});

export const videoLoopSessions = sqliteTable('video_loop_sessions', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  videoId: text('video_id').notNull(),
  reviewSessionId: text('review_session_id'),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  comprehensionBefore: integer('comprehension_before'),
  comprehensionAfter: integer('comprehension_after'),
  mainIdeaText: text('main_idea_text'),
  summary1Text: text('summary_1_text'),
  summary2Text: text('summary_2_text'),
  targetItemIdsJson: text('target_item_ids_json'),
  createdAt: integer('created_at').notNull(),
  completedAt: integer('completed_at'),
});
