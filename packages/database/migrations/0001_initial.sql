-- 0001_initial — the complete schema from docs/contracts/02-database.md.
--
-- Hand-authored, forward-only, reviewed before commit. §3 rule 1 forbids applying an
-- auto-generated diff at startup without review, so this file is the authority and the
-- Drizzle definitions in src/schema/ mirror it.
--
-- Conventions (02-database.md, preamble):
--   - Primary keys are text ULIDs unless noted.
--   - Timestamps are integer epoch milliseconds. SQLite has no date type and storing
--     text dates invites comparison bugs.
--   - `*_json` columns hold validated JSON; every one has a schema in code and is
--     parsed, not trusted.
--   - Every learner-scoped table carries `profile_id`. MVP has one profile, but
--     retrofitting this later is a painful migration for no benefit.
--
-- Cascade policy (01-domain-model.md §7 invariant 5): deleting a video cascades to its
-- transcript, sentences, occurrences, and candidates — but NOT to approved learning
-- items, which survive with their remaining occurrences. Foreign keys are enforced
-- (PRAGMA foreign_keys = ON in src/client.ts), so these clauses are load-bearing.

-- ===================================================================================
-- Profile and interests
-- ===================================================================================

CREATE TABLE profiles (
  id                TEXT PRIMARY KEY,
  native_language   TEXT    NOT NULL,
  target_language   TEXT    NOT NULL,
  proficiency_label TEXT,
  learning_purpose  TEXT,
  daily_minutes     INTEGER NOT NULL DEFAULT 20,
  new_item_limit    INTEGER NOT NULL DEFAULT 10,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE interests (
  id         TEXT PRIMARY KEY,
  profile_id TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  -- 1..5: how much the user cares about the topic. Distinct from
  -- video_interests.relevance, which is how much a video is about it.
  weight     INTEGER NOT NULL CHECK (weight BETWEEN 1 AND 5),
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_interests_profile ON interests(profile_id);

-- ===================================================================================
-- Videos and transcripts
-- ===================================================================================

CREATE TABLE videos (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  source_type        TEXT NOT NULL,
  external_video_id  TEXT NOT NULL,
  url                TEXT NOT NULL,
  title              TEXT,
  target_language    TEXT NOT NULL,
  duration_ms        INTEGER,
  speaker_label      TEXT,
  region_label       TEXT,
  transcript_status  TEXT NOT NULL DEFAULT 'none',
  processing_status  TEXT NOT NULL DEFAULT 'none',
  estimated_coverage REAL,
  difficulty_label   TEXT,
  pipeline_version   TEXT,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  -- Stage 2's duplicate-video detection is this constraint, not application logic.
  UNIQUE (profile_id, source_type, external_video_id)
);

CREATE TABLE video_interests (
  video_id    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  interest_id TEXT NOT NULL REFERENCES interests(id) ON DELETE CASCADE,
  -- 0..1: how much this video is about that topic.
  relevance   REAL NOT NULL CHECK (relevance BETWEEN 0 AND 1),
  PRIMARY KEY (video_id, interest_id)
);

CREATE TABLE transcript_files (
  id                  TEXT PRIMARY KEY,
  video_id            TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  format              TEXT NOT NULL
                        CHECK (format IN ('vtt','srt','pasted_timestamped','internal_json')),
  original_filename   TEXT,
  storage_path        TEXT,
  checksum            TEXT NOT NULL,
  parser_version      TEXT NOT NULL,
  parse_warnings_json TEXT,
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_transcript_files_video ON transcript_files(video_id);

-- Never mutated after ingestion. Corrections live in transcript_corrections, so that
-- the original evidence and the §22.5 quality signal both survive.
CREATE TABLE transcript_segments (
  id              TEXT PRIMARY KEY,
  video_id        TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms        INTEGER NOT NULL,
  end_ms          INTEGER NOT NULL,
  speaker_label   TEXT,
  raw_text        TEXT    NOT NULL,
  normalized_text TEXT    NOT NULL,
  confidence      REAL,
  sequence_index  INTEGER NOT NULL,
  UNIQUE (video_id, sequence_index)
);
CREATE INDEX idx_transcript_segments_video_time ON transcript_segments(video_id, start_ms);

CREATE TABLE transcript_corrections (
  id                    TEXT PRIMARY KEY,
  video_id              TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  transcript_segment_id TEXT NOT NULL
                          REFERENCES transcript_segments(id) ON DELETE CASCADE,
  before_text           TEXT,
  after_text            TEXT,
  before_start_ms       INTEGER,
  after_start_ms        INTEGER,
  before_end_ms         INTEGER,
  after_end_ms          INTEGER,
  created_at            INTEGER NOT NULL
);
CREATE INDEX idx_transcript_corrections_segment
  ON transcript_corrections(transcript_segment_id);

CREATE TABLE sentences (
  id                  TEXT PRIMARY KEY,
  video_id            TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  start_ms            INTEGER NOT NULL,
  end_ms              INTEGER NOT NULL,
  text                TEXT    NOT NULL,
  normalized_text     TEXT    NOT NULL,
  complexity_score    REAL,
  language_confidence REAL,
  token_count         INTEGER NOT NULL DEFAULT 0,
  sequence_index      INTEGER NOT NULL,
  UNIQUE (video_id, sequence_index)
);
CREATE INDEX idx_sentences_video_time ON sentences(video_id, start_ms);

CREATE TABLE sentence_segments (
  sentence_id           TEXT    NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  transcript_segment_id TEXT    NOT NULL
                          REFERENCES transcript_segments(id) ON DELETE CASCADE,
  sequence_index        INTEGER NOT NULL,
  PRIMARY KEY (sentence_id, transcript_segment_id)
);

-- The observed tier for multiword expressions, and immutable. Because any span is
-- reconstructible from (sentence_id, sequence_index range), no span rows are needed —
-- see ngram_observations for the one thing that cannot be recomputed.
--
-- head_index and dep_relation carry the dependency parse and are load-bearing, not
-- optional: MWE generation runs on the dependency graph rather than the token sequence,
-- because German separable verbs are discontinuous (ADR 0009).
CREATE TABLE tokens (
  id                 TEXT PRIMARY KEY,
  sentence_id        TEXT    NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  video_id           TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sequence_index     INTEGER NOT NULL,
  surface            TEXT    NOT NULL,
  normalized         TEXT    NOT NULL,
  lemma              TEXT,
  pos                TEXT,
  morph_json         TEXT,
  head_index         INTEGER,
  dep_relation       TEXT,
  is_entity          INTEGER NOT NULL DEFAULT 0 CHECK (is_entity IN (0,1)),
  entity_type        TEXT,
  start_char         INTEGER,
  end_char           INTEGER,
  start_ms           INTEGER,
  end_ms             INTEGER,
  is_target_language INTEGER NOT NULL DEFAULT 1 CHECK (is_target_language IN (0,1)),
  UNIQUE (sentence_id, sequence_index)
);
CREATE INDEX idx_tokens_video_lemma ON tokens(video_id, lemma);
CREATE INDEX idx_tokens_lemma ON tokens(lemma);

-- ===================================================================================
-- Observed tier (ADR 0008)
-- ===================================================================================

-- Language-scoped, not profile-scoped: the saturation curve is a property of a language
-- and a corpus rather than of a learner, a second profile should not duplicate the pool,
-- and cross-language concept linking needs language-scoped units as its substrate.
-- Learner-specific state joins from known_lexicon at read time.
CREATE TABLE observed_units (
  id                   TEXT PRIMARY KEY,
  target_language      TEXT    NOT NULL,
  lemma                TEXT    NOT NULL,
  normalized_form      TEXT    NOT NULL,
  pos                  TEXT    NOT NULL,
  unit_type            TEXT    NOT NULL,
  first_seen_video_id  TEXT    REFERENCES videos(id) ON DELETE SET NULL,
  first_seen_at        INTEGER NOT NULL,
  video_count          INTEGER NOT NULL DEFAULT 0,
  total_count          INTEGER NOT NULL DEFAULT 0,
  score                REAL,
  score_breakdown_json TEXT,
  scored_at            INTEGER,
  -- Marks units needing rescore after a material learner-state change, so
  -- RESCORE_OBSERVATIONS works incrementally rather than sweeping the whole pool.
  is_dirty             INTEGER NOT NULL DEFAULT 1 CHECK (is_dirty IN (0,1)),
  updated_at           INTEGER NOT NULL,
  UNIQUE (target_language, lemma, pos)
);
CREATE INDEX idx_observed_units_score ON observed_units(target_language, score DESC);
CREATE INDEX idx_observed_units_dirty ON observed_units(is_dirty) WHERE is_dirty = 1;

CREATE TABLE observed_unit_occurrences (
  id               TEXT    PRIMARY KEY,
  observed_unit_id TEXT    NOT NULL REFERENCES observed_units(id) ON DELETE CASCADE,
  video_id         TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sentence_id      TEXT    NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  token_index      INTEGER NOT NULL,
  surface_form     TEXT    NOT NULL,
  start_ms         INTEGER,
  end_ms           INTEGER
);
CREATE INDEX idx_observed_occ_unit ON observed_unit_occurrences(observed_unit_id);
CREATE INDEX idx_observed_occ_video ON observed_unit_occurrences(video_id);

-- The observed tier for MWEs, and deliberately not a span table: a span is a view over
-- `tokens`. What this adds is an accumulated cross-video recurrence count, avoiding a
-- rescan on every ingest. It is a materialized index, not an irreplaceable record — any
-- write policy is reversible by a backfill that re-derives spans, which is what makes
-- the write threshold a performance decision rather than a recall decision.
--
-- `score` holds UNITHOOD (06-scoring.md §9.1), not importance. This follows from the
-- key: the table has no profile_id, so it structurally cannot hold a learner-specific
-- number. Importance is computed at promotion.
CREATE TABLE ngram_observations (
  id                     TEXT    PRIMARY KEY,
  target_language        TEXT    NOT NULL,
  hash                   TEXT    NOT NULL,
  lemma_seq              TEXT    NOT NULL,
  n                      INTEGER NOT NULL,
  video_count            INTEGER NOT NULL DEFAULT 0,
  total_count            INTEGER NOT NULL DEFAULT 0,
  promotion_source       TEXT    NOT NULL
                           CHECK (promotion_source IN
                             ('gazetteer','contiguous','dependency','recurrence','llm')),
  first_seen_video_id    TEXT    REFERENCES videos(id) ON DELETE SET NULL,
  first_seen_sentence_id TEXT    REFERENCES sentences(id) ON DELETE SET NULL,
  first_seen_at          INTEGER NOT NULL,
  last_seen_at           INTEGER NOT NULL,
  score                  REAL,
  score_breakdown_json   TEXT,
  is_dirty               INTEGER NOT NULL DEFAULT 1 CHECK (is_dirty IN (0,1)),
  -- Nullable until enrichment runs. idiomaticity_verified is true only for a dictionary
  -- hit, per the rule that the dictionary is the lexical authority.
  idiomaticity           REAL,
  idiomaticity_evidence  TEXT
                           CHECK (idiomaticity_evidence IS NULL
                                  OR idiomaticity_evidence IN
                                     ('dictionary','embedding','llm','none')),
  idiomaticity_verified  INTEGER NOT NULL DEFAULT 0
                           CHECK (idiomaticity_verified IN (0,1)),
  UNIQUE (target_language, hash)
);
CREATE INDEX idx_ngram_obs_score ON ngram_observations(target_language, score DESC);
CREATE INDEX idx_ngram_obs_dirty ON ngram_observations(is_dirty) WHERE is_dirty = 1;

-- ===================================================================================
-- Candidates
-- ===================================================================================

-- A candidate is a PROMOTED observed unit, not everything the pipeline found (ADR 0008).
-- Exactly one of observed_unit_id or ngram_observation_id is set.
--
-- score_breakdown_json is not optional: §36.3 requires the user to be able to inspect
-- ranking, and under ADR 0008 the score decides visibility — so an unexplained score is
-- an unexplained absence.
--
-- rejection_reason is written ONLY by human action. The pipeline no longer rejects on
-- value.
CREATE TABLE candidates (
  id                    TEXT PRIMARY KEY,
  profile_id            TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  observed_unit_id      TEXT REFERENCES observed_units(id) ON DELETE SET NULL,
  ngram_observation_id  TEXT REFERENCES ngram_observations(id) ON DELETE SET NULL,
  video_id              TEXT REFERENCES videos(id) ON DELETE CASCADE,
  canonical_form        TEXT NOT NULL,
  normalized_form       TEXT NOT NULL,
  proposed_type         TEXT NOT NULL
                          CHECK (proposed_type IN
                            ('word','multiword_expression','construction')),
  proposed_sense        TEXT,
  score                 REAL,
  score_breakdown_json  TEXT,
  extraction_confidence REAL,
  definition_confidence REAL,
  status                TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN
                            ('pending','approved','rejected','deferred','quarantined','merged')),
  rejection_reason      TEXT
                          CHECK (rejection_reason IS NULL OR rejection_reason IN
                            ('already_know','too_rare','proper_name','bad_phrase_boundary',
                             'bad_transcript','bad_definition','not_useful','duplicate','other')),
  merged_into_item_id   TEXT,
  -- When promotion happened; null is impossible for a row in this table.
  surfaced_at           INTEGER NOT NULL,
  surface_reason        TEXT NOT NULL
                          CHECK (surface_reason IN
                            ('queue','video_floor','calibration_probe','user_request')),
  -- Null until ENRICH_CANDIDATE completes. A promoted-but-unenriched candidate is valid
  -- and visible, marked as awaiting enrichment (§27.4).
  enriched_at           INTEGER,
  pipeline_version      TEXT,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  CHECK ((observed_unit_id IS NULL) <> (ngram_observation_id IS NULL))
);
-- The queue: global, ranked by importance DESC, across all videos (03-api.md §4.0).
CREATE INDEX idx_candidates_queue ON candidates(profile_id, status, score DESC);
CREATE INDEX idx_candidates_video ON candidates(video_id);

CREATE TABLE candidate_occurrences (
  id           TEXT    PRIMARY KEY,
  candidate_id TEXT    NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  sentence_id  TEXT    NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  start_ms     INTEGER NOT NULL,
  end_ms       INTEGER NOT NULL,
  surface_form TEXT    NOT NULL,
  confidence   REAL
);
CREATE INDEX idx_candidate_occ_candidate ON candidate_occurrences(candidate_id);

-- ===================================================================================
-- Learning items
-- ===================================================================================

-- Identity is (target language, canonical form, sense, item type). Homonyms with
-- different meanings are separate items; sense_key is the disambiguator.
CREATE TABLE learning_items (
  id                        TEXT PRIMARY KEY,
  profile_id                TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_language           TEXT NOT NULL,
  canonical_form            TEXT NOT NULL,
  normalized_form           TEXT NOT NULL,
  lemma                     TEXT,
  item_type                 TEXT NOT NULL
                              CHECK (item_type IN
                                ('word','multiword_expression','construction')),
  sense_key                 TEXT NOT NULL,
  part_of_speech            TEXT,
  meaning                   TEXT NOT NULL,
  -- Translations are NOT columns here — see item_translations (ADR 0010). Scalars would
  -- hardcode a single native language into the item model.
  register                  TEXT NOT NULL DEFAULT 'neutral'
                              CHECK (register IN
                                ('neutral','formal','informal','slang','vulgar',
                                 'technical','literary','archaic')),
  dialect_region            TEXT,
  offensive_or_sensitive    INTEGER NOT NULL DEFAULT 0
                              CHECK (offensive_or_sensitive IN (0,1)),
  general_frequency_rank    INTEGER,
  domain_frequency_score    REAL NOT NULL DEFAULT 0,
  contextual_diversity_score REAL NOT NULL DEFAULT 0,
  reuse_potential_score     REAL NOT NULL DEFAULT 0,
  extraction_confidence     REAL NOT NULL DEFAULT 0,
  definition_confidence     REAL NOT NULL DEFAULT 0,
  status                    TEXT NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','suspended','archived')),
  created_at                INTEGER NOT NULL,
  updated_at                INTEGER NOT NULL,
  UNIQUE (profile_id, target_language, normalized_form, item_type, sense_key)
);
CREATE INDEX idx_learning_items_profile_status ON learning_items(profile_id, status);

-- Slots are stored structurally, not only as text. Stage 8 requires this.
CREATE TABLE construction_patterns (
  item_id                TEXT PRIMARY KEY REFERENCES learning_items(id) ON DELETE CASCADE,
  slots_json             TEXT NOT NULL,
  functional_explanation TEXT NOT NULL
);

-- Forms are never collapsed into the canonical form — the canonical form is a label, not
-- a replacement.
CREATE TABLE item_forms (
  id                        TEXT    PRIMARY KEY,
  item_id                   TEXT    NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  surface_form              TEXT    NOT NULL,
  normalized_form           TEXT    NOT NULL,
  grammatical_features_json TEXT,
  occurrence_count          INTEGER NOT NULL DEFAULT 0,
  UNIQUE (item_id, surface_form)
);

-- sentence_id, not transcript_segment_id: occurrences are found in reconstructed
-- sentences, which may span several segments (01-domain-model.md §5, RESOLVED).
--
-- Invariant: exactly one is_primary_occurrence = 1 per item. Deleting the primary
-- promotes the next-highest-confidence occurrence. Deleting a video removes its
-- occurrences but never the item (invariant 5).
CREATE TABLE item_occurrences (
  id                    TEXT    PRIMARY KEY,
  item_id               TEXT    NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  video_id              TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  sentence_id           TEXT    NOT NULL REFERENCES sentences(id) ON DELETE CASCADE,
  start_ms              INTEGER NOT NULL,
  end_ms                INTEGER NOT NULL,
  surface_form          TEXT    NOT NULL,
  sentence_text         TEXT    NOT NULL,
  preceding_text        TEXT,
  following_text        TEXT,
  extraction_confidence REAL,
  is_primary_occurrence INTEGER NOT NULL DEFAULT 0
                          CHECK (is_primary_occurrence IN (0,1))
);
CREATE INDEX idx_item_occ_item ON item_occurrences(item_id);
CREATE INDEX idx_item_occ_video ON item_occurrences(video_id);
CREATE UNIQUE INDEX idx_item_occ_one_primary
  ON item_occurrences(item_id) WHERE is_primary_occurrence = 1;

CREATE TABLE definitions (
  id                TEXT PRIMARY KEY,
  item_id           TEXT NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  provider          TEXT NOT NULL,
  provider_entry_id TEXT,
  sense_id          TEXT,
  definition        TEXT NOT NULL,
  translation       TEXT,
  register          TEXT,
  region            TEXT,
  -- A definition with no dictionary evidence is unverified and cannot be presented as
  -- confident (§16.2, §14.9).
  evidence_json     TEXT,
  confidence        REAL,
  is_user_edited    INTEGER NOT NULL DEFAULT 0 CHECK (is_user_edited IN (0,1)),
  model_id          TEXT,
  prompt_version    TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX idx_definitions_item ON definitions(item_id);

-- Replaces the naturalTranslation/literalTranslation scalars, which hardcoded a single
-- native language into the item model. MVP writes one language (ADR 0010).
CREATE TABLE item_translations (
  id             TEXT PRIMARY KEY,
  item_id        TEXT NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  language       TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('natural','literal')),
  text           TEXT NOT NULL,
  source         TEXT NOT NULL,
  is_user_edited INTEGER NOT NULL DEFAULT 0 CHECK (is_user_edited IN (0,1)),
  created_at     INTEGER NOT NULL,
  UNIQUE (item_id, language, kind)
);

-- ===================================================================================
-- Learner state
-- ===================================================================================

-- The six per-skill state objects from §17 are NOT columns here — they are projected
-- from `cards`, which is the single authority for scheduling (01-domain-model.md §2.1).
-- pronunciation and contextual_use ARE stored, since those two are practice-only and
-- have no card.
CREATE TABLE learner_item_states (
  id                        TEXT    PRIMARY KEY,
  profile_id                TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id                   TEXT    NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  known_probability         REAL    NOT NULL DEFAULT 0,
  struggle_score            REAL    NOT NULL DEFAULT 0,
  lapse_count               INTEGER NOT NULL DEFAULT 0,
  source_dependence_score   REAL    NOT NULL DEFAULT 0,
  transfer_success_rate     REAL,
  marked_known              INTEGER NOT NULL DEFAULT 0 CHECK (marked_known IN (0,1)),
  suspended                 INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0,1)),
  starred                   INTEGER NOT NULL DEFAULT 0 CHECK (starred IN (0,1)),
  pronunciation_state_json  TEXT,
  contextual_use_state_json TEXT,
  last_seen_at              INTEGER,
  last_used_at              INTEGER,
  updated_at                INTEGER NOT NULL,
  UNIQUE (profile_id, item_id)
);

