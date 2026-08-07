import { integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const learningItems = sqliteTable(
  'learning_items',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    targetLanguage: text('target_language').notNull(),
    canonicalForm: text('canonical_form').notNull(),
    normalizedForm: text('normalized_form').notNull(),
    lemma: text('lemma'),
    itemType: text('item_type').notNull(),
    /** The sense disambiguator. Homonyms with different meanings are separate items. */
    senseKey: text('sense_key').notNull(),
    partOfSpeech: text('part_of_speech'),
    meaning: text('meaning').notNull(),
    // Translations are NOT columns here — see `itemTranslations` (ADR 0010).
    register: text('register').notNull(),
    dialectRegion: text('dialect_region'),
    offensiveOrSensitive: integer('offensive_or_sensitive').notNull(),
    generalFrequencyRank: integer('general_frequency_rank'),
    domainFrequencyScore: real('domain_frequency_score').notNull(),
    contextualDiversityScore: real('contextual_diversity_score').notNull(),
    reusePotentialScore: real('reuse_potential_score').notNull(),
    extractionConfidence: real('extraction_confidence').notNull(),
    definitionConfidence: real('definition_confidence').notNull(),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    unique().on(
      t.profileId,
      t.targetLanguage,
      t.normalizedForm,
      t.itemType,
      t.senseKey,
    ),
  ],
);

export const constructionPatterns = sqliteTable('construction_patterns', {
  itemId: text('item_id').primaryKey(),
  slotsJson: text('slots_json').notNull(),
  functionalExplanation: text('functional_explanation').notNull(),
});

/** Forms are never collapsed into the canonical form — the canonical form is a label,
 *  not a replacement. */
export const itemForms = sqliteTable(
  'item_forms',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id').notNull(),
    surfaceForm: text('surface_form').notNull(),
    normalizedForm: text('normalized_form').notNull(),
    grammaticalFeaturesJson: text('grammatical_features_json'),
    occurrenceCount: integer('occurrence_count').notNull(),
  },
  (t) => [unique().on(t.itemId, t.surfaceForm)],
);

/**
 * Keyed to `sentenceId`, not a transcript segment: occurrences are found in
 * reconstructed sentences, which may span several segments.
 *
 * Invariant: exactly one `isPrimaryOccurrence` row per item, enforced by a partial
 * unique index. Deleting a video removes its occurrences but never the item.
 */
export const itemOccurrences = sqliteTable('item_occurrences', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull(),
  videoId: text('video_id').notNull(),
  sentenceId: text('sentence_id').notNull(),
  startMs: integer('start_ms').notNull(),
  endMs: integer('end_ms').notNull(),
  surfaceForm: text('surface_form').notNull(),
  sentenceText: text('sentence_text').notNull(),
  precedingText: text('preceding_text'),
  followingText: text('following_text'),
  extractionConfidence: real('extraction_confidence'),
  isPrimaryOccurrence: integer('is_primary_occurrence').notNull(),
});

export const definitions = sqliteTable('definitions', {
  id: text('id').primaryKey(),
  itemId: text('item_id').notNull(),
  provider: text('provider').notNull(),
  providerEntryId: text('provider_entry_id'),
  senseId: text('sense_id'),
  definition: text('definition').notNull(),
  translation: text('translation'),
  register: text('register'),
  region: text('region'),
  /** A definition with no dictionary evidence is unverified and cannot be presented as
   *  confident (§16.2, §14.9). */
  evidenceJson: text('evidence_json'),
  confidence: real('confidence'),
  isUserEdited: integer('is_user_edited').notNull(),
  modelId: text('model_id'),
  promptVersion: text('prompt_version'),
  createdAt: integer('created_at').notNull(),
});

/** Replaces the translation scalars, which hardcoded a single native language into the
 *  item model. MVP writes one language (ADR 0010). */
export const itemTranslations = sqliteTable(
  'item_translations',
  {
    id: text('id').primaryKey(),
    itemId: text('item_id').notNull(),
    language: text('language').notNull(),
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    source: text('source').notNull(),
    isUserEdited: integer('is_user_edited').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [unique().on(t.itemId, t.language, t.kind)],
);

/** The six per-skill state objects from §17 are NOT columns here — they are projected
 *  from `cards`. `pronunciation` and `contextualUse` are stored, since those two are
 *  practice-only and have no card. */
export const learnerItemStates = sqliteTable(
  'learner_item_states',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    itemId: text('item_id').notNull(),
    knownProbability: real('known_probability').notNull(),
    struggleScore: real('struggle_score').notNull(),
    lapseCount: integer('lapse_count').notNull(),
    sourceDependenceScore: real('source_dependence_score').notNull(),
    transferSuccessRate: real('transfer_success_rate'),
    markedKnown: integer('marked_known').notNull(),
    suspended: integer('suspended').notNull(),
    starred: integer('starred').notNull(),
    pronunciationStateJson: text('pronunciation_state_json'),
    contextualUseStateJson: text('contextual_use_state_json'),
    lastSeenAt: integer('last_seen_at'),
    lastUsedAt: integer('last_used_at'),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [unique().on(t.profileId, t.itemId)],
);
