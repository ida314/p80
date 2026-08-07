# Setup

**Setup is not `pnpm install`.** From Stage 4 it also downloads a spaCy model, two
Wiktextract dumps, and the OpenSubtitles corpus, then builds a dictionary index and a
frequency count. Every step is written down here because it is a real cost paid by every
future contributor, agent sessions included.

Stage 1 needs only the first section.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | ≥ 22 | API, worker, clients |
| pnpm | ≥ 10 | Workspaces |
| uv | any recent | Python toolchain for the NLP sidecar (ADR 0002) |

`better-sqlite3` and `esbuild` run install scripts. They are allow-listed in
`pnpm-workspace.yaml` under `allowBuilds`, with a note explaining why each is permitted.
Both are build-time only, so spec §32.2's empty steady-state external-request list still
holds.

## Stage 1 — the skeleton

```bash
git clone <repo> && cd p80
pnpm install

cp .env.example .env.local          # optional; defaults work

# Python sidecar. uv reads services/nlp/.python-version and fetches 3.13 if needed.
uv sync --project services/nlp

pnpm db:migrate                     # optional; the API and worker also migrate on start
pnpm dev                            # api + worker + web + nlp
```

Then, in another terminal:

```bash
bash scripts/smoke.sh               # 10 checks against the running system
pnpm --filter @p80/tui dev health   # the management client
```

Open <http://127.0.0.1:5173>.

### Why the Python version is pinned

`services/nlp/pyproject.toml` sets `requires-python = ">=3.11,<3.14"` and
`.python-version` pins 3.13.

spaCy's binary wheels lag new CPython releases by months, and `de_core_news_lg` ships as
a wheel too. Without the pin, Stage 4's model install fails partway through a large
download on a machine whose default interpreter is newer. With it, `uv sync` says so
immediately.

If uv reports no interpreter:

```bash
uv python install 3.13
```

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Starts api, worker, web, and the NLP sidecar |
| `pnpm test` | Vitest, unit + integration |
| `pnpm typecheck` | `tsc --noEmit` across all nine TypeScript packages |
| `pnpm db:migrate` | Applies pending migrations |
| `pnpm db:backup` | Snapshots the database into `data/backups/` |
| `pnpm dev:noop` | Enqueues a `NOOP` job so the worker has something to claim |
| `bash scripts/smoke.sh` | End-to-end check against a running `pnpm dev` |
| `uv run --project services/nlp pytest services/nlp/tests` | Sidecar tests |

## Two processes `pnpm dev` does *not* start

Both are long-lived and expensive to start, so they are managed outside the dev command
(`CLAUDE.md` §4).

### vLLM (ADR 0005)

Serves the local model on loopback, OpenAI-compatible. **Expect it to be down through
Stages 1–6** — that is the spec §5.2 degraded path getting free exercise, not a
misconfiguration. Nothing in P80 performs a startup provider check, and no surface treats
an absent model as an error.

Point `P80_VLLM_BASE_URL` and `P80_VLLM_MODEL_ID` at it when you run one.

### uselimit

Enforces the enrichment ceilings — 100 candidates per video and 45 minutes per job, both
hard; 40 h/month, warn only. Not integrated until enrichment exists in Stage 6. It needs
a transactional SQLite `StorageAdapter` written upstream first, because the shipped
`InMemoryAdapter` is single-process and both the API and the worker consume budget.

## Stage 4 and later — the expensive parts

Not yet needed. Recorded so the shape of the work is visible:

- spaCy `de_core_news_lg` (~500 MB) into the sidecar's environment
- Wiktextract dumps for **both** the English and German Wiktionary editions (ADR 0003)
- The OpenSubtitles-DE corpus, and a unigram + n-gram counting pass (ADR 0004)
- A dictionary index build into a local SQLite FTS store

## Configuration

`.env.local` holds **local endpoint configuration only**. There are no API keys in P80
(ADR 0005) — nothing here is a secret. The set of variables the application reads is
closed and asserted by a test; see `.env.example` for the list.

Every service binds `127.0.0.1`. `P80_ALLOW_LAN=true` opts into LAN exposure and logs a
warning at startup (spec §32.5).
