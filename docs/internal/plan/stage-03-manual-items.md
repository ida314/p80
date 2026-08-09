# Stage 3 — Manual learning-item prototype

**Milestone:** M1
**Depends on:** Stage 2 (a video with a transcript and playable media)
**Spec reference:** `docs/original_spec.md` §35, Stage 3

## Objective

A user selects transcript text by hand, describes it, and gets a scheduled review loop:
three card types, FSRS due dates, sibling burying, source-clip playback, and an inspectable
history. **No extraction automation.** At the end of this stage the whole product works
end to end with a human standing in for the pipeline — which is what makes the pipeline
falsifiable when it arrives in Stage 4.

## Contracts in scope

Read before starting:

- `docs/contracts/05-cards-and-review.md` — card specs, ratings, FSRS, siblings, session
  generation, keyboard map. The authority for everything in this stage.
- `docs/contracts/01-domain-model.md` §2, §3, §5, §7 — item identity, `senseKey`,
  `ItemOccurrence`, the seven invariants.
- `docs/contracts/02-database.md` — `learning_items`, `item_occurrences`, `definitions`,
  `item_translations`, `cards`, `reviews`, `review_sessions`, `sentences`.
- `docs/contracts/03-api.md` §5, §6.

May be changed by this stage (with an ADR):

- `docs/contracts/03-api.md` §5 — gains `POST /api/items` (see Decisions, below).
- `docs/contracts/01-domain-model.md` §5 — gains the manual-occurrence anchoring note.

**Must not be changed by this stage:**

- The `cards` unique key or `fsrs_state_json` as the single scheduling authority. Nothing
  here stores a second copy of a due date outside `cards.due_at`.
- `reviews` append-only. No update path, no delete path.
- Admission scoring. Stage 3 has no scorer and must not invent one — see Decisions.

## Decisions

Three questions the contracts do not answer, resolved here and recorded in **ADR 0020**.

### 1. What does a manual occurrence anchor to?

`item_occurrences.sentence_id` is `NOT NULL REFERENCES sentences(id) ON DELETE CASCADE`,
and `sentences` is Stage 4's output. Relaxing the column needs SQLite's 12-step rebuild,
which `STATUS.md` already records as destructive under `PRAGMA foreign_keys = ON`.

**Resolution:** creating an item materialises one `sentences` row per touched transcript
segment — `sequence_index` = the segment's own, text from the segment, plus its
`sentence_segments` link. Segment-as-sentence is a real if crude reconstruction, and it is
exactly what Stage 4 replaces. The occurrence's denormalised `sentence_text` carries the
full selected context, so a selection spanning two segments still displays correctly.

**The constraint this places on Stage 4 is the important half:** sentence reconstruction
must reconcile with existing rows and relink occurrences. A `DELETE FROM sentences WHERE
video_id = ?` cascades into `item_occurrences` and silently destroys hand-made items,
leaving `learning_items` rows with no occurrence — a violation of invariant 2 that nothing
currently detects. ADR 0020 states this; Stage 4's brief must restate it.

### 2. Where do manual items come from, API-shaped?

`03-api.md` §5 has no create endpoint because items arrive by candidate approval, which
is Stage 5. Stage 3 adds `POST /api/items` with the selection in the body. It is not a
back door around hard rule 6: rule 6 forbids a *candidate* becoming an item without an
explicit user action, and this endpoint is nothing but an explicit user action.

`senseKey` is required and has neither a dictionary sense nor an LLM gloss to derive from,
so it is slugified from the user's meaning text. A collision on
`(profile, language, normalized_form, item_type, sense_key)` returns `409` naming the
existing item, and the user distinguishes the sense by hand. Losing a distinction silently
is the failure mode invariant 4 exists to prevent.

### 3. What goes in the five NOT NULL score columns?

`extraction_confidence` is `1.0` — a human selected the span; there was no extraction to be
uncertain about. `definition_confidence` is `1.0` with `definitions.provider = 'user'` and
`is_user_edited = 1`, rendered as *user-authored*, never as *verified*: hard rule 11 makes
the dictionary the lexical authority, and a user-written gloss carries no dictionary
evidence.

