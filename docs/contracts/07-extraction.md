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

MWEs are the highest-value item type (§4.4) and the one where naive capture is impossible:
a 10-minute transcript has a few hundred unique lemmas but tens of thousands of candidate
spans, nearly all noise.

### 10.1 Generation runs on the dependency graph, not the token sequence

German separable verbs are **discontinuous** — *Ich fange um acht Uhr an* splits `anfangen`
across five tokens. No n-gram window finds it. The same applies to French `ne … pas`,
clitic placement in Spanish and Portuguese, and reflexives separated from their verb.

Candidate generation therefore extracts `(head, dependent)` pairs whose dependency relation
marks a lexicalized attachment. Relation sets are language-specific and live in
`LanguageAdapter.mweRelations()` (`04-providers.md` §2). This also shrinks the search space
by orders of magnitude relative to enumerating contiguous spans.

**This requires `tokens.head_index` and `tokens.dep_relation`** (`02-database.md` §1) and a
dependency parser — which makes ADR 0002's parser choice load-bearing rather than
convenient.

### 10.2 The funnel

| Layer | Signal | Cost | Milestone |
|---|---|---|---|
| 0 | `tokens` — every span reconstructible | Free | M2 |
| 1 | **Dictionary gazetteer** — multiword headwords compiled to a lemma trie, matched in one pass | Near-zero; highest precision; output is pre-attested | M2 |
| 2 | **Dependency relations** — particle, fixed, flat, verb-preposition frames; handles discontinuity | Cheap | M2 |
| 3 | **Association statistics** — PMI or log-likelihood against background n-gram counts | Cheap; noisy tail, threshold for recall not precision | M3 |
| 4 | **Cross-video recurrence** — a sequence in 3+ videos is likely real regardless of layers 1–3 | Free | M3 |
| 5 | **LLM sentence-level proposal** — "list the multiword expressions in these sentences", ~20 sentences per call, high-centrality sentences only | Batched, gated | M3 |

Layer 1 is the single largest lever and arrives free from ADR 0003. Layer 4 is where
recall-first pays off specifically for MWEs: you do not have to be right on first sight,
only to notice again.

### 10.3 Qualification tests

Operationalizes "a group of words with a singular, distinct meaning." Maps onto §14.6's
six-way disjunction. A span qualifies on **any one**:

| Test | Mechanized as |
|---|---|
| **Lexicalized** | Has a dictionary headword — strongest evidence, free |
| **Non-compositional** | Compose the dictionary senses of the components; compare against the contextual gloss. Divergence ⇒ idiomatic |
| **Grammatically fixed** | Substitute a near-synonym for one component; if meaning breaks, the unit is bound |
| **Statistically bound** | Association high *after* controlling for component frequency |
| **Pragmatically formulaic** | Discourse markers and fixed formulas, from a per-language list |

Build the **non-compositional** test first: it uses dictionary senses already on hand and
matches the "dictionary grounds, LLM disambiguates" division (§14.9).

Disqualifiers, applied after: free syntactic combination frequent only because its parts are
(*in the*, *and then*); spans crossing a clause boundary; named entities (handled
separately); a verb plus its ordinary arguments.

### 10.4 Boundaries will be wrong, and that is expected

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
3. **Recall-first does not fully extend to MWEs.** Word capture is bounded; span capture is
   combinatorial. Generation stays selective, so the recall risk persists for the item type
   the product differentiates on. Mitigated by a loose net plus recurrence — reduced, not
   eliminated.
4. **The observed pool is only as useful as its reachability.** If browse and search over
   the tail are poor, the architecture reduces to filtering with extra storage cost.

---

## 14. Open items

Tunable against the evaluation corpus; recorded rather than silently defaulted.

| Question | Current default | Resolved at |
|---|---|---|
| `ngram_observations` write threshold — all dependency-derived spans, or only those with ≥1 content word? | Content-word filter | Stage 8, measured both ways |
| Recurrence promotion threshold — how many distinct videos? Must speakers differ? | 3 videos, speaker-agnostic | Stage 8 |
| Per-video floor size | 5 | Stage 5, from review-burden feel |
| `RESCORE_OBSERVATIONS` scope — full pool or dirty-flagged subset? | Dirty-flagged; full rescore is manual maintenance | Stage 9 |
