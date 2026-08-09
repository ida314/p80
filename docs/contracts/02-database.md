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
<!-- ADDED: ADR 0015, ADR 0018. Migration 0002. -->
`media_path`, `content_hash`, `media_missing`, `media_bytes`

Unique: `(profile_id, source_type, external_video_id)` — this is the duplicate-video
detection required by Stage 2.

<!-- ADDED: ADR 0018 -->
**Identity is content; location is a path.** `external_video_id` holds the SHA-256 of the
file's bytes, so the unique constraint above becomes content-based duplicate detection with
no change to it. `media_path` is the locator, stored **relative to `P80_MEDIA_ROOT`** — an
absolute path would break the moment the library moved, which is the class of event this
design exists to survive.

```
external_video_id   sha256 hex, 64 chars. Empty until the ingest job computes it.
media_path          relative to P80_MEDIA_ROOT. Repairable; never an identity.
media_missing       the file was not there last time P80 looked.
media_bytes         size at ingest. Cheap mismatch check before re-hashing.
url                 display locator only. NOT canonical, NOT dereferenced, never fetched.
```

A rename repairs `media_path` and keeps everything. A re-encode hashes differently and is a
new video, which is correct: its timings no longer match the existing transcript. Re-pointing
verifies the hash and refuses a mismatch with both values named — accepting it would silently
rebind a transcript to audio it does not match.

`media_missing` never cascades. The transcript, word array, items, and review history do not
need the bytes; only playback does.

**Adding a video is two-phase.** The API writes the row with a path and no hash; the ingest
job fills in `content_hash`, `media_bytes`, and `duration_ms`, then transcribes. A duplicate
is therefore detected in the worker, and resolves by pointing the second path at the existing
video rather than by failing an insert.

<!-- ADDED: not in original spec -->
**The two status vocabularies.** Neither spec §28 nor this document named their values,
and Stage 2 is the first code that writes them. Both columns are `TEXT NOT NULL DEFAULT
'none'`, so `'none'` is a member of each.

```
transcript_status   none | parsing | ready | failed
processing_status   none | transcript_ready | queued | processing | complete | failed
```

Legal `transcript_status` moves, and nothing else:

```
none    → parsing            an upload was accepted and a parse enqueued
parsing → ready | failed     the worker finished, one way or the other
ready   → parsing            replacement re-parses
failed  → parsing            replacement, or an operator retry
*       → none               the transcript was deleted
```

`none → ready` is illegal: it would mean segments appeared without a parse.

**Both are enforced in code rather than by a CHECK constraint**, in four layers: the const
arrays in `packages/core/src/domain.ts`; a single write path (`setTranscriptStatus`) that
asserts the table above; `z.enum(...)` in the API response schemas, so a rogue stored value
fails serialization loudly instead of reaching a client; and a repository test. A CHECK
could police *membership* only, and membership is not what goes wrong — transitions are.
Raw SQL can therefore still write an unlisted value, which the repository test documents
deliberately.

<!-- REVISED: migration 0002 was the "next migration", and the CHECKs still did not land.
     The reason turned out to be a hazard rather than a preference. -->
**The two CHECKs are permanently deferred, and this is why.** SQLite cannot add a CHECK to
an existing table; it requires the 12-step rebuild. `DROP TABLE videos` under
`PRAGMA foreign_keys = ON` — which `client.ts` sets — performs an implicit DELETE that
**fires `ON DELETE CASCADE` on every child table**, destroying every transcript, segment,
correction, sentence, token, and occurrence. `PRAGMA defer_foreign_keys` does not help: it
defers constraint *violations*, not cascade *actions*, and `PRAGMA foreign_keys` is a no-op
inside a transaction, which is where every migration runs.

Landing them safely needs a migration runner that can take a file outside its transaction
and toggle the pragma around it. That is real machinery for a constraint that polices
membership only. Migration 0002 carries the same warning at the top, because the tempting
next move is to "just add the CHECK".

Stage 2 writes only `none` and `transcript_ready` to `processing_status`. The remaining
four are declared now so Stage 4 does not have to reopen the vocabulary — the same pattern
`MEDIA_SOURCE_KINDS` uses for its deferred members.

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
<!-- ADDED: ADR 0016, ADR 0017. Migration 0002. -->
`source`, `timing_granularity`, `asr_model_id`, `asr_alignment_model_id`,
`detected_language`, `language_probability`

