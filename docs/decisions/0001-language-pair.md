# ADR 0001 — First target and native language

**Status:** Accepted
**Date:** 2026-08-03
**Decided:** 2026-08-07
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

**Native language:** English
**First target language:** German — **the only language MVP ships.**
**Intended later targets:** Portuguese, Spanish, French

The builder is an ambitious language learner aiming at several languages, and the app
should eventually let pairs be selected and switched between, with one user practising more
than one at once. That is the destination. It is not MVP.

**MVP ships and validates exactly one pair: German → English.** Two structural hooks are
built now so the other three are later a model download plus an adapter, never a rewrite:

1. **`LanguageAdapter` is a registry, not a singleton.** Resolution is by
   `profile.target_language`, so a second adapter is a registration, not a branch.
2. **`profile_id` and `target_language` stay on every table that needs them** — already
   true in `docs/contracts/02-database.md`, and `ngram_observations` is language-scoped by
   its primary key.

What is *not* built: a profile switcher UI, a second `LanguageAdapter` implementation, a
second evaluation corpus, or per-language tuning. Those are the actual cost of multi-pair,
and none of them is on the path to validating the learning loop.

### Why German first

German is the hardest of the four and therefore the most informative. Separable verbs
(*Ich fange um acht Uhr an*) are the exact discontinuity case ADR 0009 and ADR 0011 exist
to handle, so the MWE pipeline is stress-tested from the first video rather than in month
four. Tooling is strong across all six capabilities below. A pipeline that works on German
works on Spanish, French, and Portuguese; the reverse does not hold.

## Readiness checklist

The chosen target language must have all six before Stage 4 begins. Resources are **named**
below; **verifying** each is a Stage 1 setup task, and the boxes stay unticked until a
fixture test exercises the resource. A named resource is not a verified one.

| Capability                          | Needed by                          | Resource                                                                      | OK  |
| ----------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------- | --- |
| Sentence segmentation               | Stage 4                            | spaCy `de_core_news_lg`, parser-based sentence boundaries (ADR 0002)           | ☐   |
| Tokenization + lemmatization        | Stage 4, 5                         | spaCy `de_core_news_lg` — **see risk below**                                   | ☐   |
| POS tagging                         | Stage 4, 5, 8                      | spaCy `de_core_news_lg`, TIGER + UD tagsets                                    | ☐   |
| Named-entity recognition            | Stage 5 (§14.5 entity suppression) | spaCy `de_core_news_lg` NER (PER/LOC/ORG/MISC)                                 | ☐   |
| Frequency data                      | Stage 5, 9, 10 (ADR 0004)          | OpenSubtitles-DE, self-built unigram + n-gram counts; SUBTLEX-DE as a fixture  | ☐   |
| Dictionary with sense-level entries | Stage 6 (ADR 0003)                 | kaikki.org Wiktextract, English **and** German editions                        | ☐   |

**Named risk — German lemmatization.** spaCy's German lemmatizer is rule- and lookup-based
rather than neural, and it is weakest on exactly the forms P80 cares about: verb
inflection and separable-verb reunification. This matters three times over — §14.8
consolidation, §22.1 coverage, and MWE lemma-sequence identity all key on the lemma, so one
bad lemmatizer degrades three stages with a single root cause the symptoms do not point at.

Verify against the ADR 0006 corpus at Stage 4 rather than assuming. If lemma accuracy is
the bottleneck, the fallback is Stanza for German inside the same sidecar — ADR 0002 chose
the topology, not an irreversible model, and swapping is a `language_adapter_version` bump.

NER is the capability most often missing and its absence would not be fatal — §14.5
suppresses isolated named entities, which can fall back to capitalization heuristics plus
user rejection. In German, capitalization is a *weak* fallback because all nouns are
capitalized, so the model's NER is worth more here than in the other three languages.
Everything else on the list is load-bearing.

## Consequences

- The function-word list (Stage 0 step 9) and expression patterns (§14.6) become
  German-specific and live in the `LanguageAdapter`, never in pipeline code.
- **`LanguageAdapter` is resolved from a registry keyed by `profile.target_language`.**
  This is the one interface change the multi-language ambition costs today; ADR 0010 already
  anticipated it. `docs/contracts/04-providers.md` §2 gains the registry contract.
- Adding a second language remains **out of MVP scope** (spec §6, Phase E). The registry
  exists so this stays possible, not so it stays imminent. `CLAUDE.md` §2 rule 17 still
  binds: a task drifting toward multilingual support gets flagged, not built.
- The evaluation corpus (ADR 0006) is German-only. A second language needs its own, and
  that cost — not the adapter — is the real reason multi-pair is deferred.
- If the readiness checklist fails on more than one row, reconsider the language rather than
  building workarounds. The lemmatizer risk above is the one to watch.

## Notes

Ordering rationale for the deferred three, recorded so it is not re-derived: Spanish has the
best combined tooling, French next, Portuguese thinnest — but all three are easier than
German on the axes that break pipelines, which is why German goes first rather than last.