-- "Mark known" must update learner state WITHOUT creating cards, and §22.1 coverage is
-- computed over all eligible tokens rather than just items — neither is expressible
-- through learner_item_states, which requires an item_id.
CREATE TABLE known_lexicon (
  id              TEXT PRIMARY KEY,
  profile_id      TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_language TEXT NOT NULL,
  lemma           TEXT NOT NULL,
  normalized_form TEXT NOT NULL,
  p_known         REAL NOT NULL CHECK (p_known BETWEEN 0 AND 1),
  source          TEXT NOT NULL
                    CHECK (source IN
                      ('frequency_prior','placement','user_marked','review_derived')),
  updated_at      INTEGER NOT NULL,
  UNIQUE (profile_id, target_language, lemma)
);

-- The fallback prior for any lemma with no known_lexicon row.
CREATE TABLE known_frequency_bands (
  profile_id      TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_language TEXT    NOT NULL,
  band            INTEGER NOT NULL,
  p_known         REAL    NOT NULL CHECK (p_known BETWEEN 0 AND 1),
  updated_at      INTEGER NOT NULL,
  PRIMARY KEY (profile_id, target_language, band)
);

-- Raw responses are kept so bands can be re-derived when the band model changes.
CREATE TABLE placement_results (
  id                 TEXT PRIMARY KEY,
  profile_id         TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  mode               TEXT NOT NULL CHECK (mode IN ('fast','calibrated')),
  administered_at    INTEGER NOT NULL,
  items_json         TEXT,
  responses_json     TEXT,
  derived_bands_json TEXT
);

