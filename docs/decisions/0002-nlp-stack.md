# ADR 0002 — NLP stack

**Status:** Proposed
**Date:** 2026-08-03
**Blocks:** Stage 1 (repo layout, process topology), Stage 4 (annotation)

## Context

Spec §26.1 mandates an all-TypeScript monorepo "to reduce integration cost". Spec §35
Stage 4 requires tokenization, lemmatization, POS tagging, named-entity recognition, and
morphological features. **These two requirements are in tension, and the spec never
acknowledges it.**

The mature NLP toolchains are Python. The TypeScript options are either
English-specific or substantially weaker. This is the single largest unaddressed
architectural risk in the spec, and it must be settled before Stage 1 lays out the repo.

Downstream consumers of annotation quality:

- §14.5 word candidates — needs POS and NER for suppression
- §14.6 expression candidates — needs POS patterns for verb-particle frames
- §14.8 consolidation — needs lemmatization to merge inflected forms
- §22.1 coverage — needs lemmas for every eligible token, not just candidates
- §22.3 syntactic difficulty — wants dependency depth

## Options

### A. TypeScript-only (`wink-nlp`, `compromise`)
Stays inside §26.1. Fast, in-process, no extra runtime.
Cost: effectively English-only. Weaker NER. No dependency parsing, so §22.3 loses its
best signal. Phase E multilingual becomes a rewrite rather than an adapter.

### B. Python sidecar (spaCy or Stanza) behind `LanguageAdapter` — **recommended**
Full lemma, POS, morphology, NER, and dependency parse. spaCy covers ~25 languages;
Stanza covers more with higher accuracy and lower speed. Adding a language later becomes a
model download plus an adapter, which is what §7.1 actually envisions.
Cost: deviates from §26.1. Adds a Python toolchain to setup and a fourth local process.
Complicates any future desktop packaging (§26.3, already deferred).

### C. UDPipe or a WASM model
Universal Dependencies models covering many languages, in-process, no Python.
Cost: no NER at all. Smaller ecosystem, thinner tooling, more integration work than B for
a strictly worse result.

### D. LLM-based annotation
Rejected outright. Spec §35 Stage 4 explicitly requires structured token data *without*
LLM dependency; cost would scale with transcript length rather than learning value
(§38.10); and non-deterministic annotation makes the fixture tests in §34.2 meaningless.

## Recommendation

**Option B — a Python sidecar running spaCy, wrapped behind `LanguageAdapter`.**

Reasoning:

1. Stage 4 requires four capabilities; only B delivers all four for a non-English target.
2. The application is **already multi-process**. Spec §26.1 defines web, API, and worker,
   and Stage 1 step 10 already requires a single command that starts them all. A fourth
   process is an incremental cost, not a new category of complexity.
3. The deviation from §26.1 is narrow and contained. The sidecar is stateless, exposes one
   narrow HTTP interface matching `LanguageAdapter.annotate`, and is reachable only on
   loopback. If it is later replaced, only the adapter implementation changes.
4. §26.1's stated goal is reducing integration cost. Fighting a TS-only NLP stack for a
   non-English language *is* the integration cost, just relocated somewhere harder to see.

If the target language chosen in ADR 0001 turns out to be English, Option A becomes
genuinely viable and should be reconsidered — it is materially simpler.

## Consequences if B is accepted

- Repo gains `services/nlp/` (Python, FastAPI, spaCy) alongside `apps/`.
- Setup documentation must cover Python and the model download. This is a real cost paid
  by every future contributor, including future agent sessions.
- The sidecar binds to loopback only and is covered by the same §32.5 rules as everything
  else.
- The annotation contract is versioned: `language_adapter_version` in `pipeline_versions`
  changes when the model changes, so annotations can be recomputed and compared (§27.5).
- Integration tests must run with the sidecar unavailable and fail visibly — spec §35
  Stage 4 exit criteria require annotation failures to be visible rather than silently
  ignored.
- `docs/contracts/04-providers.md` §2 already defines the interface, so no contract change
  is required either way. Only the implementation differs.
