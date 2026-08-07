# P80 — Status

> Single source of truth for *where the project is*. Read at the start of every session,
> update at the end of every session. Keep it short — this is a dashboard, not a journal.

**Current stage:** Stage 0 — Lock scope and constraints
**Milestone:** M0 — Decisions (no code)
**Last updated:** 2026-08-06

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

**Also awaiting a call, but not blocking M0:**
[ADR 0011](decisions/0011-mwe-unithood-and-idiomaticity.md) — MWE unithood and idiomaticity
as separate scores. Blocks Stages 6 and 8. Its one open decision (idiom dictionary only, or
dictionary plus embedding path) is deliberately deferred to Stage 8 and decided by
measurement, so accepting the ADR does not require answering it now.

## Done

- [x] Repo initialized, `.gitignore`
- [x] Spec frozen at `docs/original_spec.md`
- [x] Contracts extracted to `docs/contracts/` (6 documents), with 11 schema gaps closed
      and 4 spec ambiguities resolved
- [x] `CLAUDE.md` written
- [x] Stage 0 brief + 6 ADRs drafted
- [x] **ADR 0007 accepted** — TUI for management surfaces (candidate inbox, items, stats,
      diagnostics, jobs, settings), browser for media surfaces (review, video loop).
      Two clients, one API, no domain logic in either.
- [x] **ADRs 0008–0010 accepted** — extraction rewritten from filter-first to recall-first.
      Three tiers (observed → candidate → item), validity gates only, lazy enrichment,
      global ranked queue with a per-video floor, MWE generation on the dependency graph.
      New contract `07-extraction.md`; every other contract updated to match.
- [x] **ADR 0011 drafted** — MWE identification reworked. Contiguous enumeration becomes the
      base generator with dependency paths as the discontinuity extension; qualification
      moves from a boolean disjunction to two ranked scores (unithood, idiomaticity) with
      stored breakdowns. New `06-scoring.md` §9; `07-extraction.md` §10 rewritten;
      `ngram_observations` gains idiomaticity columns.

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

- **Idiom dictionary only, or dictionary plus embedding/LLM non-compositionality?**
  (ADR 0011). Not either/or — the dictionary is both a signal and the ground truth the other
  signals are tuned against, so it is built first regardless. The real question is whether
  the embedding path ships in MVP. Recommended resolution is a measurement, not a debate:
  build the dictionary path in Stage 6, then measure its recall against the ADR 0006 idiom
  labels at Stage 8. Nothing is blocked on answering it today.
- **ADR 0006's labelling scope grew.** The evaluation corpus now needs MWE spans labelled on
  two axes — unithood and idiomaticity — not one. Scope this before Stage 8; it is the item
  most likely to be underestimated.

## Notes

- Contracts introduced 11 tables absent from spec §28 (`tokens`, `review_sessions`,
  `known_lexicon`, `known_frequency_bands`, `placement_results`, `video_loop_sessions`,
  `provider_calls`, `transcript_corrections`, `recommendation_feedback`,
  `pipeline_versions`, `construction_patterns`). See `docs/contracts/02-database.md` §2
  for why each is required.
- Four spec ambiguities were resolved rather than left to chance: skill-state duplication,
  transfer-as-card-type, interest weight combination, and occurrence-to-sentence linkage.
- ADR 0007 splits the UI in two, so Stage 1 scaffolds `apps/tui` **and** `apps/web`. The
  TUI's first real surface is the candidate inbox in Stage 5; Stages 2–3 are browser work.
- The contracts now diverge from the frozen spec in two named places, both ADR-backed:
  §14.10's reject-on-value gates (ADR 0008) and §27.1's enrich-before-score job order
  (ADR 0008, forced by lazy enrichment). Both are marked `RESOLVED` inline.
- ADR 0011 amends ADR 0009 in two places rather than superseding it. Generation and storage
  stand; what changes is that n-gram enumeration is no longer a rejected alternative (it is
  the base generator), and 0009's claim that recurrence "cannot be recomputed" is corrected —
  `ngram_observations` is a materialized index over the immutable `tokens` table, so every
  write policy is reversible by backfill. That reframe is what makes the remaining threshold
  questions performance decisions rather than recall decisions.
- ADR 0011 also fixes a defect in `07-extraction.md` §10.1: MWE generation was specified as
  extracting `(head, dependent)` arcs, which cannot express its own headline example
  (*warten auf* is a two-hop `obl→case` path with the noun excluded) and breaks UD `fixed` /
  `flat`, which are n-ary chains. `MweRelationSpec` was declared in `04-providers.md` with no
  shape; it now has one.
- ADR 0001 was edited to select four target languages rather than one. That is a scope
  expansion past spec §7.1 — worth deciding whether MVP *ships* multi-pair or merely
  doesn't preclude it. The contracts already carry `profile_id` and `target_language`
  where needed; the real cost is running the readiness checklist per language and making
  `LanguageAdapter` a registry rather than a singleton.