-- ===================================================================================
-- Cards and review
-- ===================================================================================

-- prompt_language / answer_language are a forward-compatibility hook (ADR 0010). In MVP
-- the pair is always (target, native) and nothing varies it. They are in the key from
-- the first migration because direction-aware FSRS state cannot be retrofitted —
-- splitting one schedule into several after the fact loses the history.
--
-- There is no transfer card type: transfer is a presentation mode recorded in
-- reviews.context_mode. Pronunciation imitation is a practice exercise, not a card.
CREATE TABLE cards (
  id                       TEXT PRIMARY KEY,
  profile_id               TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  item_id                  TEXT NOT NULL REFERENCES learning_items(id) ON DELETE CASCADE,
  card_type                TEXT NOT NULL
                             CHECK (card_type IN
                               ('audio_recognition','contextual_cloze','productive_recall')),
  prompt_language          TEXT NOT NULL,
  answer_language          TEXT NOT NULL,
  prompt_template_version  TEXT,
  status                   TEXT NOT NULL DEFAULT 'active',
  fsrs_state_json          TEXT,
  due_at                   INTEGER,
  last_reviewed_at         INTEGER,
  suspended_at             INTEGER,
  created_at               INTEGER NOT NULL,
  UNIQUE (profile_id, item_id, card_type, prompt_language, answer_language)
);
CREATE INDEX idx_cards_due ON cards(profile_id, status, due_at);

