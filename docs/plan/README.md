# Build Plan

The stage sequence comes from original spec §35 and is **dependency-driven**. The ordering
constraint that matters most: *do not begin advanced LLM extraction before the manual
media and review loop works.*

## How this directory works

Stage briefs are written **one at a time, immediately before starting the stage** — not
all up front. A brief written today for Stage 8 would encode assumptions about code that
does not exist yet, and would be stale by the time anyone read it.

Each brief is generated from three inputs:
1. The stage's steps and exit criteria in spec §35
2. The relevant `docs/contracts/` documents
3. The actual state of the repo at that moment

Use `_template.md`. Keep briefs to roughly one page.

## Milestones

Stages are grouped so that each milestone ends somewhere worth stopping.

### M0 — Decisions · Stage 0
No code. Lock the language pair, providers, and NLP stack; build the evaluation corpus.
Exists to stop the project expanding into multilingual extraction and pronunciation
grading before the central loop is validated.

### M1 — Vertical slice · Stages 1–3
Skeleton → manual video and transcript ingestion → manual learning items with working
review. **The most important milestone in the project.** At the end of Stage 3 the entire
learning loop works end to end with zero automation. Everything after this is replacing
manual steps with automatic ones, which is a far safer thing to build.

Stage 1 scaffolds **two** clients (ADR 0007): `apps/tui` for management surfaces and
`apps/web` for media surfaces. Stage 2's transcript view and Stage 3's review UI are both
browser work; the TUI's first real surface arrives with the candidate inbox in Stage 5.

Treat 1–3 as one unit. Do not stop after Stage 2 and start extraction.

### M2 — Deterministic extraction · Stages 4–6
Sentence reconstruction, annotation, and **dependency parsing** → observe every word and
rank them → dictionary grounding → **deterministic MWE detection**. No LLM yet. If
extraction is not useful without an LLM, an LLM will not fix it.

Two changes from the spec's staging, both from ADR 0008 and ADR 0009:

- Stage 5 *observes* rather than *filters*. Everything eligible is captured; the candidate
  inbox shows what ranking promoted (`07-extraction.md` §6). Enrichment moves after ranking.
- Stage 6 gains the **MWE gazetteer and dependency-relation detection**. Both are
  deterministic and depend on the dictionary work Stage 6 already does, so deferring them
  to Stage 8 would leave the gazetteer unused for a milestone and delay the highest-value
  item type for no reason.

### M3 — LLM and the MWE tail · Stages 7–8
Structured disambiguation with an evaluation harness → association statistics, cross-video
recurrence, LLM sentence-level MWE proposal, and constructions. Stage 7 must land its
evaluation harness *before* Stage 8, or expression quality becomes unmeasurable.

### M4 — Adaptation · Stages 9–10
Learner model and adaptive admission → video difficulty. This is where card explosion
(§38.1) and review overload (§38.6) get their real mitigations.

### M5 — The loop closes · Stages 11–12
Video learning loop and transfer → struggle diagnosis and recommendations. This is what
distinguishes P80 from a flashcard generator.

### M6 — Pilot · Stage 13
Metrics, export, accessibility pass, security review, policy review, dogfooding.

## Stage index

| Stage | Title | Milestone | Brief | State |
|---|---|---|---|---|
| 0 | Lock scope and constraints | M0 | [stage-00](stage-00-decisions.md) | in progress |
| 1 | Local application skeleton | M1 | — | not started |
| 2 | Manual video and transcript ingestion | M1 | — | not started |
| 3 | Manual learning-item prototype | M1 | — | not started |
| 4 | Core transcript processing | M2 | — | not started |
| 5 | Word-candidate extraction | M2 | — | not started |
| 6 | Dictionary grounding | M2 | — | not started |
| 7 | LLM-assisted disambiguation | M3 | — | not started |
| 8 | Multiword expressions and constructions | M3 | — | not started |
| 9 | Learner model and adaptive admission | M4 | — | not started |
| 10 | Video difficulty | M4 | — | not started |
| 11 | Video learning loop | M5 | — | not started |
| 12 | Struggle diagnosis and recommendations | M5 | — | not started |
| 13 | Metrics, export, and pilot readiness | M6 | — | not started |

Steps and exit criteria for every stage are in `docs/original_spec.md` §35. Do not copy
them here — copies drift.

## Definition of done

A stage is complete when **every exit criterion in spec §35 for that stage passes as a
test or an explicitly recorded manual check**. Not when the code exists. Not when it
looks right.

The overall MVP definition of done is spec §36. Re-read it at the start of M6.
