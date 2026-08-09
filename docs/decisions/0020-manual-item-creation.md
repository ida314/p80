# ADR 0020 — Manually created items, and what they anchor to

**Status:** Accepted
**Date:** 2026-08-09
**Amends:** `03-api.md` §5 (adds `POST /api/items`), `01-domain-model.md` §5 (what a manual
occurrence links to)
**Constrains:** Stage 4 sentence reconstruction — see §2, which is the half of this decision
that reaches beyond the stage that made it.

## Context

The learning loop is built before the extraction that feeds it, deliberately: an extraction
pipeline whose output nobody can review is unfalsifiable, so the reviewing comes first and a
human stands in for the pipeline. That means a user selects transcript text by hand and
turns it into a learning item, with cards and a schedule, before any candidate exists.

The data model was designed for the automatic path and does not quite admit the manual one.
Three gaps, each with more than one plausible answer.

## 1. `POST /api/items`

`03-api.md` §5 lists reads and mutations on existing items but no create, because in the
finished system items come from `POST /api/candidates/:id/approve`. The manual path needs
its own entry point.

**Decision: add `POST /api/items`.** The body carries the selection — video, segment span,
character offsets, timings — alongside the fields the user supplies.

This is not an erosion of hard rule 6. That rule says no *candidate* becomes a learning item
without an explicit user action, and its purpose is to keep the pipeline from admitting its
own output. An endpoint whose entire payload is typed by a person is the explicit action the
rule is asking for, not a way around it. What would violate the rule is a later convenience
that posts to this endpoint on the pipeline's behalf; nothing may.

The alternative — synthesising a candidate row and immediately approving it — was rejected.
It would put pipeline-shaped rows in `candidates` that no pipeline produced, giving
`surface_reason` and `score_breakdown_json` no honest value, and it would make the
approval path's audit trail describe a decision the user never saw.

### `senseKey` without a dictionary

`sense_key` is `NOT NULL` and is the disambiguator in the item identity constraint. The
contract derives it from the selected dictionary sense, or from an LLM gloss where there is
none. In this stage there is neither.

**It is slugified from the user's meaning text.** On a collision with an existing item on
`(profile, target_language, normalized_form, item_type, sense_key)`, the request fails with
`409` naming the existing item, and the user restates the meaning or edits the item they
already have.

Auto-suffixing the slug — `bank-2` — was rejected. Two senses that a person described the
same way are more likely one item entered twice than a genuine homonym pair, and the cost
of the two mistakes is asymmetric: a duplicate is a keystroke to merge, while a silently
collapsed distinction is invariant 4's failure mode and is not visible afterwards.

## 2. What an occurrence anchors to

`item_occurrences.sentence_id` is `NOT NULL REFERENCES sentences(id) ON DELETE CASCADE`.
`sentences` is produced by Stage 4's reconstruction, which does not exist yet.

Relaxing the column is not cheap. SQLite cannot alter a constraint in place; it needs the
12-step table rebuild, and `DROP TABLE` under `PRAGMA foreign_keys = ON` performs an
implicit `DELETE` that fires every child cascade. Migration 0002 and `02-database.md`
already carry that warning for the two deferred CHECK constraints.

**Decision: creating an item materialises `sentences` rows from the transcript segments the
selection touches** — one row per segment, `sequence_index` taken from the segment's own, so
the write is idempotent and repeat selections in the same segment reuse the row. The
`sentence_segments` link is written alongside. The occurrence's denormalised `sentence_text`
holds the full selected context, so a selection spanning two segments still displays as one
piece of text.

Segment-as-sentence is a crude reconstruction, not a fake one. It is the null hypothesis
Stage 4 improves on: a subtitle cue is often a sentence and is never *not* transcript.

### The constraint on Stage 4

**Sentence reconstruction must reconcile with existing rows and relink occurrences. It must
not delete and rebuild.** `DELETE FROM sentences WHERE video_id = ?` cascades into
`item_occurrences` and destroys every manually created item's anchor, leaving
`learning_items` rows with no occurrence — a violation of `01-domain-model.md` §7 invariant 2
that no current check would catch, discovered later as items that quietly stopped appearing
in review.

This is recorded here rather than only in a stage brief because the tempting implementation
of a reconstruction job is exactly the destructive one, and by Stage 4 the reason not to
write it will be several months old.

## 3. The five score columns

`domain_frequency_score`, `contextual_diversity_score`, `reuse_potential_score`,
`extraction_confidence`, and `definition_confidence` are all `NOT NULL`, and a manual item
went through neither extraction nor scoring.

| Column | Value | Why |
|---|---|---|
| `extraction_confidence` | `1.0` | A person selected the span. There was no extraction to be uncertain about. |
| `definition_confidence` | `1.0` | The meaning is user-authored, with `definitions.provider = 'user'` and `is_user_edited = 1`. |
| the three ranking scores | `0` | Placeholder. Nothing in the manual path reads them. |

`definition_confidence: 1.0` is a claim about **provenance, not verification**. Hard rule 11
makes the dictionary the lexical authority, and a user-written gloss has no dictionary
evidence, so `evidence_json` is null and the surface renders it *user-authored* — never
*verified*. A confident number and an unverified label are not in tension: the system is
certain about where the text came from and makes no claim about whether it is right.

The three zeros are the unsatisfying part, and they are written down because **a zero
meaning *unscored* and a zero meaning *worthless* are indistinguishable in the column.**
Admission scoring decides whether an item enters the curriculum; a manual item was admitted
by the person who typed it, so nothing consults these before Stage 6 can compute them. The
first place the ambiguity could bite is Stage 9's adaptive admission, which may suspend
low-value items — it must treat a manual item as unscored rather than as scored zero. Adding
a nullable `scored_at` to `learning_items` would make that mechanical, and is the obvious
fix if Stage 9 finds the distinction load-bearing; it is not added now because a column
whose only reader is two milestones away is a column that will be wrong by the time it is
read.

## Consequences

- The manual path exercises `learning_items`, `item_occurrences`, `definitions`,
  `item_translations`, `cards`, `reviews`, and `review_sessions` before any pipeline does,
  which is the point: seven tables get a working reader and writer while a human can still
  check each row by eye.
- Stage 4 inherits a hard constraint from a stage that shipped before it. That is the cost
  of building the loop first, and it is cheaper than the reverse.
- No migration. Every table involved has been in migration 0001 since the contracts were
  extracted.
