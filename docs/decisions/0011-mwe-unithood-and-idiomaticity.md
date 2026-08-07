# ADR 0011 — MWE unithood and idiomaticity as separate scores

**Status:** Proposed
**Date:** 2026-08-06
**Extends:** ADR 0009 (does not supersede — generation and storage stand)
**Depends on:** ADR 0002 (parser), ADR 0003 (dictionary), ADR 0004 (n-gram counts),
ADR 0008 (recall-first)
**Blocks:** Stage 6 (deterministic half), Stage 8 (statistical and LLM half)

**Precedence:** where this ADR conflicts with `07-extraction.md` §10 or ADR 0009 as
previously written, **this ADR wins** and the earlier text is amended to match. Divergences
are named explicitly in *Revision to ADR 0009* below rather than left to be discovered.

## Context

ADR 0009 settled *where MWE candidates come from* (the dependency graph) and *what is
stored* (recurrence only). It left three things unfinished, and its own Consequences
section admits the largest one: **"recall-first is only partially achieved here — span
generation stays selective."**

1. **Layer 3 has no specification.** `07-extraction.md` §10.2 describes it in one line —
   "association statistics, PMI or log-likelihood against background n-gram counts." That
   is a category, not a formula, and nothing says how it generalizes past bigrams.

2. **Qualification is a boolean disjunction.** §10.3 lists six tests and qualifies a span
   on *any one*. A boolean cannot be ranked, cannot be inspected, and cannot express
   partial evidence — which contradicts `06-scoring.md` §0 rule 2, requiring every
   composite to store its breakdown.

3. **Two different questions are conflated.** "Is this a reusable unit?" and "is this
   meaning non-derivable from the parts?" are independent. *warten auf* is a unit and not
   an idiom. *ins Gras beißen* is both. A sentence fragment is neither. Collapsing them
   into one disjunction means an idiom test can admit something that was never a unit, and
   a unit with no idiomatic content looks like a failure rather than a normal result.

The distinction is standard in the literature — **unithood** versus
**non-compositionality** — and P80 needs both, because the product teaches reusable units,
of which idioms are the highest-value subset rather than the whole target.

## Decision

**Two scores, computed at two different times, neither of which filters.**

### 1. Unithood — cheap, deterministic, computed at observation

Answers *does this sequence behave as a reusable unit in this corpus?* Language-scoped,
learner-independent, no dictionary, no LLM, no embeddings. Stored in
`ngram_observations.score` with its breakdown in `score_breakdown_json`.

Four components, specified in `06-scoring.md` §9.1:

| Component | Mechanized as |
|---|---|
| **Cohesion** | NPMI across the *weakest internal binary split*, not the whole span |
| **Completeness** | Branching entropy on both edges — penalizes fragments of longer units |
| **Context diversity** | Distinct sentences, videos, and grammatical environments |
| **Confidence** | Log-scaled cumulative occurrence count |

Cohesion and completeness are complementary and neither alone suffices:

- *of the* — high branching entropy on both edges, **low cohesion**. Killed by cohesion.
- *birds with one stone* — high cohesion, but almost always preceded by *two*, so **left
  entropy ≈ 0**. Killed by completeness.
- *Dylan ate the burger* — free syntactic combination, low cohesion, singleton. Killed by
  both, and by confidence.

The completeness test is the substantive addition. Nothing in ADR 0009 or the contract
detected fragment-of-a-longer-expression, and it is the failure mode that association
statistics alone produce most often.

### 2. Idiomaticity — semantic, computed at promotion

Answers *is the meaning derivable from the parts?* Runs only on promoted candidates, never
across the observed pool, because every mechanization needs an enrichment resource.
Specified in `06-scoring.md` §9.2.

Evidence sources, in cost order: idiom/phraseme dictionary hit; embedding-based
non-compositionality; LLM literal-versus-conventional comparison. A supervised classifier
is deferred — it needs training data P80 does not have until the evaluation corpus is
labelled.

### 3. Confidence is shrinkage, not a threshold

This is what makes the design compatible with ADR 0008.

Cohesion and completeness are **undefined at one occurrence** — branching entropy over a
single observation is exactly zero, and NPMI is unstable. A naive pipeline reads that zero
as *not a unit*, when it means *not yet measured*. The two are not the same and the
difference is the entire recall argument.

Unithood is therefore a **shrinkage estimator** toward a per-layer prior:

```
unithood = c · measured  +  (1 − c) · prior(promotion_source)
c        = log(1 + occurrences) / log(1 + cap)
```

An unmeasured span sits at its layer's prior, not at zero. A gazetteer hit starts high and
needs no corpus evidence to survive; a raw contiguous span starts low and must earn its
way up. Evidence moves the score; absence of evidence does not condemn it.