CREATE TABLE review_sessions (
  id                  TEXT    PRIMARY KEY,
  profile_id          TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  started_at          INTEGER NOT NULL,
  completed_at        INTEGER,
  desired_minutes     INTEGER,
  include_new_items   INTEGER NOT NULL DEFAULT 1 CHECK (include_new_items IN (0,1)),
  include_video_loop  INTEGER NOT NULL DEFAULT 0 CHECK (include_video_loop IN (0,1)),
  include_transfer    INTEGER NOT NULL DEFAULT 0 CHECK (include_transfer IN (0,1)),
  include_error_repair INTEGER NOT NULL DEFAULT 0 CHECK (include_error_repair IN (0,1)),
  plan_json           TEXT,
  summary_json        TEXT
);

-- Append-only (§3 rule 4). Nothing in the codebase deletes or rewrites a review except
-- full-data deletion (§29.9).
--
-- occurrence_id records WHICH occurrence was shown, so transfer can be verified rather
-- than asserted.
CREATE TABLE reviews (
  id                     TEXT PRIMARY KEY,
  session_id             TEXT REFERENCES review_sessions(id) ON DELETE SET NULL,
  card_id                TEXT REFERENCES cards(id) ON DELETE SET NULL,
  item_id                TEXT REFERENCES learning_items(id) ON DELETE SET NULL,
  video_id               TEXT REFERENCES videos(id) ON DELETE SET NULL,
  card_type              TEXT NOT NULL,
  context_mode           TEXT NOT NULL DEFAULT 'source'
                           CHECK (context_mode IN ('source','transfer')),
  shown_at               INTEGER NOT NULL,
  answered_at            INTEGER,
  response_text          TEXT,
  response_latency_ms    INTEGER,
  machine_classification TEXT,
  user_rating            TEXT,
  scheduler_rating       TEXT
                           CHECK (scheduler_rating IS NULL OR scheduler_rating IN
                             ('again','hard','good','easy')),
  hint_count             INTEGER NOT NULL DEFAULT 0,
  source_context_used    INTEGER NOT NULL DEFAULT 0 CHECK (source_context_used IN (0,1)),
  occurrence_id          TEXT REFERENCES item_occurrences(id) ON DELETE SET NULL,
  created_at             INTEGER NOT NULL
);
CREATE INDEX idx_reviews_session ON reviews(session_id);
CREATE INDEX idx_reviews_card ON reviews(card_id, created_at);
CREATE INDEX idx_reviews_item ON reviews(item_id, created_at);

