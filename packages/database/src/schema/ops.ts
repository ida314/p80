import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const recommendations = sqliteTable('recommendations', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  videoId: text('video_id').notNull(),
  recommendationType: text('recommendation_type').notNull(),
  startMs: integer('start_ms'),
  endMs: integer('end_ms'),
  score: real('score'),
  /** §36.6 requires recommendations to be explainable, so an unexplained one is a bug. */
  reasonJson: text('reason_json').notNull(),
  status: text('status').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const recommendationFeedback = sqliteTable('recommendation_feedback', {
  id: text('id').primaryKey(),
  recommendationId: text('recommendation_id').notNull(),
  feedback: text('feedback').notNull(),
  createdAt: integer('created_at').notNull(),
});

/** `claimedBy` / `claimedAt` support the single-worker claim loop and let a crashed
 *  worker's jobs be reclaimed after a timeout. `availableAt` holds a failed job out of the
 *  pool for its backoff (ADR 0027); null is claimable now. */
export const jobs = sqliteTable('jobs', {
  id: text('id').primaryKey(),
  jobType: text('job_type').notNull(),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  status: text('status').notNull(),
  attemptCount: integer('attempt_count').notNull(),
  maxAttempts: integer('max_attempts').notNull(),
  priority: integer('priority').notNull(),
  inputJson: text('input_json'),
  outputJson: text('output_json'),
  errorJson: text('error_json'),
  claimedBy: text('claimed_by'),
  claimedAt: integer('claimed_at'),
  createdAt: integer('created_at').notNull(),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
  availableAt: integer('available_at'),
});

/**
 * `costUsd` is **always NULL** — all inference is local, so dollars are not the scarce
 * resource. The column stays for schema stability; `latencyMs` is the live cost signal
 * and the denominator of §31.3's cost-per-retained-item. Never write a synthesized
 * dollar figure into it; a CHECK constraint in the migration enforces this.
 *
 * Redaction of `requestJson` happens on write, not on read (§32.3).
 */
export const providerCalls = sqliteTable('provider_calls', {
  id: text('id').primaryKey(),
  providerKind: text('provider_kind').notNull(),
  provider: text('provider').notNull(),
  modelId: text('model_id'),
  promptVersion: text('prompt_version'),
  jobId: text('job_id'),
  entityType: text('entity_type'),
  entityId: text('entity_id'),
  requestJson: text('request_json'),
  responseJson: text('response_json'),
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  costUsd: real('cost_usd'),
  latencyMs: integer('latency_ms'),
  status: text('status').notNull(),
  errorJson: text('error_json'),
  createdAt: integer('created_at').notNull(),
});

/** All six versions live together so that "reprocess everything extracted with prompt
 *  v3" is answerable (§27.5). */
export const pipelineVersions = sqliteTable('pipeline_versions', {
  id: text('id').primaryKey(),
  videoId: text('video_id').notNull(),
  extractionPipelineVersion: text('extraction_pipeline_version'),
  languageAdapterVersion: text('language_adapter_version'),
  promptVersion: text('prompt_version'),
  modelId: text('model_id'),
  dictionaryProviderVersion: text('dictionary_provider_version'),
  frequencyDatasetVersion: text('frequency_dataset_version'),
  createdAt: integer('created_at').notNull(),
});

/** API keys are never stored here (§32.3). Under ADR 0005 there are none to store; the
 *  prohibition stands so a future cloud adapter cannot quietly land one in a row. */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
