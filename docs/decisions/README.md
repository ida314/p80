# Architecture Decision Records

One file per decision. Numbered, immutable once accepted.

## When to write one

Write an ADR when a decision changes an **interface, a table, a formula, or a
dependency** — or when you find yourself about to make the same argument a second time.

Do not write one for ordinary implementation choices. The test is whether a reasonable
person could arrive later, see the code, and ask "why is it like this?"

## Status values

- **Proposed** — drafted with a recommendation, awaiting a decision
- **Accepted** — decided; binding on all code
- **Superseded by NNNN** — replaced; the file stays, so the history stays readable
- **Rejected** — considered and declined; kept so it is not re-proposed

Never delete an ADR. The value is in the record of what was considered.

## Index

| # | Decision | Outcome | Status |
|---|---|---|---|
| [0001](0001-language-pair.md) | First target and native language | German → English; one pair ships, adapter registry hook | Accepted |
| [0002](0002-nlp-stack.md) | NLP stack: TypeScript-only vs. Python sidecar | Python sidecar, spaCy `de_core_news_lg` | Accepted |
| [0003](0003-dictionary-provider.md) | Dictionary provider | Local Wiktextract index, **both** en + de editions | Accepted |
| [0004](0004-frequency-source.md) | Frequency dataset | Self-built OpenSubtitles unigram + n-gram; SUBTLEX-DE as a test fixture | Accepted |
| [0005](0005-llm-provider.md) | LLM provider and resource ceiling | **Local inference only** — vLLM, no cloud adapter, no API keys | Accepted |
| [0006](0006-evaluation-corpus.md) | Hand-labelled evaluation corpus | Two videos, same channel, two labelling passes | Accepted |
| [0007](0007-ui-topology.md) | UI topology: TUI for management, browser for media | Two clients, one API | Accepted |
| [0008](0008-recall-first-extraction.md) | Recall-first extraction: three tiers, lazy enrichment | | Accepted |
| [0009](0009-mwe-identification.md) | Multiword expression identification and storage | Amended by 0011 | Accepted |
| [0010](0010-multilanguage-forward-compat.md) | Multi-language: two hooks now, laddering deferred | | Accepted |
| [0011](0011-mwe-unithood-and-idiomaticity.md) | MWE unithood and idiomaticity as separate scores | Two scores, contiguous base generator | Accepted |
| [0012](0012-database-layer.md) | Database access layer | Drizzle over `better-sqlite3`; migrations hand-authored, never generated | Accepted |

**All 12 ADRs are accepted as of 2026-08-07.** Two questions inside ADR 0011 remain open by
design; both resolve by measurement at Stage 8.

One decision is deliberately deferred rather than made: the **TUI framework**. ADR 0007
requires the client but names no stack, and the surface that decides it is the candidate
inbox in Stage 5. Stage 1 ships a framework-free CLI; ADR 0013 gets written when there is
a real screen to choose against.
