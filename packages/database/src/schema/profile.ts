import { integer, real, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

/**
 * Typed mirror of `migrations/0001_initial.sql`.
 *
 * The SQL file is the authority (`02-database.md` §3 rule 1 — no auto-generated diff
 * applied without review). These definitions exist so application code is typed, and
 * `test/schema-parity.test.ts` asserts the mirror is faithful by comparing every table
 * and column against SQLite's own introspection. Drift is a test failure, not a
 * discovery made three stages later.
 */

export const profiles = sqliteTable('profiles', {
  id: text('id').primaryKey(),
  nativeLanguage: text('native_language').notNull(),
  targetLanguage: text('target_language').notNull(),
  proficiencyLabel: text('proficiency_label'),
  learningPurpose: text('learning_purpose'),
  dailyMinutes: integer('daily_minutes').notNull(),
  newItemLimit: integer('new_item_limit').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const interests = sqliteTable('interests', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  name: text('name').notNull(),
  weight: integer('weight').notNull(),
  createdAt: integer('created_at').notNull(),
});

export const knownLexicon = sqliteTable(
  'known_lexicon',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id').notNull(),
    targetLanguage: text('target_language').notNull(),
    lemma: text('lemma').notNull(),
    normalizedForm: text('normalized_form').notNull(),
    pKnown: real('p_known').notNull(),
    source: text('source').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [unique().on(t.profileId, t.targetLanguage, t.lemma)],
);

export const knownFrequencyBands = sqliteTable('known_frequency_bands', {
  profileId: text('profile_id').notNull(),
  targetLanguage: text('target_language').notNull(),
  band: integer('band').notNull(),
  pKnown: real('p_known').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const placementResults = sqliteTable('placement_results', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  mode: text('mode').notNull(),
  administeredAt: integer('administered_at').notNull(),
  itemsJson: text('items_json'),
  responsesJson: text('responses_json'),
  derivedBandsJson: text('derived_bands_json'),
});