-- Rows are created only when the user explicitly saves (§32.4). Unsaved recordings never
-- touch disk.
CREATE TABLE recordings (
  id             TEXT    PRIMARY KEY,
  review_id      TEXT    REFERENCES reviews(id) ON DELETE CASCADE,
  temporary_path TEXT    NOT NULL,
  duration_ms    INTEGER,
  saved_by_user  INTEGER NOT NULL DEFAULT 1 CHECK (saved_by_user IN (0,1)),
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER
);

CREATE TABLE video_loop_sessions (
  id                   TEXT    PRIMARY KEY,
  profile_id           TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  video_id             TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  review_session_id    TEXT    REFERENCES review_sessions(id) ON DELETE SET NULL,
  start_ms             INTEGER NOT NULL,
  end_ms               INTEGER NOT NULL,
  comprehension_before INTEGER,
  comprehension_after  INTEGER,
  main_idea_text       TEXT,
  summary_1_text       TEXT,
  summary_2_text       TEXT,
  target_item_ids_json TEXT,
  created_at           INTEGER NOT NULL,
  completed_at         INTEGER
);

-- ===================================================================================
-- Recommendations
-- ===================================================================================

CREATE TABLE recommendations (
  id                  TEXT PRIMARY KEY,
  profile_id          TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  video_id            TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  recommendation_type TEXT NOT NULL,
  start_ms            INTEGER,
  end_ms              INTEGER,
  score               REAL,
  -- §36.6 requires recommendations to be explainable, so an unexplained one is a bug.
  reason_json         TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending',
  created_at          INTEGER NOT NULL
);
CREATE INDEX idx_recommendations_profile ON recommendations(profile_id, status, score DESC);

