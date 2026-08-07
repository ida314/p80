# Stage 0 — Lock scope and constraints

**Milestone:** M0
**Depends on:** nothing
**Spec reference:** `docs/original_spec.md` §35, Stage 0

## Objective

Make the decisions that determine the repo's shape, so that no code is written twice.
**This stage produces no application code.**

Stage 0 exists to stop the project expanding into multilingual extraction, pronunciation
grading, and unrestricted YouTube ingestion before the central learning loop is validated.

## Steps

Spec §35 Stage 0 lists twelve steps. Their current state:

- [x] 1. Select the first target language → **ADR 0001** — German
- [x] 2. Select the native language → **ADR 0001** — English
- [x] 3. Select one frequency-data source → **ADR 0004** — self-built OpenSubtitles-DE
      unigram + n-gram counts; SUBTLEX-DE committed as a correlation fixture, not a source
- [x] 4. Select one dictionary provider → **ADR 0003** — local Wiktextract index over
      **both** the English and German Wiktionary editions
- [x] 5. Select one optional LLM provider → **ADR 0005** — local vLLM only. No cloud
      adapter, no API keys
- [x] 6. Confirm the MVP requires user-supplied or authorized transcripts
      → recorded in `CLAUDE.md` §2 and `docs/contracts/04-providers.md` §1
- [ ] 7. Write source-use and privacy notices → `docs/policy/`. **Substantially smaller
      than drafted:** ADR 0005 removed the only outbound data flow, so the privacy notice
      documents a system that makes no external requests at all. Source-use still needs
      writing — YouTube ToS posture, CC BY-SA attribution for both Wiktionary editions,
      OpenSubtitles corpus terms
- [x] 8. Define the exact supported transcript formats
      → VTT, SRT, pasted timestamped text, internal JSON
      (`docs/contracts/04-providers.md` §1)
- [ ] 9. Define the initial German function-word list → unblocked by ADR 0001; policy
      already fixed in `docs/contracts/01-domain-model.md` §6. Lives in the German
      `LanguageAdapter`, never in pipeline code
- [ ] 10. Create a hand-labelled evaluation transcript → **ADR 0006**. Scope is now
      **Pass A only** — video 1, exhaustive word labels. Pass B (spans, both axes, video 2)
      is a Stage 8 exit criterion, not Stage 0 work
- [x] 11. Define the north-star metric → `delayed_transfer_correct_per_hour`
      (`docs/contracts/06-scoring.md` §7)
- [x] 12. Freeze post-MVP features → spec §6 non-goals, restated as binding in
      `CLAUDE.md` §2 rule 17

Additional work completed in this stage beyond the spec's list:

- [x] Extract `docs/contracts/` from the frozen spec
- [x] Close 11 schema gaps and resolve 4 spec ambiguities
- [x] Establish `CLAUDE.md`, `STATUS.md`, ADR process
- [x] Decide UI topology — ADR 0007, accepted. Affects the Stage 1 repo layout as much as
      ADR 0002 does, so it belonged here rather than in Stage 1.
- [x] Replace the filter-first extraction model with recall-first — ADRs 0008 (three tiers,
      lazy enrichment), 0009 (MWE identification), 0010 (multi-language hooks). Adds
      `docs/contracts/07-extraction.md` and diverges from spec §14.10 and §27.1.

## Exit criteria

| # | Criterion (spec §35) | Verified by | State |
|---|---|---|---|
| 1 | One language pair selected | ADR 0001 accepted — German → English | ☑ |
| 2 | Data providers selected | ADRs 0003, 0004, 0005 accepted | ☑ |
| 3 | YouTube download behaviour excluded | `CLAUDE.md` §2 rules 1–5 | ☑ |
| 4 | Hand-labelled evaluation set exists | Pass A committed under `fixtures/eval/de/`, ADR 0006 | ☐ |
| 5 | MVP goals and non-goals approved | spec §5–§6 restated in `CLAUDE.md` §2 rule 17 | ☑ |
| 6 | NLP stack decided | ADR 0002 accepted — Python sidecar, spaCy | ☑ |

Criterion 6 is added here rather than taken from the spec, which omits it. Stage 1 cannot
lay out the repo without it.

**Only criterion 4 is outstanding.** All eleven ADRs are accepted; what remains in Stage 0
is labelling work, plus steps 7 and 9, neither of which blocks Stage 1.

## Decision order

ADR 0002 first — it decides whether the repo contains a non-TypeScript service, which
changes the Stage 1 skeleton. Then 0001, which unblocks 0003 and 0004. Then 0005. ADR 0006
depends only on 0001 and is the longest-running item, so start it as soon as 0001 lands.

## Explicitly out of scope

- Any application code, scaffolding, or `package.json`. That is Stage 1.
- Choosing UI libraries, styling approach, or component structure.
- Evaluating more than one option per provider slot. One dictionary, one frequency source,
  one LLM (spec §7.1). Comparison shopping is post-MVP.

## Risks

- **§38.10 LLM operating cost** — mitigated by setting a cost ceiling in ADR 0005 before
  any provider code exists, and by `provider_calls` cost tracking from day one.
- **§38.8 YouTube dependency** — mitigated by the hard media rules being written down
  before anyone is tempted by a shortcut.
- **Skipping the evaluation corpus** — the highest-probability failure of this stage.
  Without it, Stages 4–8 are tuned on anecdotes, which spec §34.5 explicitly forbids. It
  is boring, manual, and blocks nothing immediately, which is exactly why it gets skipped.

## Notes

The evaluation corpus should cover the categories in spec §34.2: normal sentences,
subtitle line breaks, false starts, slang, named entities, multiword expressions,
ambiguous words, overlapping captions, missing punctuation, code-switching, and offensive
or sensitive language. One 10-minute video hand-annotated with the items actually worth
learning is enough to start; breadth matters more than volume.
