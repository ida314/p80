# 02 — Database Schema

Source: original spec §28. SQLite, accessed through a typed ORM with explicit migrations.

Conventions:

- Primary keys are text ULIDs unless noted.
- Timestamps are integer epoch milliseconds (SQLite has no date type; storing text dates
  invites comparison bugs).
- `*_json` columns hold validated JSON; every one has a schema in code and is parsed, not
  trusted.
- Every learner-scoped table carries `profile_id`. MVP has one profile, but retrofitting
  this later is a painful migration for no benefit.

---

## 1. Tables from the original spec

### `profiles`
`id`, `native_language`, `target_language`, `proficiency_label`, `learning_purpose`,
`daily_minutes`, `new_item_limit`, `created_at`, `updated_at`

### `interests`
`id`, `profile_id`, `name`, `weight` (1–5), `created_at`

### `videos`
`id`, `profile_id`, `source_type`, `external_video_id`, `url`, `title`,
`target_language`, `duration_ms`, `speaker_label`, `region_label`, `transcript_status`,
`processing_status`, `estimated_coverage`, `difficulty_label`, `pipeline_version`,
`created_at`, `updated_at`

Unique: `(profile_id, source_type, external_video_id)` — this is the duplicate-video
detection required by Stage 2.

### `video_interests`
`video_id`, `interest_id`, `relevance` (0..1)

**RESOLVED:** the original spec puts a `weight` on both `interests` and `video_interests`
without saying how they combine. They mean different things and are now named differently:

```
interests.weight        1..5   how much the user cares about the topic
video_interests.relevance 0..1  how much this video is about that topic

effective_interest_weight(video, interest) = (interests.weight / 5) * video_interests.relevance
```

### `transcript_files`
`id`, `video_id`, `format`, `original_filename`, `storage_path`, `checksum`,
`parser_version`, `parse_warnings_json`, `created_at`

### `transcript_segments`
`id`, `video_id`, `start_ms`, `end_ms`, `speaker_label`, `raw_text`, `normalized_text`,
`confidence`, `sequence_index`

Never mutated after ingestion. Corrections live in `transcript_corrections`.

### `sentences`
`id`, `video_id`, `start_ms`, `end_ms`, `text`, `normalized_text`, `complexity_score`,
`language_confidence`, `token_count`, `sequence_index`

### `sentence_segments`
`sentence_id`, `transcript_segment_id`, `sequence_index`

### `tokens` <!-- ADDED -->
`id`, `sentence_id`, `video_id`, `sequence_index`, `surface`, `normalized`, `lemma`,
`pos`, `morph_json`, `head_index`, `dep_relation`, `is_entity`, `entity_type`,
`start_char`, `end_char`, `start_ms`, `end_ms`, `is_target_language`

Required by Stage 4 (linguistic annotation) and by §22.1 coverage, which is computed over
*all* eligible tokens, not just extracted items. The original spec never gives tokens a
home even though several downstream calculations need them.

`head_index` and `dep_relation` carry the dependency parse. They are **load-bearing, not
optional**: MWE generation runs on the dependency graph rather than the token sequence,
because German separable verbs are discontinuous — *Ich fange um acht Uhr an* splits
`anfangen` across five tokens and no n-gram window recovers it (ADR 0009).

This table is also the **observed tier for multiword expressions**. Because it is immutable,
any span is reconstructible from `(sentence_id, start_index, end_index)`, so no span rows
are needed — see `ngram_observations` below for the one thing that cannot be recomputed.

### `learning_items`
Fields per `01-domain-model.md` §3.
Unique: `(profile_id, target_language, normalized_form, item_type, sense_key)`

### `construction_patterns` <!-- ADDED -->
`item_id`, `slots_json`, `functional_explanation`
Per `01-domain-model.md` §3.2. Stage 8 requires slots to be structural, not textual.

### `item_forms`
`id`, `item_id`, `surface_form`, `normalized_form`, `grammatical_features_json`,
`occurrence_count`

### `item_occurrences`
`id`, `item_id`, `video_id`, `sentence_id`, `start_ms`, `end_ms`, `surface_form`,
`sentence_text`, `preceding_text`, `following_text`, `extraction_confidence`,
`is_primary_occurrence`

### `definitions`
`id`, `item_id`, `provider`, `provider_entry_id`, `sense_id`, `definition`, `translation`,
`register`, `region`, `evidence_json`, `confidence`, `is_user_edited`, `model_id`,
`prompt_version`, `created_at`

