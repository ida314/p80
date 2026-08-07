# ADR 0003 — Dictionary provider

**Status:** Accepted — Option A, both Wiktionary editions
**Date:** 2026-08-03
**Decided:** 2026-08-07
**Depends on:** ADR 0001 (German → English)
**Blocks:** Stage 6 (dictionary grounding)

## Context

Spec §14.9 makes the dictionary the **lexical authority** and the LLM merely an explainer.
§16.2 requires every approved meaning to store the provider, a provider entry identifier
where available, and the selected sense. That makes two properties non-negotiable:

- **Sense-level entries with stable identifiers.** A provider returning one flat
  definition string cannot support sense disambiguation (§13.1) or provenance (§16.2).
- **Availability at pipeline speed.** Enrichment looks up every gated candidate. A
  rate-limited network call in that loop makes ingestion slow and flaky, and §27.4
  requires provider failure to be handled without fabricating definitions.

## Options

### A. Wiktextract / kaikki.org JSONL dump, indexed locally — **recommended**
Machine-readable Wiktionary extraction. Sense-level entries with definitions, examples,
register and regional labels, and translations. Downloaded once and indexed into SQLite
with FTS.

Why it wins on the properties that matter here:
- **Offline.** No network in the enrichment hot path, no rate limits, no outage mode.
- **Stable sense identifiers** for the provenance §16.2 requires.
- **Register and dialect labels** map directly onto `Register` and `dialectRegion`
  (`docs/contracts/01-domain-model.md` §2).
- **Same shape across languages**, so Phase E multilingual work does not mean a new
  integration per language.
- Aligns with local-first (spec §7.2) — no external request per lookup to disclose.

Cost: large download; coverage and annotation quality vary by language; needs an
index-build step in setup. Licensing is CC BY-SA — attribution required in the UI.

### B. Live dictionary API (Free Dictionary API, Wordnik, etc.)
Simple to start.
Cost: rate limits inside the enrichment loop; unofficial APIs have no stability guarantee;
sense identifiers are often unstable or absent, which breaks §16.2; adds a disclosed
external request per candidate.

### C. Commercial API (Oxford, Merriam-Webster, Collins)
Best-curated data, real sense IDs.
Cost: licensing, per-call cost stacked on top of LLM cost, and API keys becoming a
requirement rather than an option — which conflicts with §5.2's "useful with no provider
configured".

### D. Live Wiktionary API
Free and current, but returns wikitext requiring parsing. Option A is the same data with
the parsing already done.

## Decision

**Option A — a local Wiktextract/kaikki.org index — ingesting *both* the English and the
German Wiktionary editions.**

The deciding factor for Option A is that a dictionary lookup happens for every promoted
candidate, and spec §14.9 makes that lookup load-bearing rather than best-effort. Anything
with a rate limit turns the primary quality mechanism into the pipeline's least reliable
step.

### Both editions, with a stated precedence

The two editions are not redundant, and neither alone is sufficient:

| Edition | Contains | Weakness |
|---|---|---|
| **English** (`kaikki.org/dictionary/German`) | German headwords glossed **in English** | Thinner on German-specific senses, regional usage, and idiom coverage |
| **German** (`kaikki.org/dewiktionary`) | German headwords defined **in German**, deeper sense inventory and phraseme coverage | Monolingual — unusable directly as a learner-facing gloss for an English native |

**Precedence rule, and it is a hard one:**

1. Prefer the English edition's sense and gloss. It is directly presentable, which is what
   `DictionaryEntry.senses[].definition` is rendered as.
2. Where the English edition has no entry, or no sense matching the candidate's POS, fall
   back to the German edition. Such a sense is **flagged as native-language-absent**: the
   German definition is real dictionary evidence and grounds the item under §14.9, but the
   *English rendering of it* comes from the LLM and is therefore **unverified** under §16.5.
3. **Never let the LLM's bridge translation be presented as the dictionary's definition.**
   This is the failure mode the two-edition setup introduces, and it is the one thing that
   would quietly convert the lexical authority into an explainer.

Sense inventories differ between editions and are **not merged**. A sense carries its
edition in `providerEntryId` and `senseId`, so provenance under §16.2 stays exact and a
later coverage measurement can attribute recall to the right source.

The German edition also earns its place for a second reason: it is the better source of
**multiword headwords** for the ADR 0009 gazetteer, and the gazetteer is layer 1 of the MWE
funnel and the single largest precision lever available.

## Consequences

- **Added requirement (ADR 0009): extract multiword headwords at index-build time.** The
  gazetteer — every multiword entry compiled into a lemma trie — is layer 1 of the MWE
  funnel and the single largest precision lever available, because its output is
  dictionary-attested and therefore pre-grounded under §14.9. `DictionaryProvider` gains
  `multiwordHeadwords()` for this. It is a build-time pass, not a runtime cost.
- **Note for the future:** if laddering is ever pursued (ADR 0010), ingesting more than the
  English Wiktionary edition becomes necessary — cross-language sense alignment cannot be
  drawn from a single edition. Not a change now; recorded so it is not a surprise.
- **Setup gains two downloads and one index build**, not one. Both editions are indexed into
  the same SQLite FTS store with an `edition` discriminator; the precedence rule above is a
  query-time policy, not two providers.
- **`DictionaryProvider` gains an edition-coverage metric.** How often the German edition is
  the only source is the number that says whether the second dump was worth its cost, and
  it is also the input to the §16.5 unverified rate. Track from the first index build.
- Setup gains a one-time download and index step, documented in the README.
- `DictionaryProvider` (`docs/contracts/04-providers.md` §3) is implemented against a
  local index; the interface is unchanged, so an API-backed provider remains possible.
- `dictionary_provider_version` in `pipeline_versions` records the dump date, so a dump
  refresh is a reprocessable event (spec §27.5).
- Attribution and licence notice must appear in the UI (CC BY-SA).
- A lemma absent from the dictionary is **not** an error: the candidate is marked as
  needing manual sense selection and the LLM explanation is labelled unverified
  (spec §16.5). It never silently becomes a confident definition.