The step-3 floor and this shrinkage do different jobs and must not be conflated: the floor
decides what is **persisted now**, shrinkage decides how what is persisted is **ranked**. A
span below the floor is not judged a non-unit — it is unmeasured, and recoverable by
rebuild the moment the corpus grows enough to measure it.

### 4. The canonical pipeline

Exhaustive contiguous enumeration is the **foundation**, and the dependency graph is the
extension that recovers what contiguity structurally cannot see. ADR 0009 treated
enumeration as a rejected alternative; that framing is withdrawn. It is the base generator,
and the dependency layer supplements it.

```
1. Normalize and tokenize all sentences.                        (existing OBSERVE_UNITS)
2. Generate all contiguous sequences of length ≥ 2.             ← base generator
2b. Generate dependency-derived spans (ADR 0009 §Generation).   ← discontinuity extension
3. Drop candidates below the minimum cumulative frequency.      (§9.1, corpus-wide)
4. Compute cohesion, completeness, context diversity.
5. Rank; resolve overlap in favour of the highest-quality complete expression.
6. Pass survivors to the semantic idiom classifier.             (promotion-time, §9.2)
7. Emit two outputs: reusable multiword units, and idioms.
```

Steps 1–5 are deterministic and language-scoped, so they run at observation. Step 6 needs
an enrichment resource, so it runs at promotion. That split is what keeps lazy enrichment
intact without changing the pipeline's shape.

Why both generators, stated once so it is not re-litigated:

| | Finds | Blind to |
|---|---|---|
| **Contiguous (base)** | statistically bound sequences regardless of syntax (*maschinelles Lernen*, *auf jeden Fall*, *zwei Fliegen mit einer Klappe*) | anything discontinuous |
| **Dependency (extension)** | discontinuous, syntactically marked units (*fange … an*, *warten auf*) | units with no distinguishing dependency relation |

Both write to `ngram_observations`; `promotion_source` already distinguishes them, so layer
precision stays independently measurable. Running both is the direct remedy for ADR 0009's
admitted partial recall.

### 5. Where filtering is allowed, and why it is safe

Two steps above remove candidates: the **minimum cumulative frequency floor** (step 3) and
the **optional phrase-quality classifier** (step 5, rejecting grammatical but non-reusable
fragments). Both are adopted as specified.

They are compatible with ADR 0008 for one specific reason, which must hold or they are not
safe: **`ngram_observations` is a materialized index over `tokens`, and `tokens` is
immutable and complete.** Every removal is reversible by a backfill job that re-derives
spans over stored transcripts. Nothing is lost, only deferred — which is why the write
threshold is a performance question rather than a recall question.

The classifier stays **optional**, per the source proposal and per the standing constraint
that P80 works with no LLM configured. With no classifier available, step 5 is skipped and
the deterministic signals rank alone.

What remains forbidden is the irreversible case: no permanent never-capture list, no
suppression that survives a rebuild. A filter that a backfill cannot undo is a different
thing from the two above, and is not permitted.

Idiomaticity does not filter. Per step 7 it **partitions**: reusable units are one output,
idioms a stricter subset. *warten auf* is not an idiom and is unambiguously a learning item.
Idiomaticity raises `unit_type_value` (`06-scoring.md` §2.6) and drives display.

## Revision to ADR 0009

ADR 0009 rejected *"store every generated span as an observed row"* on the grounds that
"the row count would dwarf the word tier for no gain." **The first clause is wrong at
P80's scale and the reasoning should not be reused.**

Dependency-derived spans run ~150 unique per 10-minute video, decaying hard under
saturation — roughly 20–40k rows and 10–15 MB at 200 videos, against ~300k rows in `tokens`
for the same corpus. The table ADR 0009 worried about is an order of magnitude smaller than
one it accepted without comment.

Two corrections follow:

- **All dependency-derived spans get a row.** The `≥1 content word` filter in
  `07-extraction.md` §14 is withdrawn. It dropped real discourse markers (*und dann*,
  *auf jeden Fall*) for a saving that does not exist.
- **`ngram_observations` is a materialized index over `tokens`, not an irreplaceable
  record.** ADR 0009 says cross-video recurrence "cannot be recomputed." That is true *at
  ingest time* but not permanently: `tokens` is immutable, every past video is local, and
  `head_index`/`dep_relation` are stored. Any write policy is reversible by a backfill job
  that re-derives spans over stored transcripts and rebuilds the counts.

That reframe is what makes the remaining threshold question a **performance** decision
rather than a **recall** decision, and it is the strongest available guarantee that no
expression is permanently lost.

Layer 3's arithmetic is different and is *not* settled by the above — see Open question 2.

## Alternatives rejected