CREATE TABLE recommendation_feedback (
  id                TEXT PRIMARY KEY,
  recommendation_id TEXT NOT NULL REFERENCES recommendations(id) ON DELETE CASCADE,
  feedback          TEXT NOT NULL
                      CHECK (feedback IN
                        ('helpful','not_helpful','too_easy','too_difficult',
                         'wrong_transcript','wrong_item_association','do_not_recommend_again')),
  created_at        INTEGER NOT NULL
);

-- ===================================================================================
-- Operations
-- ===================================================================================

-- claimed_by / claimed_at support the single-worker claim loop and let a crashed
-- worker's jobs be reclaimed after a timeout.
CREATE TABLE jobs (
  id            TEXT    PRIMARY KEY,
  job_type      TEXT    NOT NULL,
  entity_type   TEXT,
  entity_id     TEXT,
  status        TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN
                    ('pending','running','succeeded','failed','cancelled','needs_input')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  max_attempts  INTEGER NOT NULL DEFAULT 3,
  priority      INTEGER NOT NULL DEFAULT 0,
  input_json    TEXT,
  output_json   TEXT,
  error_json    TEXT,
  claimed_by    TEXT,
  claimed_at    INTEGER,
  created_at    INTEGER NOT NULL,
  started_at    INTEGER,
  completed_at  INTEGER
);
-- The claim query's ordering: priority DESC, created_at ASC, over pending rows.
CREATE INDEX idx_jobs_claim ON jobs(status, priority DESC, created_at);
CREATE INDEX idx_jobs_entity ON jobs(entity_type, entity_id);
CREATE INDEX idx_jobs_reclaim ON jobs(status, claimed_at);

