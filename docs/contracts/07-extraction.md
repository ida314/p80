# 07 — Extraction Architecture

How language gets from a transcript into the candidate inbox. Source: original spec §14
(pipeline), §27 (jobs), §38.1 (card explosion). This document **diverges from the spec in
two substantive ways**, both recorded in ADR 0008 and marked `RESOLVED` inline below.

---

## 1. The governing principle

**Capture is complete. Ranking decides visibility. Nothing is dropped for being low
value — only for not being a language item at all.**

The spec's §14.10 quality gates reject or quarantine candidates *before* scoring, so only
survivors reach the user. That model is wrong for this product, because the two error
types are not symmetric:

- A **false positive** costs one keystroke and is visible in the inbox.
- A **false negative** is invisible. There is no query for "items that should have been
  proposed but weren't." It cannot be audited, sampled, or noticed.

A pipeline that filters on value trades a recoverable error for an unrecoverable one. A
pipeline that captures everything and ranks makes the same mistakes, but they surface as
*ordering* problems, which are inspectable and fixable.

<!-- RESOLVED: spec §14.10 rejects on value judgments (too rare, proper name, compositional
     phrase, low definition confidence). This contract rejects only on validity and
     converts every value judgment into a ranking signal. See ADR 0008. -->

---

## 2. Three tiers

| Tier | Contents | Row cost | Enriched | Visible |
|---|---|---|---|---|
| **Observed unit** | Every eligible lexical unit in every processed video | Tiny — key:value plus counters | No | Only via explicit browse/search |
| **Candidate** | Promoted above the surfacing threshold | Full | Yes, on promotion | Candidate inbox |
| **Learning item** | User-approved | Full, plus cards | Yes | Items library, review |

Each transition has exactly one trigger:

```
observed → candidate    PROMOTE_CANDIDATES  (ranking + surfacing rule, §6)
candidate → item        explicit user approval (§7.3 — no automatic path)
```

### 2.1 Words and MWEs store differently

This is the central storage insight, and the reason the two item types need separate
treatment rather than a shared threshold:

- **Words** — the unit of deduplication is the **lemma**, which is not derivable from
  anything else. Each needs a row in `observed_units`.
- **MWEs** — the unit of deduplication is a **lemma sequence**, which *is* derivable, from
  `(sentence_id, start_index, end_index)` against the immutable `tokens` table. A span is
  a **view** over data already persisted. Nothing is lost by not writing a span row.

What cannot be recomputed after the fact is **cross-video recurrence** — noticing that a
sequence appeared in video 2 requires having noticed it at the time. That, and only that,
is what `ngram_observations` persists.

### 2.2 Observed units are language-scoped

`observed_units` is keyed `(target_language, lemma, pos)`, not by profile. Learner-specific
state (`P_known`, `learner_need`) lives in `known_lexicon` and is joined at read time.

Three reasons: the saturation curve (§9) is a property of a language and a corpus, not of a
learner; a second profile should not duplicate the pool; and cross-language concept linking
(deferred — ADR 0010) needs language-scoped units as its substrate.

---

## 3. Validity versus value

Every §14.10 condition belongs in exactly one column.

### Validity gates — hard drop, no observed row

These have zero recall cost, because there was no language item to lose.

| Condition | Test |
|---|---|
| Not the target language | `tokens.is_target_language = false` |
| Pure numeral, URL, punctuation, markup residue | Token class from the language adapter |
| Non-lexical token | POS not in the adapter's lexical set |
| Transcription artifact | No dictionary match **and** no successful morphological parse **and** transcript confidence below threshold — all three, never any one alone |

The three-way conjunction on transcription artifacts is deliberate. Any single signal
alone would drop real domain vocabulary: neologisms and loanwords miss the dictionary,
proper nouns miss morphology, and noisy captions depress confidence on perfectly good
words.

### Value signals — rank only, never drop

Each of these lowers `importance` (§5) and nothing more:

- Rare or obscure in general frequency terms
- Proper name without evident domain value
- Ordinary compositional phrase with low reuse
- Low definition confidence
- No dictionary sense plausibly fits the context
- Surrounding context does not disambiguate
- Sentence unusably long for a cloze

