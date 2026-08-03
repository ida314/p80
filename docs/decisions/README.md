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

| # | Decision | Status |
|---|---|---|
| [0001](0001-language-pair.md) | First target and native language | Proposed |
| [0002](0002-nlp-stack.md) | NLP stack: TypeScript-only vs. Python sidecar | Proposed |
| [0003](0003-dictionary-provider.md) | Dictionary provider | Proposed |
| [0004](0004-frequency-source.md) | Frequency dataset | Proposed |
| [0005](0005-llm-provider.md) | LLM provider and cost ceiling | Proposed |
| [0006](0006-evaluation-corpus.md) | Hand-labelled evaluation corpus | Proposed |
