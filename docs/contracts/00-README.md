# P80 Contracts

These documents are the **authoritative specification for implementation**.

`docs/original_spec.md` is frozen. It records the original product intent and is never
edited. When implementation reveals that the original spec is wrong, incomplete, or
ambiguous, the resolution lands **here**, and the reasoning lands in `docs/decisions/`.

That separation is deliberate: it must always be possible to see what was originally
intended and what is now believed, without one silently overwriting the other.

## Documents

| File | Covers | Original spec sections |
|---|---|---|
| `01-domain-model.md` | Terminology, `LearningItem`, forms, occurrences, enums, function-word policy | §9, §13, §15 |
| `02-database.md` | SQLite schema, including tables missing from the original spec | §28 |
| `03-api.md` | HTTP surface, request/response shapes, error envelope | §29 |
| `04-providers.md` | Media source, dictionary, LLM, and language adapter interfaces | §8, §16, §7.1 |
| `05-cards-and-review.md` | Card types, review flow, FSRS integration, session generation | §18, §19, §30 |
| `06-scoring.md` | Every formula: priority, struggle, recommendation, difficulty, `P_known` | §14.11–§14.12, §17, §22, §23.1, §24.2 |

## Rules for changing a contract

1. A contract may only be changed by a deliberate act, never as a side effect of
   implementing a feature.
2. Any change that alters an interface, a table, or a formula requires an ADR in
   `docs/decisions/`.
3. Additive clarification (naming a field the spec left unnamed, defining an enum the
   spec used but never listed) does not require an ADR — but must be marked with
   `<!-- ADDED: not in original spec -->` so it stays visible as a derived decision.
4. If a contract and `original_spec.md` disagree, the contract wins for code, and the
   disagreement must be explained in the contract at the point of divergence.

## Markers used in these documents

- **`ADDED`** — not present in the original spec; introduced here to close a gap.
- **`RESOLVED`** — the original spec was ambiguous or self-contradictory; the chosen
  reading and its rationale are stated inline.
- **`DEFERRED`** — explicitly out of MVP scope; recorded so it is not re-litigated.