The fifth is worth calling out, because it looks like a validity failure and is not. "No
plausible meaning fits" usually means the dictionary is incomplete — a neologism, a loanword,
a domain coinage — which describes a large share of the vocabulary this product exists to
capture. It lowers confidence and nothing more.

### Neither

- **Sensitive or offensive content** — `flagged`, surfaced with a warning. The user decides
  (§12 display uncertainty; §16.5 slang policy).
- **Duplicates** — a *consolidation* operation (§4.2), not a rejection.

`RejectionReason` (`01-domain-model.md` §2) remains unchanged, but is now exclusively a
record of why a **human** rejected something. The pipeline never writes it.

---

## 4. Observation and consolidation

### 4.1 Word observation — `OBSERVE_UNITS`

For every token surviving the validity gates, upsert into `observed_units` on
`(target_language, lemma, pos)` and write one `observed_unit_occurrences` row linking it to
its sentence and timestamps. Increment `total_count`; increment `video_count` only on first
sighting within a given video.

No dictionary lookup. No LLM. This job must stay cheap enough to run over every token of
every video without thought.

### 4.2 Consolidation — `CONSOLIDATE_OBSERVATIONS`

Merges inflected forms, capitalization and punctuation variants, and subtitle-level
differences into the canonical lemma row. Distinct senses are **never** merged
(`01-domain-model.md` §7, invariant 4) — sense separation happens at promotion, when
dictionary evidence exists.

---

## 5. Scoring

Ranking happens on observed units, **before** any enrichment. Full formulas live in
`06-scoring.md` §2; the architectural points here are:

1. **Three importance axes stay separate.** Importance in the *language*, in the *video*,
   and to the *user* pull apart — *Techno* has low general frequency and maximum video
   centrality; *und* is the reverse. Collapsing them into one number destroys the ability
   to explain a ranking (§36.3).
2. **Topical centrality is computed deterministically** — in-video frequency against
   background corpus frequency, log-odds with an informative Dirichlet prior. No LLM, and
   it needs only the frequency data ADR 0004 already provides.
3. **Confidence discounts, never rejects.** What §14.12 called `quality_penalties` is
   renamed `confidence_discount` and capped, so an uncertain unit is demoted rather than
   removed.

---

## 6. Surfacing — `PROMOTE_CANDIDATES`

**One global ranked queue across all videos, plus a per-video floor.**

```
queue  = all observed units, ordered by importance DESC
floor  = top 5 units of each newly ingested video, unconditionally admitted
```

The queue is a **cursor, not a list to empty**. You work down it until you have enough new
items and stop. This is the correct shape for a product whose thesis is the *smallest*
high-value curriculum (§1) — you never "finish" the inbox, and you shouldn't want to.

The floor exists so that ingesting a video whose vocabulary you mostly know still produces
visible evidence that ingestion worked. Without it, a strong learner ingesting an easy
video sees nothing and cannot distinguish that from a failed job.

**Promotion is not approval.** A promoted candidate is a proposal; §7.3's human gate is
unchanged and has no automatic path.

---

## 7. Lazy enrichment — `ENRICH_CANDIDATE`

Dictionary lookup and LLM disambiguation run **on promotion**, per candidate — never
across the observed pool.

<!-- RESOLVED: spec §27.1 orders LOOKUP_DEFINITIONS and DISAMBIGUATE_SENSES *before*
     CONSOLIDATE_CANDIDATES and SCORE_CANDIDATES. That order requires enriching everything
     in order to rank anything, which under recall-first means enriching ~800 units per
     video and realizing §38.10's cost risk directly. Enrichment moves after ranking. -->

This is a **precondition of recall-first, not an optimization**. Capture-everything is only
affordable because enrichment is deferred; the two decisions stand or fall together.

Enrichment is also triggered on demand when a user opens an unsurfaced unit from browse
(§8), so inspecting the tail is never blocked by the absence of a definition.

---

## 8. The observed pool must be reachable

