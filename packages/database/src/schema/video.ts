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
    /** Relative to `P80_MEDIA_ROOT` (ADR 0015). An absolute path would break the moment
     *  the library moved, which is the event this design exists to survive. */
    mediaPath: text('media_path'),
    /** 0/1. Never cascades — only playback needs the bytes (ADR 0018 §3). */
    mediaMissing: integer('media_missing').notNull(),
    mediaBytes: integer('media_bytes'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  // Duplicate-video detection is this constraint, not application logic. Since ADR 0018
  // `externalVideoId` is a content hash, so it now catches renames and copies too.
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
  /** Null for `source = 'asr'` — there is no uploaded file. */
  storagePath: text('storage_path'),
  checksum: text('checksum').notNull(),
  parserVersion: text('parser_version').notNull(),
  parseWarningsJson: text('parse_warnings_json'),
  /** `asr` | `upload`. Load-bearing for Stage 4, not bookkeeping: ADR 0013 keys
   *  `punct_confidence` on where a transcript came from, because a model that punctuated
   *  with access to the audio and an auto-caption track with no punctuation at all are not
   *  equally reliable evidence of a sentence ending. */
  source: text('source').notNull(),
  /** `word` | `cue` (ADR 0017). */
  timingGranularity: text('timing_granularity').notNull(),
  asrModelId: text('asr_model_id'),
  asrAlignmentModelId: text('asr_alignment_model_id'),
  detectedLanguage: text('detected_language'),
  languageProbability: real('language_probability'),
  createdAt: integer('created_at').notNull(),
});

/**
 * The source of truth where a transcript has word-level timing (ADR 0017).
 *
 * Written once by the ASR job and never rewritten. `transcriptSegments` are half-open
 * index ranges over this array; their denormalised text and timing are rebuilt from the
 * indices rather than edited, because an index range cannot desynchronise from the timing
 * its text is bound to.
 */
export const transcriptWords = sqliteTable(
  'transcript_words',
  {
    id: text('id').primaryKey(),
    videoId: text('video_id').notNull(),
    transcriptFileId: text('transcript_file_id').notNull(),
    wordIndex: integer('word_index').notNull(),
    text: text('text').notNull(),
    startMs: integer('start_ms').notNull(),
    endMs: integer('end_ms').notNull(),
    /** Null where the aligner could not place the word. A number meaning "unknown" would
     *  be indistinguishable from a bad score, and an unplaced word has no clip at all. */
    confidence: real('confidence'),
  },
  (t) => [unique().on(t.transcriptFileId, t.wordIndex)],
);

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
  /** Half-open range into `transcriptWords`. Null at `timing_granularity = 'cue'`. */
  wordStartIndex: integer('word_start_index'),
  wordEndIndex: integer('word_end_index'),
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
