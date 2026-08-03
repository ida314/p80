# P80 — Status

> Single source of truth for *where the project is*. Read at the start of every session,
> update at the end of every session. Keep it short — this is a dashboard, not a journal.

**Current stage:** Stage 0 — Lock scope and constraints
**Milestone:** M0 — Decisions (no code)
**Last updated:** 2026-08-03

---

## Now

Stage 0 is a decision stage. **No application code should be written until the six open
decisions below are resolved**, because two of them (target language, NLP stack) determine
the process topology and half the pipeline.

## Blocked on

Six decisions, all drafted as ADRs with recommendations, all awaiting a call:

| ADR | Decision | Blocks |
|---|---|---|
| [0001](decisions/0001-language-pair.md) | Target + native language | Everything downstream |
| [0002](decisions/0002-nlp-stack.md) | NLP stack — TS-only vs. Python sidecar | Stage 1 process topology |
| [0003](decisions/0003-dictionary-provider.md) | Dictionary provider | Stage 6 |
| [0004](decisions/0004-frequency-source.md) | Frequency dataset | Stages 5, 9, 10 |
| [0005](decisions/0005-llm-provider.md) | LLM provider + cost ceiling | Stage 7 |
| [0006](decisions/0006-evaluation-corpus.md) | Evaluation transcript | Stages 4–8 |

ADR 0002 is the one to decide first — it changes the shape of the repo.

## Done

- [x] Repo initialized, `.gitignore`
- [x] Spec frozen at `docs/original_spec.md`
- [x] Contracts extracted to `docs/contracts/` (6 documents), with 11 schema gaps closed
      and 4 spec ambiguities resolved
- [x] `CLAUDE.md` written
- [x] Stage 0 brief + 6 ADRs drafted

## Next actions

1. Decide ADR 0002 (NLP stack) — determines whether the repo has a Python service.
2. Decide ADR 0001 (language pair) — unblocks 0003 and 0004.
3. Build the hand-labelled evaluation transcript (ADR 0006). This is the item most likely
   to get skipped and most expensive to skip.
4. Write the Stage 1 brief, then start the skeleton.

## Milestones

| # | Stages | Outcome | State |
|---|---|---|---|
| M0 | 0 | Scope locked, providers chosen, evaluation set exists | **in progress** |
| M1 | 1–3 | First complete vertical slice: add video → manual item → review it | not started |
| M2 | 4–6 | Deterministic extraction + dictionary-grounded meanings | not started |
| M3 | 7–8 | LLM disambiguation, expressions, constructions | not started |
| M4 | 9–10 | Learner model, adaptive admission, video difficulty | not started |
| M5 | 11–12 | Video loop, struggle diagnosis, recommendations | not started |
| M6 | 13 | Metrics, export, pilot readiness | not started |

## Open questions

- None beyond the six ADRs.

## Notes

- Contracts introduced 11 tables absent from spec §28 (`tokens`, `review_sessions`,
  `known_lexicon`, `known_frequency_bands`, `placement_results`, `video_loop_sessions`,
  `provider_calls`, `transcript_corrections`, `recommendation_feedback`,
  `pipeline_versions`, `construction_patterns`). See `docs/contracts/02-database.md` §2
  for why each is required.
- Four spec ambiguities were resolved rather than left to chance: skill-state duplication,
  transfer-as-card-type, interest weight combination, and occurrence-to-sentence linkage.