### `candidates`
`id`, `profile_id`, `observed_unit_id`, `ngram_observation_id`, `video_id`,
`canonical_form`, `normalized_form`, `proposed_type`, `proposed_sense`, `score`,
`score_breakdown_json`, `extraction_confidence`, `definition_confidence`, `status`,
`rejection_reason`, `merged_into_item_id`, `surfaced_at`, `surface_reason`, `enriched_at`,
`pipeline_version`, `created_at`, `updated_at`

**A candidate is a *promoted* observed unit, not everything the pipeline found** (ADR 0008).
Exactly one of `observed_unit_id` (words) or `ngram_observation_id` (MWEs) is set.

- `surfaced_at` — when promotion happened; null is impossible for a row in this table
- `surface_reason ∈ { queue, video_floor, calibration_probe, user_request }` —
  `07-extraction.md` §6 and §8.1. Probe rows are analysed separately, so this cannot be
  inferred later
- `enriched_at` — null until `ENRICH_CANDIDATE` completes. A promoted-but-unenriched
  candidate is valid and visible, marked as awaiting enrichment (§27.4)

`score_breakdown_json` is not optional. §36.3 requires the user to be able to inspect
ranking components, which is impossible if only the final score is stored — and under
ADR 0008 the score decides visibility, so an unexplained score is an unexplained absence.

`rejection_reason` is written **only by human action**. The pipeline no longer rejects on
value.

### `candidate_occurrences`
`candidate_id`, `sentence_id`, `start_ms`, `end_ms`, `surface_form`, `confidence`

### `learner_item_states`
`id`, `profile_id`, `item_id`, `known_probability`, `struggle_score`, `lapse_count`,
`source_dependence_score`, `transfer_success_rate`, `marked_known`, `suspended`,
`starred`, `last_seen_at`, `last_used_at`, `updated_at`

Per the resolution in `01-domain-model.md` §2.1, the six per-skill state objects from
§17 are **not** columns here. They are projected from `cards`.

`pronunciation_state_json` and `contextual_use_state_json` *are* stored here, since those
two are practice-only and have no card.

### `cards`
`id`, `profile_id`, `item_id`, `card_type`, `prompt_language`, `answer_language`,
`prompt_template_version`, `status`, `fsrs_state_json`, `due_at`, `last_reviewed_at`,
`suspended_at`, `created_at`

`card_type ∈ { audio_recognition, contextual_cloze, productive_recall }` <!-- ADDED -->

Unique: `(profile_id, item_id, card_type, prompt_language, answer_language)`

`prompt_language` / `answer_language` are a **forward-compatibility hook** (ADR 0010). In
MVP the pair is always `(target_language, native_language)` and nothing varies it. They are
in the key from the first migration because direction-aware FSRS state cannot be
retrofitted — "I know DE→EN but not DE→PT" is plausibly a distinct memory, and splitting one
schedule into several after the fact loses the history.

**RESOLVED — transfer is a mode, not a card type.** §19.5 describes a transfer card and
§30.2 selects transfer cards as a distinct category, which reads as a fourth type. But
giving transfer its own FSRS state fragments the memory model for one item across two
schedules and makes §17's `transferSuccessRate` incoherent. Transfer is therefore a
**presentation mode of an existing card**, recorded per review in
`reviews.context_mode`. Pronunciation imitation is a practice exercise, not a card
(§19.4), and has no row here.

### `reviews`
`id`, `session_id`, `card_id`, `item_id`, `video_id`, `card_type`, `context_mode`,
`shown_at`, `answered_at`, `response_text`, `response_latency_ms`,
`machine_classification`, `user_rating`, `scheduler_rating`, `hint_count`,
`source_context_used`, `occurrence_id`, `created_at`

`context_mode ∈ { source, transfer }` <!-- ADDED — replaces the spec's `transfer_context` -->
`occurrence_id` records *which* occurrence was shown, so transfer can be verified rather
than asserted.

### `recordings`
`id`, `review_id`, `temporary_path`, `duration_ms`, `saved_by_user`, `created_at`,
`expires_at`

Rows are created only when the user explicitly saves (§32.4). Unsaved recordings never
touch disk.

### `recommendations`
`id`, `profile_id`, `video_id`, `recommendation_type`, `start_ms`, `end_ms`, `score`,
`reason_json`, `status`, `created_at`

### `jobs`
`id`, `job_type`, `entity_type`, `entity_id`, `status`, `attempt_count`, `max_attempts`,
`priority`, `input_json`, `output_json`, `error_json`, `claimed_by`, `claimed_at`,
`created_at`, `started_at`, `completed_at`