**Embedding compositionality as a storage gate.** Rejected. It requires inference over
every span at ingest, contradicting lazy enrichment; it is a low-value judgment, which ADR
0008 forbids as a drop reason; and unlike a stated rule it fails in ways that cannot be
enumerated after the fact. Kept as a scoring component in §9.2, where it is genuinely good.

**LLM-flagged permanent blocklist** — *n* flags and the sequence is never captured again.
Rejected as the one filter that a backfill cannot undo, which is the line drawn in §5. It
would also be invisible in failure, and repeated calls to one model on one prompt are
correlated, so *n* flags approximate one flag rather than *n* independent votes. The
reversible filters in §5 achieve the same table-size goal without the property that makes
this one unsafe.

**Per-video frequency threshold.** The floor in step 3 is adopted, but computed over the
**cumulative corpus**, not per video. Applied per video it would remove nearly every real
MWE, since most occur exactly once in a 10-minute transcript — an artifact of P80's corpus
accreting one video at a time rather than arriving as a batch. This is a scoping of the
source proposal to a streaming corpus, not a departure from it.

**One combined MWE score.** Rejected for the same reason `06-scoring.md` §2.0 keeps three
importance axes separate: a collapsed number cannot be explained, and unithood and
idiomaticity pull apart on exactly the items that matter most.

## Consequences

- **ADR 0004's n-gram requirement becomes load-bearing.** ADR 0009 already listed
  background n-gram counts as a requirement; NPMI over arbitrary-length spans is what
  consumes them. A unigram-only frequency source cannot support §9.1.
- **`06-scoring.md` gains §9** — the first score that is a property of the language and
  corpus rather than of a learner.
- **`ngram_observations.score` means unithood, not importance.** This falls out of the
  schema: the table is keyed `(target_language, hash)` with no `profile_id`, so it
  structurally cannot hold a learner-specific number. Importance is computed at promotion,
  when the candidate becomes profile-scoped.
- **The evaluation corpus gains a second label axis.** ADR 0006 needs MWE spans marked for
  *unithood* and *idiomaticity* separately, or §9 cannot be tuned. This is a real increase
  in labelling effort and should be scoped before Stage 8.
- **Stage 6 / Stage 8 split shifts.** Unithood is deterministic, so cohesion and
  completeness move into Stage 6 with the other non-LLM work. Only idiomaticity's embedding
  and LLM paths remain Stage 8.
- **Overlap is resolved in favour of the highest-quality complete expression**, at
  surfacing rather than at write. *zwei Fliegen mit einer Klappe* suppresses *Fliegen mit
  einer Klappe*; the losing row remains in the table and reachable by browse, so a wrong
  call costs a keystroke rather than an item. See `07-extraction.md` §10.6.

## Open questions

Both are recorded in `07-extraction.md` §14 and neither should be silently defaulted.

### 1. Idiom dictionary first, or build the semantic signals directly?

These are usually posed as alternatives. They are not — the dictionary is simultaneously a
*signal* and the *ground truth that lets the other signals be tuned*. Ordering is therefore
forced: dictionary first regardless. The real question is whether the embedding path is
**MVP or deferred**.

| | Dictionary only | Dictionary + embedding/LLM |
|---|---|---|
| Cost | Free — falls out of ADR 0003's index build | Local embedding model (new heavy dependency for a local-first app) or per-candidate LLM spend |
| Precision | Highest available; pre-attested | Good, with an error rate that must be measured |
| Coverage | Fixed ceiling, never improves | Unbounded; handles productive and novel expressions |
| Determinism | Total — works with no LLM configured | Must degrade gracefully; cannot be load-bearing |
| Risk | Idiom dictionaries skew literary and colorful; thin on register-specific and recent formulas. Partly redundant with the Layer 1 gazetteer already built | Tuning requires labelled data that only exists once the dictionary path has run |

**Recommended decision rule, rather than a decision now:** build the dictionary path in
Stage 6, then at Stage 8 measure its recall against the idiom labels in the evaluation
corpus. If it recovers most labelled idioms, defer embeddings past MVP and record the
number. If it does not, build the embedding path with that measurement as its tuning
target. Either way the dictionary is built first, so nothing is blocked on answering this
today.

**This is the question to answer.** ← decision needed

### 2. Layer 3 write threshold

Layer 2's arithmetic does not transfer. Exhaustive contiguous enumeration at `n = 2..6`
over a 1500-word transcript is ~7,500 spans per video against ~150 from dependency — a 50×
change that invalidates the sizing above and needs its own answer.

The candidate resolutions are in `07-extraction.md` §14. Recommended: **persist on second
sighting**, using a rebuildable index over `tokens` to answer "seen before?", since a
once-ever span has no computable cohesion or completeness and therefore nothing a rescan
could not recover. Decide at Stage 8, measured.
