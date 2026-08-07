# P80 NLP sidecar

Python + FastAPI + spaCy, behind `LanguageAdapter` (ADR 0002). Loopback only.

**Stage 1 status: stub.** `/health` is real; `/annotate` returns 501. spaCy and
`de_core_news_lg` are installed in Stage 4.

```bash
uv sync                      # from services/nlp
uv run p80-nlp               # or: pnpm dev, from the repo root
```

## Why Python at all

Spec §26.1 mandates an all-TypeScript monorepo. Stage 4 needs lemmatization, POS tagging,
NER, and a **dependency parse** for German. Those two requirements are in tension and the
spec never acknowledges it — ADR 0002 resolves it in favour of a fourth local process.

Dependency output is load-bearing, not a nice-to-have: ADR 0009 generates MWE candidates
from the dependency graph rather than the token sequence, because German separable verbs
are discontinuous (*Ich fange um acht Uhr an* splits `anfangen` across five tokens) and no
n-gram window recovers them.

## Python version

`requires-python = ">=3.11,<3.14"`. spaCy's binary wheels lag new CPython releases, and
`de_core_news_lg` ships as a wheel too. If your default interpreter is newer, `uv` will
fetch a supported one:

```bash
uv python pin 3.13
```

## Rules that apply here

- Bind `127.0.0.1` (spec §32.5). Same rule as the API and vLLM.
- Stateless. No database, no disk state.
- **A sidecar that is down must fail visibly.** It may never degrade into whitespace
  tokenization — spec §35 Stage 4 requires annotation failures to be visible, and a
  plausible wrong lemma is far harder to trace than an outage.
