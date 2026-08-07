import { integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * `cards` is the single authority for scheduling state. `SkillState` is projected on
 * read, never stored twice.
 *
 * `promptLanguage` / `answerLanguage` are a forward-compatibility hook (ADR 0010). In
 * MVP the pair is always (target, native) and nothing varies it. They are in the unique
 * key from the first migration because direction-aware FSRS state cannot be
 * retrofitted — splitting one schedule into several after the fact loses the history.
 *
 * There is no transfer card type: transfer is a presentation mode recorded in
 * `reviews.contextMode`.
 */
export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    itemId: text('item_id').notNull(),
    cardType: text('card_type').notNull(),
    promptLanguage: text('prompt_language').notNull(),
    answerLanguage: text('answer_language').notNull(),
    promptTemplateVersion: text('prompt_template_version'),
    status: text('status').notNull(),
    fsrsStateJson: text('fsrs_state_json'),
    dueAt: integer('due_at'),
    lastReviewedAt: integer('last_reviewed_at'),
    suspendedAt: integer('suspended_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    unique().on(t.profileId, t.itemId, t.cardType, t.promptLanguage, t.answerLanguage),
  ],
);

export const reviewSessions = sqliteTable('review_sessions', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  startedAt: integer('started_at').notNull(),
  completedAt: integer('completed_at'),
  desiredMinutes: integer('desired_minutes'),
  includeNewItems: integer('include_new_items').notNull(),
  includeVideoLoop: integer('include_video_loop').notNull(),
  includeTransfer: integer('include_transfer').notNull(),
  includeErrorRepair: integer('include_error_repair').notNull(),
  planJson: text('plan_json'),
  summaryJson: text('summary_json'),
});

/**
 * Append-only. Nothing in the codebase deletes or rewrites a review except full-data
 * deletion (§29.9).
 *
 * `occurrenceId` records *which* occurrence was shown, so transfer can be verified
 * rather than asserted.
 */
export const reviews = sqliteTable('reviews', {
  id: text('id').primaryKey(),
  sessionId: text('session_id'),
  cardId: text('card_id'),
  itemId: text('item_id'),
  videoId: text('video_id'),
  cardType: text('card_type').notNull(),
  contextMode: text('context_mode').notNull(),
  shownAt: integer('shown_at').notNull(),
  answeredAt: integer('answered_at'),
  responseText: text('response_text'),
  responseLatencyMs: integer('response_latency_ms'),
  machineClassification: text('machine_classification'),
  userRating: text('user_rating'),
  schedulerRating: text('scheduler_rating'),
  hintCount: integer('hint_count').notNull(),
  sourceContextUsed: integer('source_context_used').notNull(),
  occurrenceId: text('occurrence_id'),
  createdAt: integer('created_at').notNull(),
});

/** Rows exist only when the user explicitly saves (§32.4). Unsaved recordings never
 *  touch disk. */
export const recordings = sqliteTable('recordings', {
  id: text('id').primaryKey(),
  reviewId: text('review_id'),
  temporaryPath: text('temporary_path').notNull(),
  durationMs: integer('duration_ms'),
  savedByUser: integer('saved_by_user').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at'),
});