`claimed_by` / `claimed_at` support the single-worker claim loop and let a crashed
worker's jobs be reclaimed after a timeout.

### `settings`
`key`, `value_json`, `updated_at`

API keys are **never** stored here (§32.3) — they are read from `.env.local` only.

---

## 2. Tables missing from the original spec

Each of these is required by behaviour the spec mandates elsewhere.

### `observed_units` <!-- ADDED -->
`id`, `target_language`, `lemma`, `normalized_form`, `pos`, `unit_type`,
`first_seen_video_id`, `first_seen_at`, `video_count`, `total_count`, `score`,
`score_breakdown_json`, `scored_at`, `is_dirty`, `updated_at`

Unique: `(target_language, lemma, pos)`

The **observed tier** for single words (ADR 0008): every eligible lexical unit in every
processed video, captured completely and cheaply. Deliberately minimal — key, counters, and
score. No definition, no translation, no LLM output. Richer data is fetched on promotion.

**Language-scoped, not profile-scoped.** Three reasons: the saturation curve is a property
of a language and a corpus rather than of a learner; a second profile should not duplicate
the pool; and cross-language concept linking (deferred, ADR 0010) needs language-scoped
units as its substrate. Learner-specific state joins from `known_lexicon` at read time.

`is_dirty` marks units needing rescore after a material learner-state change, so
`RESCORE_OBSERVATIONS` can work incrementally rather than sweeping the whole pool.

### `observed_unit_occurrences` <!-- ADDED -->
`id`, `observed_unit_id`, `video_id`, `sentence_id`, `token_index`, `surface_form`,
`start_ms`, `end_ms`

Links an observed unit to every place it was seen. Distinct from `item_occurrences`, which
exists only for approved items and carries `isPrimaryOccurrence` and confidence.

### `ngram_observations` <!-- ADDED; REVISED: ADR 0011 -->
`id`, `target_language`, `hash`, `lemma_seq`, `n`, `video_count`, `total_count`,
`promotion_source`, `first_seen_video_id`, `first_seen_sentence_id`, `first_seen_at`,
`last_seen_at`, `score`, `score_breakdown_json`, `is_dirty`,
`idiomaticity`, `idiomaticity_evidence`, `idiomaticity_verified`

Unique: `(target_language, hash)`

The **observed tier for MWEs**, and deliberately not a span table. A span is a *view* over
`tokens`, reconstructible from `(sentence_id, start_index, end_index)` — so nothing is lost
by declining to store it. What this table adds is an accumulated **cross-video recurrence**
count, avoiding a rescan on every ingest.

**This table is a materialized index over `tokens`, not an irreplaceable record.** ADR 0009
described recurrence as impossible to recompute; that is true at ingest time but not
permanently, since `tokens` is immutable, every past video is local, and `head_index` /
`dep_relation` are stored. Any write policy is reversible by a backfill that re-derives
spans and rebuilds the counts. This is what makes the write threshold
(`07-extraction.md` §14) a performance decision rather than a recall decision, and it is the
guarantee that no expression is permanently lost.

`score` holds **unithood** (`06-scoring.md` §9.1) — *is this a reusable unit* — not
importance. This follows from the key: the table has no `profile_id`, so it structurally
cannot hold a learner-specific number. Importance (`06-scoring.md` §2) is computed at
promotion, when the candidate becomes profile-scoped.

`idiomaticity` (`06-scoring.md` §9.2) is nullable until enrichment runs.
`idiomaticity_evidence ∈ { dictionary, embedding, llm, none }`; `idiomaticity_verified` is
true only for a dictionary hit, per the rule that the dictionary is the lexical authority.

`promotion_source ∈ { gazetteer, contiguous, dependency, recurrence, llm }` records which
funnel layer surfaced it (`07-extraction.md` §10.3), so layer precision is measurable
individually rather than only in aggregate. It also selects the shrinkage prior in §9.1.

This table is also the saturation curve for expressions, directly queryable — which is why
rows are demoted by score rather than deleted by judgment.

### `item_translations` <!-- ADDED -->
`id`, `item_id`, `language`, `kind`, `text`, `source`, `is_user_edited`, `created_at`

`kind ∈ { natural, literal }`

Replaces the `naturalTranslation` and `literalTranslation` scalars on `learning_items`,
which hardcoded a single native language into the item model. Forward-compatibility hook
for laddering (ADR 0010) — free now, a migration plus backfill later. MVP writes one
language.

### `review_sessions` <!-- ADDED -->
`id`, `profile_id`, `started_at`, `completed_at`, `desired_minutes`, `include_new_items`,
`include_video_loop`, `include_transfer`, `include_error_repair`, `plan_json`,
`summary_json`