If nothing below the threshold can ever be found, soft filtering has degraded into hard
filtering that also pays for storage. The API therefore exposes browse and search over
observed units (`03-api.md` §4.1), with the same filters the items library offers.

**Retention: forever.** Rows are small, and growth is self-limiting for the reason in §9.
Archiving would destroy late recurrence promotion — a unit archived at video 20 could no
longer be promoted by its third sighting at video 40, which reintroduces exactly the
invisible loss this architecture exists to prevent.

### 8.1 Calibration probe

Periodically mix a small number of randomly chosen **unsurfaced** units into the queue,
labelled as such. If the user approves them at a meaningful rate, the threshold is too high
or the ranking is wrong.

This is the only mechanism that detects a systematically mis-weighted ranker. Without it,
burial is as invisible as rejection was, and the architecture's central claim goes
untested. Probe outcomes are recorded and feed §31.4 product-quality metrics.

---

## 9. Saturation

Because observed units deduplicate globally per language, **new units per video falls as
the corpus grows.** Word counts follow Zipf and flatten within roughly a dozen videos; MWE
counts fall far more slowly, because the sequence space is combinatorially larger and
sparser.

Tracked as a first-class metric — `new_observed_units_per_minute`, broken down by unit type
and language. It answers three questions no other metric does:

- Is a newly added source actually worth processing?
- Has this learner exhausted a domain or a channel?
- Is the MWE layer still productive after the word layer has flattened? (If MWEs stay
  productive far longer, that is direct evidence for the claim that they carry the most
  remaining learning value per video.)

Recurrence also means **the corpus improves retroactively**: video 8 can promote a sequence
first seen in video 2, without anything expensive having been stored back then.

---

## 10. Multiword expressions

MWEs are the highest-value item type (§4.4). A 10-minute transcript holds a few hundred
unique lemmas but many thousands of candidate spans, most of which are arbitrary sentence
fragments rather than language items.

**Amended by ADR 0011.** §10.1–10.7 below replace the earlier single-generator,
boolean-qualification design. Where this section and ADR 0009 disagree, this section wins.

### 10.1 Two questions, not one <!-- ADDED: ADR 0011 -->

A candidate span raises two independent questions, and the previous design collapsed them
into one boolean:

| | Asks | When | Scope |
|---|---|---|---|
| **Unithood** | Does this sequence behave as a reusable unit, or is it an arbitrary fragment? | Observation — cheap, deterministic | Language + corpus |
| **Idiomaticity** | Is the meaning derivable from the parts? | Promotion — needs an enrichment resource | Language |

They are independent. *warten auf* is a unit and not an idiom. *ins Gras beißen* is both.
*Dylan hat den Burger gegessen* is neither. Collapsing them lets an idiom test admit
something that was never a unit, and makes a perfectly good non-idiomatic unit look like a
failed classification.

Unithood is the **gate-shaped** question and idiomaticity is a **label**. Idioms are the
highest-value subset of the target, not the whole target — the pipeline emits both
(§10.4 step 7).

Formulas for both live in `06-scoring.md` §9. The architectural points are here.

### 10.2 Generation — contiguous base, dependency extension <!-- REVISED: ADR 0011 -->

**Base generator: all contiguous sequences of length ≥ 2.** Language-agnostic, needs no
parser, and finds statistically bound units regardless of whether syntax marks them —
*maschinelles Lernen*, *auf jeden Fall*, *zwei Fliegen mit einer Klappe*.

**Extension: dependency-derived spans.** Contiguous enumeration is structurally blind to
discontinuity. German separable verbs split — *Ich fange um acht Uhr an* spreads `anfangen`
across five tokens, and no window recovers it. The same applies to French `ne … pas`,
clitic placement in Spanish and Portuguese, and separated reflexives. This is the *only*
reason the dependency layer exists, and it is sufficient reason.

**Dependency generation matches path patterns, not single arcs.** The earlier wording —
"extract `(head, dependent)` pairs" — was wrong, and wrong for its own headline example.
In *Ich warte auf den Bus*:

```
warte ──obl──> Bus ──case──> auf
                └──det──> den
```

The preposition is a dependent of the **noun**, not the verb. Recovering `[warten, auf]`
needs a two-hop path with the intermediate node *excluded from the span*. Separately, UD
defines `fixed` and `flat` as n-ary flat chains — all subsequent tokens attach to the
first — so arc-at-a-time processing splits *in spite of* into two useless pairs.

Generation therefore runs per head token: match every `MweRelationSpec` outward, collect
emitted nodes into one span ordered by token index, and emit **the maximal span plus each
individual matched path** — `k+1` spans for `k` matches, bounded, not combinatorial.
Sub-spans are emitted because §10.7's boundary problem is real: if the true item is
*sich freuen* rather than *sich freuen auf*, both are observed and ranking decides.

`MweRelationSpec` (`04-providers.md` §2) was declared without a shape, which is where the
arc/path ambiguity lived:

```ts
type PathStep = {
  relation: string;       // UD dep_relation, e.g. "obl", "case", "compound:prt"
  childPos?: string[];    // optional POS constraint on the dependent
  emit: boolean;          // enters the span, or traversed only?
};

type MweRelationSpec = {
  id: string;             // "verb-prep-frame" | "separable-particle" | "fixed-chain"
  headPos?: string[];     // constrain the root, e.g. ["VERB"]
  path: PathStep[];       // traversed in order from the head
  chain?: boolean;        // repeat the final step greedily — required for fixed/flat
};
```

German then reads: separable particle as `[{compound:prt, emit}]`; verb-preposition frame
as `[{obl, traverse}, {case, emit}]`; fixed chains as `[{fixed, emit}], chain: true`.
`emit: false` is what the old prose had no way to express.

**Requires `tokens.head_index` and `tokens.dep_relation`** (`02-database.md` §1), so
ADR 0002's parser choice stays load-bearing.

### 10.3 The funnel <!-- REVISED: ADR 0011 -->

| Layer | Signal | Cost | Milestone |
|---|---|---|---|
| 0 | `tokens` — every span reconstructible | Free | M2 |
| 1 | **Dictionary gazetteer** — multiword headwords compiled to a lemma trie, matched in one pass | Near-zero; highest precision; output is pre-attested | M2 |
| 2 | **Contiguous enumeration + unithood** — cohesion, completeness, context diversity (`06-scoring.md` §9.1) | Cheap; deterministic | M2 |
| 3 | **Dependency path patterns** — particle, fixed, flat, verb-preposition frames; recovers discontinuity | Cheap | M2 |
| 4 | **Cross-video recurrence** — a sequence in 3+ videos is likely real regardless of layers 1–3 | Free | M3 |
| 5 | **Idiomaticity** — dictionary, embedding non-compositionality, LLM (`06-scoring.md` §9.2) | Enrichment-time, per candidate | M3 |
| 6 | **LLM sentence-level proposal** — "list the multiword expressions in these sentences", ~20 sentences per call, high-centrality sentences only | Batched, gated | M3 |

Layer 1 is the single largest lever and arrives free from ADR 0003. Layers 2–3 are
deterministic and belong in Stage 6 with the dictionary work, not Stage 8. Layer 4 is where
recall-first pays off for MWEs specifically: you do not have to be right on first sight,
only to notice again.

`promotion_source` records which layer surfaced a span, so layer precision is measurable
individually rather than only in aggregate.

### 10.4 Pipeline order <!-- ADDED: ADR 0011 -->

```
1. Normalize and tokenize.                                   OBSERVE_UNITS
2. Generate contiguous sequences of length ≥ 2.              base generator
2b. Generate dependency path-pattern spans.                  discontinuity extension
3. Drop below the minimum cumulative-corpus frequency.       §9.1 — see note
4. Compute cohesion, completeness, context diversity.
5. Rank; resolve overlap (§10.6); optional quality classifier.
6. Semantic idiom classification.                            ENRICH_CANDIDATE, §9.2
7. Emit reusable multiword units, and idioms as a subset.
```