The three ranking scores — `domain_frequency_score`, `contextual_diversity_score`,
`reuse_potential_score` — are **0**, and this is a placeholder, not a judgement. A manual
item bypasses admission entirely, so nothing in Stage 3 reads them. They become live when
Stage 6 can compute them. Recorded because a zero that means *unscored* and a zero that
means *worthless* are indistinguishable in the column, and Stage 9's adaptive admission is
where that would first bite.

## Steps

Spec §35 Stage 3, adjusted for the repo as it stands.

- [x] 1. Transcript-text selection in the web transcript view, resolved to a segment span.
- [x] 2. `POST /api/items` — create item + occurrence + segment-derived sentence rows.
- [x] 3. Creation form: canonical form, item type, meaning, translation, register.
- [x] 4. Occurrence timestamps from the selection; word-level where ADR 0017 gives them,
       cue-bounded otherwise, and the difference is shown rather than absorbed.
- [x] 5. Generate the audio-recognition card.
- [x] 6. Generate the contextual-cloze card.
- [x] 7. Generate the productive-recall card.
- [x] 8. Card preview — shown on creation rather than on an item page, because that is the
       moment the user's card choices produced something.
- [x] 9. Source-clip playback in review, pre-roll/post-roll adjustable per request.
- [x] 10. Answer reveal, separate from the rating (`answer` then `rate`, §6).
- [x] 11. Four ratings, keyboard `1..4`.
- [x] 12. `ts-fsrs` 5.4.1, defaults, no parameter optimisation.
- [x] 13. `reviews` written for every rep, append-only.
- [x] 14. Sibling burying in the session builder — §6's four rules.
- [x] 15. Due-card dashboard on Today, plus a seven-day burden forecast.
- [x] 16. New-item limit from `profile.new_item_limit`, counting items and not cards.

Session generation implements §9's selection order steps **1, 2, and 5** only — overdue
lapse, due, new. Struggle repair, transfer, and the fluency task need Stages 9, 11, and 12
and are out of scope, not forgotten.

## Exit criteria

| # | Criterion | Verified by | State |
|---|---|---|---|
| 1 | A user can manually create an item | `apps/api/test/items-create.test.ts` (17) | **pass** |
| 2 | Each card type works | `packages/core/test/card-generation.test.ts` (13); renders is manual M1 | **pass / M1** |
| 3 | Review ratings update due dates | `packages/core/test/scheduler.test.ts` (10), `review-session.test.ts` | **pass** |
| 4 | Same-item siblings do not appear consecutively | `packages/core/test/session-builder.test.ts` (23) | **pass** |
| 5 | Source clip can be replayed during review | window: `review-session.test.ts`; playback is manual M2 | **server pass / M2** |
| 6 | Review history is inspectable | `apps/api/test/review-session.test.ts` | **pass** |

Plus the invariants this stage is the first to be able to break:

| # | Criterion | Verified by | State |
|---|---|---|---|
| 7 | Exactly one primary occurrence per item | `packages/database/test/items-repository.test.ts` (6) | **pass** |
| 8 | `reviews` has no update or delete path | `packages/database/test/reviews-append-only.test.ts` (4) | **pass** |
| 9 | A full session completes over `curl` alone (ADR 0007) | `scripts/smoke.sh` — 75/75 live | **pass** |
| 10 | New-item limit counts items, not cards | `session-builder.test.ts` + `smoke.sh` | **pass** |
| 11 | Deleting a video archives its orphaned items | `apps/api/test/items-create.test.ts` | **pass** |

## Explicitly out of scope

