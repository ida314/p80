# Roadmap

P80 is built in fourteen stages, grouped into seven milestones. The sequence is
**dependency-driven**, not priority-driven — each stage exists where it does because of what
it needs to already work.

The ordering constraint that matters most: **do not begin advanced LLM extraction before the
manual media and review loop works.** An extraction pipeline whose output nobody can review
is unfalsifiable.

Steps and exit criteria for every stage live in `original_spec.md` §35.

---

## M0 — Decisions · Stage 0

No code. Lock the language pair, the providers, and the NLP stack; build the evaluation
corpus. This milestone exists to stop the project expanding into multilingual extraction and
pronunciation grading before the central loop is validated.

## M1 — Vertical slice · Stages 1–3

Skeleton → local media ingestion and transcription → manual learning items with working
review.

**The most important milestone in the project.** At the end of Stage 3 the entire learning
loop works end to end with no *extraction* automation: a user adds a video file, P80
transcribes it, the user selects a phrase by hand and reviews it on a schedule. Everything after this is replacing
manual steps with automatic ones, which is a far safer thing to build than the reverse.

Stage 1 scaffolds **two** clients (ADR 0007): a TUI for management surfaces and a browser
client for media surfaces. Stage 2's transcript view and Stage 3's review UI are both
browser work; the TUI's first real surface arrives with the candidate inbox in Stage 5.

ADR 0015 changed what Stage 2 ingests — local media files rather than embedded video — part
way through it. The stage's shape is unchanged; its media source is not. See ADRs 0015–0018.

Treat 1–3 as one unit. Do not stop after Stage 2 and start extraction.

## M2 — Deterministic extraction · Stages 4–6

Sentence reconstruction, annotation, and **dependency parsing** → observe every word and rank
them → dictionary grounding → **deterministic MWE detection**.

No LLM yet, deliberately. If extraction is not useful without an LLM, an LLM will not fix it.

Two changes from the original spec's staging, both ADR-backed:

- **Stage 5 observes rather than filters** (ADR 0008). Everything eligible is captured; the
  candidate inbox shows what ranking promoted. Enrichment moves after ranking.
- **Stage 6 gains the MWE gazetteer and dependency-relation detection** (ADR 0009). Both are
  deterministic and depend on dictionary work Stage 6 already does, so deferring them to
  Stage 8 would leave the gazetteer unused for a milestone and delay the highest-value item
  type for no reason.

Stage 4's sentence reconstruction is **partly a port rather than a fresh design** — ADR 0013
adopts a three-signal boundary-detection fusion from a prior project and records the
adaptations that are mandatory here.

## M3 — LLM and the MWE tail · Stages 7–8

Structured disambiguation with an evaluation harness → association statistics, cross-video
recurrence, LLM sentence-level MWE proposal, and constructions.

Stage 7 must land its evaluation harness *before* Stage 8, or expression quality becomes
unmeasurable.

## M4 — Adaptation · Stages 9–10

Learner model and adaptive admission → video difficulty. This is where card explosion and
review overload (spec §38.1, §38.6) get their real mitigations, rather than their stopgaps.

## M5 — The loop closes · Stages 11–12

Video learning loop and transfer → struggle diagnosis and recommendations. This is what
distinguishes P80 from a flashcard generator: an item is not finished when it is memorised,
it is finished when it is recognised in the clip it came from.

## M6 — Pilot · Stage 13

Metrics, export, accessibility pass, security review, policy review, dogfooding.

---

## Stages

| Stage | Title | Milestone |
|---|---|---|
| 0 | Lock scope and constraints | M0 |
| 1 | Local application skeleton | M1 |
| 2 | Local media ingestion and transcription | M1 |
| 3 | Manual learning-item prototype | M1 |
| 4 | Core transcript processing | M2 |
| 5 | Word-candidate extraction | M2 |
| 6 | Dictionary grounding | M2 |
| 7 | LLM-assisted disambiguation | M3 |
| 8 | Multiword expressions and constructions | M3 |
| 9 | Learner model and adaptive admission | M4 |
| 10 | Video difficulty | M4 |
| 11 | Video learning loop | M5 |
| 12 | Struggle diagnosis and recommendations | M5 |
| 13 | Metrics, export, and pilot readiness | M6 |

## Definition of done

A stage is complete when **every exit criterion in spec §35 for that stage passes as a test
or an explicitly recorded manual check.** Not when the code exists. Not when it looks right.

The overall MVP definition of done is spec §36.
