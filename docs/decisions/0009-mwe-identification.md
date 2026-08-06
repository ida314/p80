# ADR 0009 — Multiword expression identification and storage

**Status:** Accepted
**Date:** 2026-08-03
**Depends on:** ADR 0002 (parser), ADR 0003 (dictionary), ADR 0008 (recall-first)
**Blocks:** Stage 6 (deterministic half), Stage 8 (statistical and LLM half)

## Context

MWEs carry the most communicative value of any item type (§4.4) and are what distinguishes
P80 from a flashcard generator. They are also the one type where ADR 0008's capture-
everything principle cannot apply literally: a 10-minute transcript holds a few hundred
unique lemmas but tens of thousands of candidate spans, nearly all noise.

Two structural facts shape the answer.

**A span is a view, not a record.** With an immutable `tokens` table, any span is
reconstructible from `(sentence_id, start_index, end_index)`. Nothing is lost by declining
to write a span row. The only thing that cannot be recomputed later is **cross-video
recurrence** — noticing a sequence in video 2 requires having noticed it at the time.

**N-grams cannot find German separable verbs.** *Ich fange um acht Uhr an* splits
`anfangen` across five tokens. No contiguous window recovers it. The same applies to French
`ne … pas`, clitic placement in Spanish and Portuguese, and separated reflexives — which
covers every language in ADR 0001's set.

## Decision

**Generate from the dependency graph; store only recurrence; qualify through a funnel.**

### Generation

Extract `(head, dependent)` pairs whose dependency relation marks a lexicalized attachment
— particle, fixed, flat, verb-preposition frames. Relation sets are language-specific and
live in `LanguageAdapter.mweRelations()`. This handles discontinuity and shrinks the search
space by orders of magnitude against contiguous enumeration.

Requires `tokens.head_index` and `tokens.dep_relation`, and therefore a real dependency
parser.

### Storage

`ngram_observations`, keyed by a hash of the lemma sequence, holding `video_count`,
`total_count`, and first/last-seen pointers. No span rows, no per-occurrence detail — the
tokens table already has it.

### Funnel

| Layer | Signal | Milestone |
|---|---|---|
| 0 | `tokens` — every span reconstructible | M2 |
| 1 | Dictionary gazetteer: multiword headwords → lemma trie, one-pass match | M2 |
| 2 | Dependency relations — handles discontinuity | M2 |
| 3 | Association statistics against background n-grams | M3 |
| 4 | Cross-video recurrence | M3 |
| 5 | LLM sentence-level proposal, batched, high-centrality sentences only | M3 |

Layers 1–2 are deterministic and need no LLM, which is why they belong in Stage 6 with the
dictionary work they depend on rather than waiting for Stage 8. Layer 1 is the largest
single lever and arrives free from ADR 0003.

### Qualification

Operationalizes "a group of words with a singular, distinct meaning" and maps onto §14.6's
six-way disjunction. A span qualifies on **any one** of: lexicalized (dictionary headword);
non-compositional (composed component senses diverge from the contextual gloss);
grammatically fixed (resists synonym substitution); statistically bound (association high
after controlling for component frequency); pragmatically formulaic.

Build the **non-compositional** test first — it uses dictionary senses already on hand and
matches §14.9's "dictionary grounds, LLM disambiguates" division.

## Alternatives rejected

**N-gram enumeration with a frequency threshold.** Simple and language-agnostic. Rejected
because it cannot represent discontinuous expressions, which is a first-order requirement
for all four target languages, not an edge case.

**Store every generated span as an observed row.** Consistent with the word tier. Rejected
because it is unnecessary — spans are derivable — and because the row count would dwarf the
word tier for no gain.

**LLM-first extraction.** Highest quality per span. Rejected because §35 Stage 4 requires
structured extraction without LLM dependency, cost would scale with transcript length
(§38.10), and non-determinism makes the §34.2 fixture tests meaningless. The LLM stays at
layer 5, on a shortlist, batched.

## Consequences

- **ADR 0002's parser choice becomes load-bearing.** Dependency parsing moves from a nice
  signal for §22.3 syntactic difficulty to a hard requirement for the highest-value item
  type. A stack that cannot parse dependencies for German cannot build this.
- **ADR 0003 gains a requirement**: extract multiword headwords at index-build time to
  compile the gazetteer.
- **ADR 0004 gains a requirement**: background *n-gram* counts, not only unigram frequency.
- **ADR 0005 gains a second LLM use**: batched sentence-level proposal, distinct from
  definition enrichment and separately versioned.
- **Boundaries will be wrong and that is expected.** Annotator disagreement on MWE
  boundaries is high. The design goal is propose-then-correct-in-one-keystroke, not
  first-time correctness. §25.2 already provides the editing operations; corrections become
  threshold-tuning signal.
- **The evaluation corpus needs MWE boundary labels**, with disagreement recorded rather
  than resolved away.
- **Recall-first is only partially achieved here.** Word capture is bounded; span
  generation stays selective. The recall risk persists for the item type the product
  differentiates on — reduced by a loose net plus recurrence, not eliminated. Stated in
  `07-extraction.md` §13 rather than hidden.