```
source              asr | upload
timing_granularity  word | cue
```

**`source` is load-bearing for Stage 4, not bookkeeping.** ADR 0013 keys
`punct_confidence` on where a transcript came from: a model that punctuated with prosodic
access to the audio and a scraped auto-caption track with no punctuation at all are not
equally reliable evidence of a sentence ending. The weight is chosen from this column and
measured against the ADR 0006 corpus.

`storage_path` is null for `source = 'asr'` — there is no uploaded file. `checksum` is over
the canonical serialization of the ASR result, so a re-run is comparable.

### `transcript_words` <!-- ADDED: ADR 0017. Migration 0002. -->
`id`, `video_id`, `transcript_file_id`, `word_index`, `text`, `start_ms`, `end_ms`,
`confidence`

Unique: `(transcript_file_id, word_index)`.

**Where a transcript has word timing, this table is the source of truth** and
`transcript_segments` are index ranges over it. ASR writes it once; nothing downstream
rewrites it. The denormalised text and timing on `transcript_segments` exist for
debuggability and for queries, and are rebuilt from the indices rather than edited — an
index range cannot desynchronise from the timing its text is bound to, and every alternative
can.

Populated only when `transcript_files.timing_granularity = 'word'`. Uploaded VTT and SRT
carry no word timing and never will, which is why the tier is a stored column rather than
something inferred from the absence of rows: consumers branch on it, and a capability read
off a missing join is a capability nobody can see in a schema diagram.

### `transcript_segments`
`id`, `video_id`, `start_ms`, `end_ms`, `speaker_label`, `raw_text`, `normalized_text`,
`confidence`, `sequence_index`
<!-- ADDED: ADR 0017. Migration 0002. Null at timing_granularity = 'cue'. -->
`word_start_index`, `word_end_index`

Never mutated after ingestion. Corrections live in `transcript_corrections`.

`word_start_index` / `word_end_index` are a half-open range into `transcript_words`.

**A correction does not rewrite words.** The word array is the original ASR evidence — what
the model heard and when; a correction is the user's reading of what was said. Both are kept
because they answer different questions, and "original data is immutable" is a standing
invariant. The consequence, stated so it is not discovered as a bug: a token span inside a
**corrected** segment falls back to cue timing, because the word alignment no longer indexes
the effective text. One helper in `packages/core` resolves a span against whichever tier
applies, so both fallbacks — corrected segment, and `cue`-tier transcript — live at a single
call site rather than at every consumer.

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

API keys are **never** stored here (§32.3). Under ADR 0005 there are none to store —
inference is local and `.env.local` holds only the vLLM base URL and model ID, which are
config, not secrets. The prohibition stands regardless, so that a future cloud adapter
cannot quietly land a key in a settings row.

<!-- ADDED (ADR 0019): what the table is for. -->
**This is the runtime-configuration override.** `key` is the environment variable's own
name, so a row and a `.env.local` line are visibly the same setting. **The environment
seeds and the row overrides:** a key with no row takes the value `loadConfig()` produced, a
key with a row takes the row, and deleting the row reverts. Every read reports which of the
two it came from, so a value that no longer matches the dotfile reads as overridden rather
than as ignored.

Only some keys are eligible, and the rule is mechanical: **a key is writable only if every
consumer reads it at the point of use.** Ports and the bind host are consumed by `listen()`
before any request exists, so a row for them would be honoured by nothing — and a setting
that silently does nothing is worse than one that is absent. The API refuses those writes
and the surface shows them read-only. `packages/core/src/settings.ts` holds the registry
that decides; it is not a CHECK constraint here, because the eligible set changes with the
code that reads each key and a CHECK would need the 12-step rebuild that migration 0002
warns against to follow along.

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

**`cost_usd` is always `NULL`** <!-- REVISED: ADR 0005 --> — all inference is local, so
dollars are not the scarce resource. The column stays for schema stability; `latency_ms` is
the live cost signal and the denominator of §31.3's cost-per-retained-item. Never write a
synthesized dollar figure into it.

**Redaction:** API keys must never appear in `request_json` (§32.3). Redaction happens on
write, not on read. Under local-only inference there is no key to leak, so this is now a
structural guarantee rather than a discipline — the redaction pass stays anyway, because a
cloud adapter would reintroduce the risk silently.

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