**Why:** §29.6 defines `/api/review/session/:id/*` endpoints and §30 defines session
composition, but §28 has nowhere to store a session. Without it, `reviews` cannot be
grouped and no session-level metric in §31 is computable.

### `known_lexicon` <!-- ADDED -->
`id`, `profile_id`, `target_language`, `lemma`, `normalized_form`, `p_known`, `source`,
`updated_at`

`source ∈ { frequency_prior, placement, user_marked, review_derived }`

**Why (two reasons):**
1. §25.2 "Mark known" must update learner state *without* creating cards — but
   `learner_item_states` requires an `item_id`, so a marked-known word that never becomes
   an item has nowhere to live.
2. §22.1 lexical coverage is `known_tokens / eligible_tokens` over the whole transcript.
   Most eligible tokens will never be learning items, so coverage cannot be computed from
   `learner_item_states` at all.

### `known_frequency_bands` <!-- ADDED -->
`profile_id`, `target_language`, `band`, `p_known`, `updated_at`

The fallback prior for any lemma with no `known_lexicon` row. Initialized by placement
(§11.2), updated by review outcomes (§17.1).

### `placement_results` <!-- ADDED -->
`id`, `profile_id`, `mode`, `administered_at`, `items_json`, `responses_json`,
`derived_bands_json`

**Why:** §11.2 defines fast and calibrated placement modes whose output initializes
`P(known)` by frequency band, with no storage defined. Keeping the raw responses allows
re-derivation when the band model changes.

### `video_loop_sessions` <!-- ADDED -->
`id`, `profile_id`, `video_id`, `review_session_id`, `start_ms`, `end_ms`,
`comprehension_before`, `comprehension_after`, `main_idea_text`, `summary_1_text`,
`summary_2_text`, `target_item_ids_json`, `created_at`, `completed_at`

**Why:** Stage 11 step 11 says "store video-loop session results" and §36.5 requires
before-and-after comprehension to be recorded. No table exists for either.

### `provider_calls` <!-- ADDED -->
`id`, `provider_kind`, `provider`, `model_id`, `prompt_version`, `job_id`, `entity_type`,
`entity_id`, `request_json`, `response_json`, `tokens_in`, `tokens_out`, `cost_usd`,
`latency_ms`, `status`, `error_json`, `created_at`

**Why:** §16.4 requires prompts and outputs to be recorded locally for diagnostics, §10.7
exposes prompt and output inspection in the UI, §31.3 tracks LLM cost per retained item,
and §38.10 makes cost tracking a named risk mitigation. All four need this table.

**Redaction:** API keys must never appear in `request_json` (§32.3). Redaction happens on
write, not on read.

### `transcript_corrections` <!-- ADDED -->
`id`, `video_id`, `transcript_segment_id`, `before_text`, `after_text`,
`before_start_ms`, `after_start_ms`, `before_end_ms`, `after_end_ms`, `created_at`

**Why:** §22.5 uses "user correction count" as a transcript-quality signal, and Stage 2
requires manual timestamp correction. Mutating `transcript_segments` in place would
destroy both the original evidence and the quality signal.

### `recommendation_feedback` <!-- ADDED -->
`id`, `recommendation_id`, `feedback`, `created_at`

`feedback ∈ { helpful, not_helpful, too_easy, too_difficult, wrong_transcript,
wrong_item_association, do_not_recommend_again }`

**Why:** §24.4 defines seven feedback values and §36.6 requires feedback to alter future
recommendations. `recommendations.status` alone cannot carry this.

### `pipeline_versions` <!-- ADDED -->
`id`, `video_id`, `extraction_pipeline_version`, `language_adapter_version`,
`prompt_version`, `model_id`, `dictionary_provider_version`, `frequency_dataset_version`,
`created_at`

**Why:** §27.5 requires all six versions to be stored so results can be reprocessed and
compared. Scattering them across `videos` and `candidates` makes "reprocess everything
extracted with prompt v3" unanswerable.

---

## 3. Migration rules

1. Migrations are explicit, numbered, forward-only files. No auto-generated diff applied
   at startup without review.
2. Migrations run automatically on API start (Stage 1 exit criterion) but are checked
   into source control first.
3. Any migration that drops or rewrites a column takes a backup first
   (`db:backup` is a Stage 1 deliverable).
4. Review history (`reviews`, `review_sessions`) is append-only. Nothing in the codebase
   deletes or rewrites it except full-data deletion (§29.9).
