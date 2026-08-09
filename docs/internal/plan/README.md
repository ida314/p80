# Stage briefs — working notes

The milestone narrative and stage list live in `docs/roadmap.md`; this directory holds the
working briefs and their live state.

## How this directory works

Stage briefs are written **one at a time, immediately before starting the stage** — not all
up front. A brief written today for Stage 8 would encode assumptions about code that does
not exist yet, and would be stale by the time anyone read it.

Each brief is generated from three inputs:

1. The stage's steps and exit criteria in spec §35
2. The relevant `docs/contracts/` documents
3. The actual state of the repo at that moment

Use `_template.md`. Keep briefs to roughly one page.

## Stage index

| Stage | Title | Brief | State |
|---|---|---|---|
| 0 | Lock scope and constraints | [stage-00](stage-00-decisions.md) | in progress |
| 1 | Local application skeleton | [stage-01](stage-01-skeleton.md) | **done** |
| 2 | Manual video and transcript ingestion | [stage-02](stage-02-ingestion.md) | in progress |
| 3 | Manual learning-item prototype | — | not started |
| 4 | Core transcript processing | — | not started |
| 5 | Word-candidate extraction | — | not started |
| 6 | Dictionary grounding | — | not started |
| 7 | LLM-assisted disambiguation | — | not started |
| 8 | Multiword expressions and constructions | — | not started |
| 9 | Learner model and adaptive admission | — | not started |
| 10 | Video difficulty | — | not started |
| 11 | Video learning loop | — | not started |
| 12 | Struggle diagnosis and recommendations | — | not started |
| 13 | Metrics, export, and pilot readiness | — | not started |

Steps and exit criteria for every stage are in `docs/original_spec.md` §35. Do not copy them
here — copies drift.

## Definition of done

A stage is complete when **every exit criterion in spec §35 for that stage passes as a test
or an explicitly recorded manual check**. Not when the code exists. Not when it looks right.

Before starting Stage 4, read ADR 0013 — its sentence reconstruction is partly a port, with
four mandatory adaptations.
