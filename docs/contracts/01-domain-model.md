# 01 — Domain Model

Source: original spec §9 (terminology), §13 (item model), §15 (function-word policy).

## 1. Terminology

| Term | Definition |
|---|---|
| **Source** | A video, audio recording, or transcript from which language is extracted. In MVP, always a YouTube video plus a user-supplied transcript. |
| **Transcript segment** | One timestamped block of transcript text, as it appeared in the uploaded file. Never modified by the pipeline; corrections are recorded separately. |
| **Sentence** | A reconstructed, syntactically complete utterance. A subtitle line is *not* a sentence; several lines may form one, and one line may contain several. |
| **Learning item** | The canonical object representing something the learner may study. |
| **Surface form** | A form as it actually appears in a source (`ran into him` for the item `run into someone`). |
| **Occurrence** | One appearance of an item in a source, with timestamps and sentence context. |
| **Observed unit** | Every eligible lexical unit found in a processed video. Captured completely and cheaply, never enriched, reachable only through browse and search. The bottom of the three tiers (ADR 0008). |
| **Candidate** | An observed unit **promoted** above the surfacing threshold, enriched, and shown in the inbox awaiting a user decision. Not everything the pipeline found — only what ranking surfaced. |
| **Card** | One retrieval task generated from a learning item. Carries its own schedule. |
| **Rep** | One retrieval attempt made *before* the answer is revealed. Reading a definition is not a rep. |
| **Successful rep** | A retrieval attempt meeting the card's success criteria. |
| **Set** | A group of reps followed by feedback, transition, or rest. |
| **Transfer rep** | A retrieval attempt in a context materially different from the original source occurrence. |

## 2. Enumerations

<!-- ADDED: the original spec uses these types but never enumerates their values. -->

```ts
type LearningItemType =
  | "word"
  | "multiword_expression"
  | "construction";

type Register =
  | "neutral"
  | "formal"
  | "informal"
  | "slang"
  | "vulgar"
  | "technical"
  | "literary"
  | "archaic";

/** Lifecycle of an approved learning item. Learner-specific flags
 *  (markedKnown, starred) live on LearnerItemState, not here. */
type ItemStatus =
  | "active"
  | "suspended"
  | "archived";

type CandidateStatus =
  | "pending"      // awaiting a user decision
  | "approved"     // became a learning item
  | "rejected"     // user declined, with a reason
  | "deferred"     // user postponed the decision
  | "quarantined"  // failed a quality gate; needs review before it can be shown
  | "merged";      // folded into an existing item or another candidate

/** Written ONLY by human action. Under ADR 0008 the pipeline never rejects on value —
 *  "too_rare" and "proper_name" are reasons a person declines an item, not reasons the
 *  extractor discards one. */
type RejectionReason =
  | "already_know"
  | "too_rare"
  | "proper_name"
  | "bad_phrase_boundary"
  | "bad_transcript"
  | "bad_definition"
  | "not_useful"
  | "duplicate"
  | "other";

/** Why a unit was surfaced into the inbox. Probe rows are analysed separately from the
 *  ordinary queue, so this cannot be inferred after the fact. */
type SurfaceReason =
  | "queue"               // ranked above the global threshold
  | "video_floor"         // top-N of a newly ingested video
  | "calibration_probe"   // randomly sampled from the unsurfaced pool (06-scoring §8.2)
  | "user_request";       // user promoted it from browse

/** Which MWE funnel layer surfaced a sequence (07-extraction.md §10.3). Recorded so layer
 *  precision is measurable individually, not only in aggregate, and because it selects the
 *  unithood shrinkage prior (06-scoring.md §9.1). REVISED: ADR 0011. */
type MwePromotionSource =
  | "gazetteer"
  | "contiguous"        // base generator: contiguous sequences, ranked by unithood
  | "dependency"        // extension: path patterns, recovers discontinuity
  | "recurrence"
  | "llm";
```

### 2.1 Skill state — RESOLVED