Steps 1–5 run at observation, step 6 at promotion. That split preserves lazy enrichment
without changing the pipeline's shape.

**The frequency floor at step 3 is cumulative across the corpus, never per video.** Most
real MWEs occur exactly once in a 10-minute transcript; a per-video floor removes nearly all
of them. P80's corpus accretes one video at a time rather than arriving as a batch, so the
floor is evaluated against accumulated counts.

**Why filtering here is safe.** Steps 3 and 5 remove candidates, which reads as a violation
of §1. It is not, for one specific reason that must hold: **`ngram_observations` is a
materialized index over `tokens`, and `tokens` is immutable and complete.** Every removal is
reversible by a backfill that re-derives spans over stored transcripts and rebuilds counts.
The write threshold is therefore a performance decision, not a recall decision.

What stays forbidden is the irreversible case — no permanent never-capture list, no
suppression surviving a rebuild. A filter a backfill cannot undo is a different thing and is
not permitted.

The step-5 classifier is **optional**. With no LLM configured it is skipped and the
deterministic signals rank alone (§1).

### 10.5 Qualification maps onto the two scores <!-- REVISED: ADR 0011 -->

§14.6's six-way disjunction is retained as *evidence*, but each test now contributes to one
of the two scores rather than flipping a shared boolean:

| Test | Feeds | Mechanized as |
|---|---|---|
| **Lexicalized** | unithood prior | Dictionary headword — strongest evidence, free |
| **Statistically bound** | unithood · cohesion | NPMI across the weakest internal split (`06-scoring.md` §9.1) |
| **Complete, not a fragment** | unithood · completeness | Branching entropy on both edges — **new**, see §9.1 |
| **Pragmatically formulaic** | unithood prior | Discourse markers and fixed formulas, per-language list |
| **Grammatically fixed** | idiomaticity | Substitute a near-synonym; if meaning breaks, the unit is bound |
| **Non-compositional** | idiomaticity | Dictionary senses, embeddings, or LLM (`06-scoring.md` §9.2) |

Former disqualifiers are now scored, not applied as a post-filter: free syntactic
combination (*in der*, *und dann*) falls out of low cohesion; fragment-of-a-longer-unit
(*Fliegen mit einer Klappe*) falls out of low completeness. Spans crossing a clause boundary
and named entities remain hard exclusions, because those are §3 validity questions rather
than value questions.

### 10.6 Overlap resolution <!-- ADDED: ADR 0011 -->

Overlapping spans are resolved **in favour of the highest-quality complete expression**:
*zwei Fliegen mit einer Klappe* suppresses *Fliegen mit einer Klappe*.

Resolution happens at **surfacing, not at write**. The losing row stays in
`ngram_observations` with its counts intact and remains reachable by browse (§8). A wrong
call therefore costs a keystroke, and the recurrence counts that would justify reversing it
keep accumulating.

### 10.7 Boundaries will be wrong, and that is expected

Human annotators disagree on MWE boundaries at high rates. The design goal is **propose a
boundary and make correcting it one keystroke** — not be right first time. §25.2 already
provides boundary editing, split, and merge, and `bad_phrase_boundary` is already a
rejection reason. Corrections are training signal for threshold tuning, and the TUI is a
good host for this because boundary adjustment is inherently a keyboard operation.

---

## 11. Constructions

Constructions (§14.7) are patterns with slots, so they can be keyed by neither lemma nor
lemma sequence. They carry their own signature — fixed components plus ordered slot labels
— and follow the MWE funnel for *generation* only.

Their observed tier is deferred to M3/Stage 8, since nothing earlier produces them. This is
the one place the three-tier model does not transfer cleanly; revisit when Stage 8 is
briefed.

---

## 12. Job pipeline

<!-- RESOLVED: replaces the ordering in spec §27.1. Enrichment moves after ranking; two
     jobs are split into observe/consolidate pairs; RESCORE_OBSERVATIONS is new. -->

