# ADR 0001 — First target and native language

**Status:** Proposed
**Date:** 2026-08-03
**Blocks:** ADR 0003, ADR 0004, ADR 0006, and every language-specific rule in the pipeline

## Context

Spec §7.1 constrains the MVP to one native language and one target language, with one
tokenizer, one lemmatizer, one frequency source, one dictionary, and one set of extraction
rules. Everything downstream forks from this choice.

Two pressures point in opposite directions:

- **Tooling quality.** English, Spanish, French, German, and Portuguese have the deepest
  combination of NLP models, dictionary coverage, and subtitle-derived frequency data.
  Less-resourced languages have thinner coverage at every layer.
- **Dogfooding.** Spec §35 Stage 13 requires internal dogfooding, and §34.6 requires a proficient speaker to judge candidate quality. The person building this needs to be
  genuinely learning the target language, or candidate quality cannot be evaluated at all.

Dogfooding wins. A well-tooled language the builder is not learning produces a system
nobody can judge. But the choice must still pass a readiness check, because a target
language missing any one of the six capabilities below blocks a whole stage.

## Decision

While the app should run with one target and one native language at a time (single tokenizer, single lemmatizer, ext...) I am an ambitious language learner aiming to learn multiple languages. Different Target language Native langauge pairs should be selectable, and it should be possible to switch between multiple (the same user possibly practicing multiple langauges at once). Below I filled in the target languages I see myself practicing the soonest.

**Target language:** German, Portuguese, Spanish, French
**Native language:** English

## Readiness checklist

The chosen target language must have all six before Stage 4 begins. Record the specific
resource next to each.

| Capability                          | Needed by                          | Resource | OK  |
| ----------------------------------- | ---------------------------------- | -------- | --- |
| Sentence segmentation               | Stage 4                            |          | ☐   |
| Tokenization + lemmatization        | Stage 4, 5                         |          | ☐   |
| POS tagging                         | Stage 4, 5, 8                      |          | ☐   |
| Named-entity recognition            | Stage 5 (§14.5 entity suppression) |          | ☐   |
| Frequency data                      | Stage 5, 9, 10 (ADR 0004)          |          | ☐   |
| Dictionary with sense-level entries | Stage 6 (ADR 0003)                 |          | ☐   |

NER is the one most often missing, and its absence is not fatal — §14.5 suppresses
isolated named entities, which can fall back to capitalization heuristics plus user
rejection. Everything else is load-bearing.

## Consequences

- The function-word list (Stage 0 step 9) and expression patterns (§14.6) become
  language-specific and live in the `LanguageAdapter`, never in pipeline code.
- Adding a second language is **not** an MVP activity (spec §6, Phase E). The adapter
  interface exists so this stays possible, not so it stays imminent.
- If the readiness checklist fails on more than one row, reconsider the pair rather than
  building workarounds. A weak lemmatizer degrades candidate consolidation, priority
  scoring, and coverage estimation simultaneously — three stages, one root cause.

## Notes

If there is no strong personal pull toward a specific language, Spanish, French, or German
offer the best combination of spaCy model quality, Wiktionary sense coverage, and
subtitle-derived frequency data — in that order.
