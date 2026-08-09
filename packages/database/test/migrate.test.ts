import { afterEach, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * Stage 1 exit criterion 2 — "database migrations run automatically".
 *
 * The table list below is the contract's, not the code's: every table named in
 * `docs/contracts/02-database.md` §1 and §2, including the eleven the original spec
 * omits. If a future migration renames one, this test says so.
 */
const CONTRACTED_TABLES = [
  // §1 — tables from the original spec
  'profiles',
  'interests',
  'videos',
  'video_interests',
  'transcript_files',
  'transcript_segments',
  // ADR 0017, migration 0002. The word array is the source of truth where a transcript
  // has one; segments are index ranges over it.
  'transcript_words',
  'sentences',
  'sentence_segments',
  'tokens',
  'learning_items',
  'construction_patterns',
  'item_forms',
  'item_occurrences',
  'definitions',
  'candidates',
  'candidate_occurrences',
  'learner_item_states',
  'cards',
  'reviews',
  'recordings',
  'recommendations',
  'jobs',
  'settings',
  // §2 — tables missing from the original spec
  'observed_units',
  'observed_unit_occurrences',
  'ngram_observations',
  'item_translations',
  'review_sessions',
  'known_lexicon',
  'known_frequency_bands',
  'placement_results',
  'video_loop_sessions',
  'provider_calls',
  'transcript_corrections',
  'recommendation_feedback',
  'pipeline_versions',
];

let temp: TempDatabase;
afterEach(() => temp?.dispose());

function tableNames(t: TempDatabase): string[] {
  return (
    t.sqlite
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != '_migrations'
          ORDER BY name`,
      )
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe('migrations', () => {
  it('creates every table the contract names', () => {
    temp = createTempDatabase();
    const created = tableNames(temp);
    for (const table of CONTRACTED_TABLES) {
      expect(created, `missing table: ${table}`).toContain(table);
    }
  });

  it('creates no table the contract does not name', () => {
    temp = createTempDatabase();
    expect(tableNames(temp).sort()).toEqual([...CONTRACTED_TABLES].sort());
  });

  it('is a no-op on re-run', () => {
    temp = createTempDatabase({ migrate: false });
    const first = migrate(temp.sqlite);
    expect(first.applied).toEqual(['0001_initial.sql', '0002_local_media.sql']);

    const second = migrate(temp.sqlite);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(['0001_initial.sql', '0002_local_media.sql']);
  });

  it('enforces foreign keys, so the cascade rules are not decorative', () => {
    temp = createTempDatabase();
    expect(temp.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() =>
      temp.sqlite
        .prepare(
          `INSERT INTO interests (id, profile_id, name, weight, created_at)
           VALUES ('i1', 'no-such-profile', 'x', 3, 0)`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it('refuses to run when an applied migration has been edited', () => {
    temp = createTempDatabase();
    temp.sqlite.prepare("UPDATE _migrations SET checksum = 'tampered'").run();
    expect(() => migrate(temp.sqlite)).toThrow(/has changed since it was applied/);
  });
});

describe('contract invariants expressed as constraints', () => {
  it('rejects a second primary occurrence for one item', () => {
    temp = createTempDatabase();
    seedItem(temp);
    insertOccurrence(temp, 'o1', 1);
    expect(() => insertOccurrence(temp, 'o2', 1)).toThrow(/UNIQUE/i);
    // A non-primary sibling is fine.
    expect(() => insertOccurrence(temp, 'o3', 0)).not.toThrow();
  });

  it('keeps approved items alive when their video is deleted (invariant 5)', () => {
    temp = createTempDatabase();
    seedItem(temp);
    insertOccurrence(temp, 'o1', 1);

    temp.sqlite.prepare("DELETE FROM videos WHERE id = 'v1'").run();

    const items = temp.sqlite.prepare('SELECT COUNT(*) AS n FROM learning_items').get() as {
      n: number;
    };
    const occurrences = temp.sqlite
      .prepare('SELECT COUNT(*) AS n FROM item_occurrences')
      .get() as { n: number };

    expect(items.n).toBe(1);
    expect(occurrences.n).toBe(0);
  });

  it('refuses a candidate that is both a word and an ngram, or neither', () => {
    temp = createTempDatabase();
    seedItem(temp);
    const insert = (observed: string | null, ngram: string | null) =>
      temp.sqlite
        .prepare(
          `INSERT INTO candidates
             (id, profile_id, observed_unit_id, ngram_observation_id, canonical_form,
              normalized_form, proposed_type, status, surfaced_at, surface_reason,
              created_at, updated_at)
           VALUES (?, 'p1', ?, ?, 'x', 'x', 'word', 'pending', 0, 'queue', 0, 0)`,
        )
        .run(`c-${observed}-${ngram}`, observed, ngram);

    expect(() => insert(null, null)).toThrow(/CHECK/i);
  });

  it('refuses a synthesized dollar figure in provider_calls', () => {
    temp = createTempDatabase();
    expect(() =>
      temp.sqlite
        .prepare(
          `INSERT INTO provider_calls
             (id, provider_kind, provider, cost_usd, status, created_at)
           VALUES ('pc1', 'llm', 'vllm', 0.02, 'ok', 0)`,
        )
        .run(),
    ).toThrow(/CHECK/i);
  });
});

function seedItem(t: TempDatabase): void {
  t.sqlite.exec(`
    INSERT INTO profiles (id, native_language, target_language, daily_minutes,
                          new_item_limit, created_at, updated_at)
      VALUES ('p1', 'en', 'de', 20, 10, 0, 0);
    INSERT INTO videos (id, profile_id, source_type, external_video_id, url,
                        target_language, transcript_status, processing_status,
                        created_at, updated_at)
      VALUES ('v1', 'p1', 'youtube_embedded', 'abc', 'https://x', 'de', 'none', 'none', 0, 0);
    INSERT INTO sentences (id, video_id, start_ms, end_ms, text, normalized_text,
                           token_count, sequence_index)
      VALUES ('s1', 'v1', 0, 1000, 'Hallo Welt', 'hallo welt', 2, 0);
    INSERT INTO learning_items (id, profile_id, target_language, canonical_form,
                                normalized_form, item_type, sense_key, meaning, register,
                                offensive_or_sensitive, domain_frequency_score,
                                contextual_diversity_score, reuse_potential_score,
                                extraction_confidence, definition_confidence, status,
                                created_at, updated_at)
      VALUES ('li1', 'p1', 'de', 'Welt', 'welt', 'word', 'world', 'world', 'neutral',
              0, 0, 0, 0, 0, 0, 'active', 0, 0);
  `);
}

function insertOccurrence(t: TempDatabase, id: string, primary: 0 | 1): void {
  t.sqlite
    .prepare(
      `INSERT INTO item_occurrences
         (id, item_id, video_id, sentence_id, start_ms, end_ms, surface_form,
          sentence_text, is_primary_occurrence)
       VALUES (?, 'li1', 'v1', 's1', 0, 1000, 'Welt', 'Hallo Welt', ?)`,
    )
    .run(id, primary);
}