The original spec places `SkillState` on `LearnerItemState` (§17) *and* an independent
FSRS blob on `cards` (§18.2, §28). Storing scheduling data in both places guarantees
they drift apart.

**Resolution:** the `cards` row is the single authority for scheduling. `SkillState` is a
read-only projection over the card, computed on read, never persisted as a second copy.

```ts
/** Derived view. NOT a stored column. */
interface SkillState {
  cardId: string | null;          // null when the card has not been generated yet
  phase: "not_started" | "learning" | "review" | "relearning" | "suspended";
  dueAt: Date | null;
  lastRating: SchedulerRating | null;
  successCount: number;
  lapseCount: number;
}

/** Practice-only skills. Not scheduled by FSRS in MVP. */
interface PracticeState {
  attemptCount: number;
  lastAttemptAt: Date | null;
  lastSelfRating: "understandable" | "uncertain" | "needs_work" | null;
}

type SchedulerRating = "again" | "hard" | "good" | "easy";
```

## 3. `LearningItem`

```ts
interface LearningItem {
  id: string;
  profileId: string;              // ADDED: MVP is single-profile, but every learner-
                                  // scoped row carries it so multi-profile is not a migration.
  targetLanguage: string;
  canonicalForm: string;
  normalizedForm: string;
  lemma: string | null;
  itemType: LearningItemType;
  senseKey: string;
  partOfSpeech: string | null;
  meaning: string;
  // Translations are NOT scalar fields — see item_translations (ADR 0010).
  // Scalars would hardcode a single native language into the item model.
  register: Register;
  dialectRegion: string | null;
  offensiveOrSensitive: boolean;
  generalFrequencyRank: number | null;
  domainFrequencyScore: number;        // 0..1
  contextualDiversityScore: number;    // 0..1
  reusePotentialScore: number;         // 0..1
  extractionConfidence: number;        // 0..1
  definitionConfidence: number;        // 0..1
  status: ItemStatus;
  createdAt: Date;
  updatedAt: Date;
}
```

### 3.1 Item identity

Two occurrences belong to the same item **only** when all four match:

1. Target language
2. Canonical form (or canonical construction pattern)
3. Intended sense
4. Item type

Homonyms with different meanings are separate items:

```
bank → financial institution
bank → side of a river
```

`senseKey` is the disambiguator. It is a stable, human-readable slug derived from the
selected dictionary sense where one exists, and from a short LLM-proposed gloss where
none does. **Uniqueness constraint:** `(profileId, targetLanguage, normalizedForm, itemType, senseKey)`.

<!-- ADDED: the original spec requires sense separation but never says how senseKey is
     formed or what enforces uniqueness. -->

### 3.1.1 Multiword expression identity <!-- ADDED -->

An MWE's identity is its **lemma sequence**, not its surface span. `ran into him` and
`keep running into` share the sequence `[run, into]` and are the same item.

Because the sequence is derivable from `tokens`, MWEs have no observed-tier span rows —
only a recurrence counter in `ngram_observations`. See ADR 0009 and `07-extraction.md` §10.

**Two scores, not one boolean** <!-- REVISED: ADR 0011 -->. §14.6's six-way disjunction is
retained as evidence, but each test feeds one of two independent scores rather than flipping
a shared flag. A boolean cannot be ranked or inspected, and the two questions are genuinely
separate — *warten auf* is a unit and not an idiom; *ins Gras beißen* is both.

| Score | Asks | Evidence | Computed |
|---|---|---|---|
| **Unithood** | Reusable unit, or arbitrary fragment? | Cohesion (weakest internal split), completeness (branching entropy on both edges), context diversity, lexicalized/formulaic priors | Observation — deterministic |
| **Idiomaticity** | Meaning derivable from the parts? | Dictionary hit, embedding non-compositionality, LLM literal-vs-conventional, grammatical fixedness | Promotion — needs enrichment |

Formulas in `06-scoring.md` §9; pipeline in `07-extraction.md` §10.