- **Candidate inbox, observed pool, scoring.** Stages 5–6. Nothing here computes a score.
- **LLM grading** (§4's step 2). `reviews.machine_classification` stays null in MVP Stage 3;
  the learner's rating is the only one written.
- **Transfer mode.** `reviews.context_mode` is written as `source` throughout. Transfer
  needs a second occurrence from a second video, which needs a library.
- **Video loop.** Stage 11, despite `video_loop_sessions` existing since migration 0001.
- **Recordings.** Productive recall accepts typed input only in Stage 3; `MediaRecorder`
  and hard rule 16's save-only-on-request path arrive with the fluency work.
- **FSRS parameter optimisation.** Deferred to post-MVP Phase G by `05-cards-and-review.md` §5.
- **TUI item management.** ADR 0007 assigns items to the TUI, but the creation surface is
  a transcript selection, which is a browser act. The TUI gets a read-only `p80 items` so
  the surface exists; the inbox arrives in Stage 5 with the framework decision.

## Risks

- **§38.1 card explosion.** Three cards per item, and Stage 3 has no adaptive admission.
  Contained by the new-item limit being the only tap and by there being no automatic item
  source yet — the user types every one.
- **§38.6 review overload.** Same containment, plus §8 rule 1: burden over the session
  budget stops new items. Rules 2–4 need the learner model and are Stage 9.
- **A silent sixth config bug.** Five so far, all in the same family. The new cross-process
  surface here is the FSRS state round-trip: `ts-fsrs` objects carry `Date`s, SQLite stores
  integers, and the API and worker both read `cards`. Pin the serialization with a test
  that round-trips through the database rather than through memory.

## Manual checks

Each is a sequence with a stated failure condition. They need a browser and the Stage 2
fixture video.

- **M1 — the three card types render.** Create one item from a transcript selection, open
  review, and step through all three cards. *Fails if* any card shows the answer before
  reveal, or if the cloze front does not contain a blank.
- **M2 — source clip replays.** On an audio-recognition card, press `R`. *Fails if*
  playback does not start before the item and stop after it, or if the transcript is
  visible before reveal.
- **M3 — keyboard-only.** Complete a full session touching no pointing device, using the
  §11 map. *Fails if* any action needs a click or if focus is ever invisible.
- **M4 — siblings are buried.** Create one item, start a session, and observe the order.
  *Fails if* two cards from the same item appear consecutively.

## Notes

- **Greedy session building needed one non-obvious tiebreak.** Nine cards across three
  items interleave perfectly, and a first-fit pass could not find the arrangement — it ran
  the last item's cards up against each other and dropped one. Preferring the item with the
  most cards left to place fixes it; it is the standard heuristic for "rearrange a string so
  equal characters are k apart", and the failure mode without it is the same: a solvable
  arrangement reported as impossible.
- **Two §9 constraints became floors rather than rungs on the relaxation ladder.** Siblings
  are never consecutive, and one sentence is never drawn on for more than two items. Both
  started relaxable and both were wrong that way: a session that breaks either is worse
  than a shorter session, so the cards are deferred and counted instead.
- **The sentence cap counts items, not cards.** Counting cards made it impossible for any
  item to receive its full set in one session, which quietly defeats §10's
  two-reps-per-new-item protocol. What §9 guards against is several items drawn from one
  line, not one item's three cards sharing the line they came from.
- **A single-item session plans one card, and the plan says so.** §6 rule 2 — introduce
  siblings on different days — with nothing to put between them. `deferredSiblings` exists
  because "1 card" on its own reads as a bug.
- **A sixth silent bug, and the first that a live run found before a test did.** Deleting a
  video left its items `active` with no occurrence: the foreign keys cascade
  `item_occurrences` away, and nothing set `archived`. The comment in `deleteVideo` claimed
  the schema enforced invariant 5, and the schema does not. Nothing could have caught it
  before this stage — there were no items — and the first smoke run that created one and
  then deleted its video hit it immediately. `DELETE /api/videos/:id` now archives and
  reports `archivedItems`.
- **`smoke.sh` needed two idempotency fixes**, both of which are the product behaving
  correctly. The item identity constraint spans every status, so an item archived by a
  previous run still holds its sense key; and §7's allowance is per *day*, so a second run
  starts from a non-zero count. The fixture is stamped per run and the allowance check is a
  delta.
