# ADR 0004 — Frequency dataset

**Status:** Proposed
**Date:** 2026-08-03
**Depends on:** ADR 0001 (target language)
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

## Recommendation

**Option A**, falling back to **B** if the language chosen in ADR 0001 has no subtitle-
derived list. The register argument is decisive: every input to this system is speech, so
the frequency prior should be too.

## Consequences

- **Added requirement: background *n-gram* counts, not only unigram frequency.** Two
  consumers need them, both introduced after this ADR was drafted:
  - `topical_centrality` (`06-scoring.md` §2.2) — log-odds of in-video against background
    frequency, the signal that promotes domain vocabulary a general list would bury
  - MWE association statistics (ADR 0009, funnel layer 3) — PMI or log-likelihood over
    lemma sequences

  Subtitle corpora support this directly: the same source that yields unigram frequency
  yields bigram and trigram counts. Verify n-gram availability alongside the unigram list
  when filling in ADR 0001's readiness checklist.
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