Neither score removes a row. Former disqualifiers are now scored: free syntactic combination
(*in der*) falls out of low cohesion, and fragment-of-a-longer-unit (*Fliegen mit einer
Klappe*) out of low completeness. Spans crossing a clause boundary and named entities remain
hard exclusions, because those are validity questions rather than value questions.

**Boundaries are expected to be wrong sometimes.** Annotator disagreement is high, so the
design goal is propose-then-correct-in-one-keystroke rather than first-time correctness.

### 3.2 Constructions

A construction is a `LearningItem` with `itemType: "construction"` whose `canonicalForm`
is a pattern containing at least one fixed component and at least one variable slot.

```
used to + VERB
the reason why + CLAUSE
for + DURATION
not only X but also Y
```

Slots are stored structurally, not only as text:

```ts
interface ConstructionPattern {         // ADDED
  itemId: string;
  slots: Array<{
    index: number;
    kind: "fixed" | "slot";
    text: string | null;                // set when kind === "fixed"
    slotLabel: string | null;           // "VERB", "DURATION", "CLAUSE", "X", "Y"
    constraints: string[];              // POS tags, semantic hints; may be empty
  }>;
  functionalExplanation: string;
}
```

## 4. `ItemForm`

Every observed surface form is stored independently. Forms are never collapsed into the
canonical form — the canonical form is a label, not a replacement.

```ts
interface ItemForm {
  id: string;
  itemId: string;
  surfaceForm: string;
  normalizedForm: string;
  grammaticalFeatures: Record<string, string>;
  occurrenceCount: number;
}
```

## 5. `ItemOccurrence`

```ts
interface ItemOccurrence {
  id: string;
  itemId: string;
  videoId: string;
  sentenceId: string;             // RESOLVED: spec says transcriptSegmentId, but
                                  // occurrences are found in reconstructed sentences,
                                  // which may span several segments. The segment links
                                  // are reachable through sentence_segments.
  startMs: number;
  endMs: number;
  surfaceForm: string;
  sentenceText: string;
  precedingText: string | null;
  followingText: string | null;
  extractionConfidence: number;
  isPrimaryOccurrence: boolean;   // exactly one per item; the occurrence used for the
                                  // default audio-recognition card
}
```

**Invariant:** each item has exactly one `isPrimaryOccurrence = true` row. Deleting the
primary occurrence promotes the next-highest-confidence occurrence.

## 6. Function-word policy (§15)

P80 must **never** globally hide words like *and*, *for*, *to*, or their equivalents.
Every function word gets one of three outcomes:

| Outcome | Meaning | Example |
|---|---|---|
| **Suppress as isolated item** | Not offered as a standalone card. Remains fully present in all context. | `and → translation` |
| **Absorb into a multiword expression** | Becomes part of a larger item. | `wait for`, `look forward to`, `as for` |
| **Teach as a construction** | Becomes a pattern with slots. | `for + duration`, `both X and Y` |

Rules:

- Which parts of speech are suppressed as isolated cards is **language-specific** and
  lives in the language adapter (see `04-providers.md`), never hardcoded in the pipeline.
- Suppression removes the word as a *candidate*, never from sentence text, cloze context,
  or difficulty calculations.
- The candidate inbox must let the user override suppression and promote a suppressed
  word to a full item.

## 7. Invariants

These hold at all times and are worth asserting in tests:

1. No candidate becomes a learning item without an explicit user action (§7.3). There is
   no auto-approval path in MVP, disabled or otherwise.
2. Every `LearningItem` with `status: "active"` has at least one `ItemOccurrence` and at
   least one stored meaning with provenance (see `04-providers.md` §3).
3. Every `ItemOccurrence` timestamp range falls within its video's duration and within
   the timestamp range of its linked sentence.
4. Distinct senses are never merged. Merge operations that would combine two different
   `senseKey` values must fail loudly rather than pick one.
5. Deleting a video cascades to its transcript, sentences, occurrences, and candidates —
   but **not** to approved learning items, which survive with their remaining
   occurrences. An item whose last occurrence is deleted becomes `archived`, not deleted,
   so review history stays interpretable.
