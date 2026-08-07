# ADR 0004 — Frequency dataset

**Status:** Accepted — self-built from OpenSubtitles; SUBTLEX-DE as a test fixture
**Date:** 2026-08-03
**Decided:** 2026-08-07
**Depends on:** ADR 0001 (German)
**Blocks:** Stage 5 (word candidates), Stage 9 (learner model), Stage 10 (video difficulty)

## Context

Frequency data feeds three separate calculations, which is why the choice matters more
than it first appears:

1. **Importance ranking** — `general_frequency_utility` and `topical_centrality`
   (spec §14.12, `06-scoring.md` §2).
2. **Initial `P_known`** — placement initializes known-probability *by frequency band*
   (§11.2, §14.11), and every unseen lemma falls back to its band prior.
3. **Lexical coverage** — the difficulty model's central number (§22.1).

A miscalibrated frequency list therefore produces bad candidate ranking, bad placement,
*and* bad difficulty labels simultaneously, with one root cause that is hard to see from
any of the three symptoms.

## Options

### A. Subtitle-derived frequency (SUBTLEX family, OpenSubtitles counts) — **recommended**
Derived from film and television subtitles.
- **Register match.** P80's entire corpus is spoken video. A written-corpus list
  systematically under-weights conversational vocabulary — exactly the words this product
  exists to teach.
- Well-established for psycholinguistic word-recognition work, which is the closest
  research analogue to "is the learner likely to know this".
- Available for several major languages.

Cost: word-form counts rather than lemma counts, so the adapter must aggregate over the
lemma's forms. Domain skew toward dialogue — technical vocabulary is under-represented,
which `domain_relevance` (§14.12) is designed to compensate for.

### B. `wordfreq` (blended multi-source, many languages)
Broad language coverage, blends subtitles with web and Wikipedia text, ships as a library
with lemma-ish handling.
Cost: blending dilutes the spoken-register advantage; per-language provenance is less
transparent, which makes a miscalibration harder to diagnose.

### C. Written-corpus list (Wikipedia, news, web crawl)
Large and easy to obtain.
Cost: worst register match for this product. A word common in news and rare in speech gets
over-valued in a curriculum built entirely from video.

### D. CEFR / pedagogical word lists
Aligned to teaching sequences.
Cost: coverage stops at a few thousand words, and the spec explicitly disclaims CEFR-level
claims (§6). Useful as a *supplementary* signal, not as the frequency source.

## Decision

**Option A, self-built.** Derive both unigram and n-gram (n = 2..6) counts from the German
OpenSubtitles corpus, in one counting job, through the same tokenizer P80 uses at runtime.
The register argument is decisive: every input to this system is speech, so the frequency
prior should be too.

One source, not two. ADR 0011 made background n-gram counts load-bearing — NPMI over
arbitrary-length spans is what consumes them — and SUBTLEX-DE publishes unigrams only.
Pairing a published unigram list with self-derived n-grams would put a **normalization seam
straight through the middle of `topical_centrality`**, whose whole mechanism is a log-odds
ratio of in-video against background frequency. Both terms must come from the same counting
pass or the ratio compares two things that were never comparable.

### SUBTLEX-DE is a test fixture, not a data source

This is the part worth stating explicitly, because the obvious reading of "use SUBTLEX" is
the wrong one.

The value of a peer-reviewed, psycholinguistically validated list here is **not its
numbers** — it is the confidence that P80's own numbers are not broken. So: build the
counts, then correlate P80's unigram ranks against SUBTLEX-DE's published list **once**, as
a committed test.

- **Strong rank correlation** ⇒ the tokenizer, cleaning, and counting pipeline are sane.
- **Divergence** ⇒ there is a bug — subtitle markup leaking in, casing not folded, umlaut
  encoding mangled, speaker labels counted as words.

A silent bug in frequency counting is close to undetectable downstream, because the three
consumers named above fail in three unrelated-looking ways: mediocre candidate ranking, a
placement test that keeps overestimating the learner, and difficulty labels that feel
slightly off. Finding it in an afternoon via a correlation test is worth far more than
borrowing the numbers, **and it costs no seam at all** — the fixture never enters the hot
path.

Storage: `fixtures/frequency/de/subtlex-de-ranks.csv`, with the correlation threshold
recorded in the test rather than eyeballed. Treat a regression as a build failure, not a
curiosity.

## Consequences

- **Added requirement: background *n-gram* counts, not only unigram frequency.** Two
  consumers need them, both introduced after this ADR was drafted:
  - `topical_centrality` (`06-scoring.md` §2.2) — log-odds of in-video against background
    frequency, the signal that promotes domain vocabulary a general list would bury
  - MWE association statistics (ADR 0009, funnel layer 3) — PMI or log-likelihood over
    lemma sequences

  Self-building satisfies this by construction — the same pass emits both, from the same
  tokenization, so cohesion and completeness are computed against the identical
  distribution the unigram priors come from. This is the main reason the decision landed on
  self-built rather than on a published list.
- **Counts run through the runtime tokenizer** (ADR 0002's spaCy sidecar), not a
  whitespace split. Otherwise background counts and in-video counts disagree about what a
  token is, which reintroduces the seam this decision exists to avoid.
- **The counting job is a documented setup step with a recorded corpus snapshot date.**
  `frequency_dataset_version` records it, so a recount is a reprocessable event.
- `LanguageAdapter.frequencyRank()` and `.frequencyBand()`
  (`docs/contracts/04-providers.md` §2) are implemented against this dataset. Band
  boundaries are defined once, in the adapter, and used identically by placement,
  priority, and coverage — three consumers, one definition.
- **Bands must be defined explicitly** before Stage 9. "High frequency" as an informal
  notion is not enough; §11.2's calibrated placement samples *by band*, so the boundaries
  are user-visible whether or not they were designed.
- Form-to-lemma aggregation belongs in the adapter, never in the pipeline.
- `frequency_dataset_version` in `pipeline_versions` records which dataset produced a
  given score (spec §27.5).
- Missing frequency data is a **null rank, not a zero**. Zero means "maximally rare" to
  every downstream formula and would silently promote unknown-to-the-list junk to the top
  of the candidate inbox.