-- §16.4 requires prompts and outputs recorded locally for diagnostics; §10.7 exposes
-- them in the UI; §31.3 tracks cost per retained item; §38.10 makes tracking a named
-- risk mitigation.
--
-- cost_usd is ALWAYS NULL — all inference is local, so dollars are not the scarce
-- resource. The column stays for schema stability; latency_ms is the live cost signal.
-- Never write a synthesized dollar figure into it.
CREATE TABLE provider_calls (
  id             TEXT PRIMARY KEY,
  provider_kind  TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model_id       TEXT,
  prompt_version TEXT,
  job_id         TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  entity_type    TEXT,
  entity_id      TEXT,
  -- Redaction happens on write, not on read (§32.3).
  request_json   TEXT,
  response_json  TEXT,
  tokens_in      INTEGER,
  tokens_out     INTEGER,
  cost_usd       REAL CHECK (cost_usd IS NULL),
  latency_ms     INTEGER,
  status         TEXT NOT NULL,
  error_json     TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_provider_calls_created ON provider_calls(created_at);
CREATE INDEX idx_provider_calls_job ON provider_calls(job_id);

-- All six versions live together so that "reprocess everything extracted with prompt v3"
-- is answerable (§27.5).
CREATE TABLE pipeline_versions (
  id                          TEXT PRIMARY KEY,
  video_id                    TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  extraction_pipeline_version TEXT,
  language_adapter_version    TEXT,
  prompt_version              TEXT,
  model_id                    TEXT,
  dictionary_provider_version TEXT,
  frequency_dataset_version   TEXT,
  created_at                  INTEGER NOT NULL
);
CREATE INDEX idx_pipeline_versions_video ON pipeline_versions(video_id);

-- API keys are NEVER stored here (§32.3). Under ADR 0005 there are none to store. The
-- prohibition stands regardless, so that a future cloud adapter cannot quietly land a
-- key in a settings row.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