```
PARSE_TRANSCRIPT
RECONSTRUCT_SENTENCES
ANNOTATE_TRANSCRIPT            + dependency parse
OBSERVE_UNITS                  every valid token → observed_units
OBSERVE_NGRAMS                 dependency-derived spans → ngram_observations
CONSOLIDATE_OBSERVATIONS       forms, variants, counters
SCORE_OBSERVATIONS             rank; no enrichment
PROMOTE_CANDIDATES             global queue + per-video floor
ENRICH_CANDIDATE               lazy, one candidate — dictionary then LLM
DETECT_MWE_GAZETTEER           M2
DETECT_MWE_STATISTICAL         M3
PROPOSE_MWE_LLM                M3, batched
EXTRACT_CONSTRUCTIONS          M3
RESCORE_OBSERVATIONS           on material learner-state change
RECALCULATE_VIDEO_DIFFICULTY
RECALCULATE_RECOMMENDATIONS
EXPORT_DATA
```

Every job keeps §27.3's requirements: idempotent, retryable, inspectable, cancellable where
possible, versioned. Provider failure during `ENRICH_CANDIDATE` leaves the candidate
promoted but unenriched — visible, marked, retryable — never silently dropped and never
given a fabricated definition (§27.4).

---

## 13. Risks this architecture accepts

Stated plainly, because a contract that hides its own failure modes is not useful.

1. **Ranking is now a single point of failure, with a worse failure mode than filtering.**
   A bad gate loses items randomly; a bad weight buries an entire *class* silently and
   consistently. Systematic bias is harder to detect than random loss. Mitigated by the
   calibration probe (§8.1) and by storing score components separately (§5).
2. **The evaluation corpus must be exhaustive.** "Was something important buried at rank
   300?" cannot be answered from positive labels alone. See ADR 0006.
3. **Recall-first extends to MWEs only through rebuildability.** <!-- REVISED: ADR 0011 -->
   Word capture is bounded; span capture is combinatorial, so generation now enumerates
   exhaustively (§10.2) and the pressure moves from *generation* to *persistence* — the
   frequency floor and quality classifier at §10.4 steps 3 and 5 do remove candidates.
   The recall guarantee rests entirely on `ngram_observations` being a materialized index
   over an immutable, complete `tokens` table, so any removal is reversible by backfill.
   **If that property is ever broken — a filter applied at tokenization, a transcript
   discarded after ingest, a suppression that survives a rebuild — the guarantee is void
   and this risk becomes unbounded.** The backfill job is therefore load-bearing
   infrastructure, not a maintenance convenience, and needs a test.
4. **The observed pool is only as useful as its reachability.** If browse and search over
   the tail are poor, the architecture reduces to filtering with extra storage cost.

---

## 14. Open items

Tunable against the evaluation corpus; recorded rather than silently defaulted.

| Question | Current default | Resolved at |
|---|---|---|
| ~~`ngram_observations` write threshold — content-word filter?~~ | **Withdrawn (ADR 0011).** All dependency-derived spans get a row; the filter dropped real discourse markers for a saving that does not exist at this scale | — |
| **Idiom dictionary first, or build the semantic signals directly?** ← *decision needed* | Dictionary first regardless, since it is also the ground truth the other signals are tuned against. Open part: whether the embedding path is MVP or deferred | Stage 8, decided by measured dictionary recall against the ADR 0006 idiom labels |
| Layer 2 write threshold — contiguous enumeration is ~7,500 spans/video against ~150 from dependency, so Layer 3's sizing does not transfer | Persist on second sighting, via a rebuildable index over `tokens`; a once-ever span has no computable cohesion or completeness | Stage 8, measured |
| Unithood shrinkage cap and per-layer priors (`06-scoring.md` §9.1) | cap = 20 occurrences; priors ordered gazetteer > dependency > contiguous | Stage 8 |
| Recurrence promotion threshold — how many distinct videos? Must speakers differ? | 3 videos, speaker-agnostic | Stage 8 |
| Per-video floor size | 5 | Stage 5, from review-burden feel |
| `RESCORE_OBSERVATIONS` scope — full pool or dirty-flagged subset? | Dirty-flagged; full rescore is manual maintenance | Stage 9 |
