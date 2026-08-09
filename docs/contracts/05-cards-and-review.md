# 05 — Cards, Scheduling, and Review Sessions

Source: original spec §18 (SRS), §19 (card specs), §20 (daily protocol), §30 (session
generation).

---

## 1. Principles

1. **Each card has exactly one primary retrieval objective.** A card that tests two things measures neither.
2. **A rep happens before the answer is revealed** (§9.9). Reading a definition or replaying a clip after reveal is exposure, not retrieval, and is not logged as a rep.
3. **Skills schedule independently** (§18.2). Never average audio recognition, cloze, and production into one schedule.
4. **Admission is not scheduling** (§14.13). Priority decides whether an item enters the curriculum and how soon. Memory performance decides when a card is next seen. These
   two must never be wired together.

## 2. Card generation rules (§18.3)

For each approved item:

| Item type | Audio recognition | Contextual cloze | Productive recall |
|---|---|---|---|
| `word` | yes | when a useful source sentence exists | yes |
| `multiword_expression` | yes | yes | yes |
| `construction` | optional — only when the source realization is clear and reusable | yes | yes |

"A useful source sentence" means the surrounding context constrains the answer enough
that the cloze is solvable — not merely that a sentence exists.

Pronunciation imitation (§19.4) is a practice exercise with no card and no schedule.

### 2.1 Card direction <!-- ADDED: forward-compatibility hook, ADR 0010 -->

Every card carries `prompt_language` and `answer_language`, and both are part of its
identity key. **In MVP the pair is always `(target_language, native_language)`** — nothing
varies it, and no UI exposes it.

The fields exist now because direction-aware FSRS state cannot be retrofitted. If cards
ever pair arbitrary languages (laddering, ADR 0010), "I know DE→EN but not DE→PT" is
plausibly a distinct memory and needs its own schedule; splitting one schedule into several
after the fact discards the review history that made it worth keeping.

Laddering itself is explicitly deferred — see ADR 0010 for why, including the 12× card
multiplication and the cross-lingual sense-alignment problem.

## 3. Card specifications

### 3.1 Audio / source-clip recognition (§19.1)

**Objective:** recognize the item in continuous speech.

- **Front:** miniature player, playback beginning shortly before the item, transcript
  hidden. The video image may remain visible; hiding it is a user preference.
  <!-- RESOLVED (ADR 0015): the spec forbade hiding the image because obscuring an embedded
       player breaks its terms. P80 plays a local file the user holds, so the constraint has
       no subject and the choice returns to the user. -->
- **Clip boundaries are exact** where the transcript has word-level timing (ADR 0017), and
  cue-bounded where it does not. The difference is visible to the user rather than silently
  absorbed — a replay that covers a whole line when it was asked for a word is a worse
  answer, not a rounder one.
- **Prompt:** "What does the speaker mean?"
- **Response:** typed meaning optional; a mental answer is permitted; reveal button.
- **Back:** transcript, highlighted item, short meaning, natural translation, wider
  sentence, replay, expand context, source link, rating controls.

Stored per occurrence: `startMs`, `endMs`, configurable pre-roll and post-roll.

### 3.2 Contextual cloze (§19.2)

**Objective:** retrieve a form from its grammatical or lexical context.

```
Front:  I didn't expect to ____ him here.
Back:   run into
```

Back also shows the full source sentence, why the form fits, common alternatives, the
original timestamp, and rating controls. Source playback may be offered *after* the first
attempt, never before — offering it first turns a retrieval into a listening exercise.

### 3.3 Productive recall (§19.3)

**Objective:** produce the target from a meaning, intent, or situation.

```
Front:  Situation: You unexpectedly met your professor downtown.
        Use the target expression.
Back:   I ran into my professor downtown.
```

Input is text, voice, or both. The back must show that the example is **one** possible
answer alongside other acceptable responses — never presented as the only correct
sentence.

### 3.4 Transfer mode (§19.5)

Transfer is a presentation mode of an existing card, not a fourth card type
(see `02-database.md`, `cards`). A rep is transfer when its context is materially
different from the item's primary occurrence:

- a different occurrence from another added video
- a clearly labelled generated sentence
- a personalized situation
- a new cloze context

Transfer reps are not introduced before initial meaning acquisition — concretely, not
before the item has at least two successful non-transfer reps on the relevant card.

## 4. Ratings (§18.5)

| Rating | Applies when |
|---|---|
| **Again** | incorrect, no answer, meaning changed, item not recognized, production unusable |
| **Hard** | correct after a hint, correct with substantial hesitation, partially correct, serious form error but meaning preserved |
| **Good** | correct independently, meaning and form acceptable, normal hesitation |
| **Easy** | immediate, confident, natural, correct in a changed context |

### Grading policy (§18.6)

The MVP never relies solely on automatic semantic grading. The pipeline is:

1. Structured answer check where the answer is checkable (cloze, exact form).
2. Optional LLM classification into one of: *correct and uses target*, *correct but
   avoids target*, *understandable with an error*, *meaning changed*, *no usable response*.
3. The machine recommendation is displayed and stored in `reviews.machine_classification`.
4. **The learner makes the final scheduler rating.** Always.

## 5. Scheduler

`ts-fsrs` (§18.1). Do not write a scheduler.

- The FSRS card object is stored in `cards.fsrs_state_json`; `due_at` is denormalized for
  querying and is always written in the same transaction.
- FSRS parameter optimization is DEFERRED to post-MVP Phase G. MVP uses defaults.
- Ratings map directly: `again → 1`, `hard → 2`, `good → 3`, `easy → 4`.

## 6. Sibling handling (§18.4)

Cards generated from the same item are siblings.

1. Bury siblings until later in the session — never consecutive.
2. Prefer different days for introducing new siblings.
3. Never show a productive-recall card immediately after revealing the same answer on an
   audio-recognition card.
4. Same-session relearning requires **at least five intervening cards**.

These are unit-testable properties of the session builder, and §36.4 makes them a
definition-of-done item.

## 7. New-item allowance (§18.7)

```
default: 10 new learning items per day
hard maximum: 20
```

Adaptive rules:

- Reduce to 5 when due-card burden is high.
- Reduce to 0 when 7-day retention falls below target.
- Reduce when the candidate rejection rate is high (the pipeline is producing noise;
  adding more of it is counterproductive).
- Increase only after retention is stable *and* review time is manageable.

"New learning items per day" counts **items**, not cards. One item introducing three
cards counts once.

## 8. Review burden (§18.8)

```
review_burden = estimated_due_minutes_next_7_days + overdue_minutes
```

When burden exceeds the configured session budget:

1. Stop introducing new items.
2. Prioritize overdue and lapse-prone cards.
3. Avoid showing low-value siblings.
4. Offer suspension of consistently low-value items.

Per-card time estimates come from the learner's own rolling median latency by card type,
falling back to seeded defaults before enough data exists.

## 9. Session generation (§30)

```ts
interface SessionRequest {
  desiredMinutes: number;
  includeNewItems: boolean;
  includeVideoLoop: boolean;
  includeTransfer: boolean;
  includeErrorRepair: boolean;
}
```

### Selection order

1. Overdue lapse cards
2. Due cards
3. Struggling-item repair
4. Transfer cards
5. New cards
6. Optional fluency task

### Constraints

- Never repeat the same item consecutively.
- Never introduce multiple siblings together.
- Do not exceed the estimated time budget by more than 10%.
- Do not introduce new items when burden limits are exceeded.
- Prefer high-priority approved items.
- Prefer a mix of words, expressions, and constructions.
- No more than three consecutive cards from the same video.
- Do not repeatedly test one exact sentence.

The session plan is computed up front and stored in `review_sessions.plan_json`, but
`GET /next` may deviate when a card is failed and requeued. Both the plan and the actual
sequence are recoverable from `reviews`.

## 10. Daily protocol (§20)

Default session: **35–45 minutes**.

| Set | Target | Content |
|---|---|---|
| 1. Due reviews | 15 min, 25–40 reps | one objective per card; immediate feedback; failed cards return after intervening cards; due beats new |
| 2. New items | 10 min, 2 sets × 5 items | 2 successful retrieval reps per item |
| 3. Video loop | 10 min | clip without support → main idea → with transcript → ≤5 items → rewatch → summary |
| 4. Productive transfer | 5 min, 5 reps | changed context, no copying the source sentence |
| 5. Error repair | 5 min, max 3 errors | corrected original → changed example → personal example |

New-item sequence: inspect source occurrence → understand meaning → hide answer →
retrieve → check → review intervening items → retrieve again.

## 11. Accessibility (§33)

Keyboard-only review is a requirement, not an enhancement. Every review action has a
shortcut and a visible focus state; status is never conveyed by color alone; the entire
loop is completable without a microphone.

```
Space  play / pause
R      replay interval
Enter  reveal answer
1..4   Again / Hard / Good / Easy
H      hint
C      expand context
```

Also required: screen-reader labels, transcript resizing, adjustable pre-roll, adjustable
playback speed, reduced-motion mode, high contrast.

## 12. Which client hosts what (ADR 0007)

**Review sessions and the video loop are browser surfaces.** Audio/source-clip recognition
needs a video surface, and a terminal has none. ADR 0015 changed the player and not this
conclusion — the reasoning never depended on which player it was.

Contextual cloze and productive recall are renderable as text, but §30.2 schedules them in
the same session as audio-recognition cards. Splitting them across clients would force a
surface switch mid-session, so they stay in the browser with the rest of review.

The TUI covers the management surfaces — candidate inbox, items, stats, diagnostics, jobs,
settings — which is where most interaction volume actually is. Both clients call the same
API and hold no domain logic: the session plan, the card order, and the schedule are all
computed server-side.
