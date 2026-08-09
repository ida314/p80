# P80

A local-first language-learning application. It turns video files you already have into a
small, high-value curriculum of words, multiword expressions, and constructions — then
trains recognition, production, and contextual transfer while reconnecting each item to the
clip it came from.

**Status: in development.** The application skeleton and schema are complete; the learning
loop is being built. Not yet usable.

---

## What makes it different

Most tools built on video transcripts are flashcard generators with a fancier input. P80
differs in three ways, each of which shapes the architecture rather than decorating it:

**Capture is complete; ranking decides visibility.** Extraction observes every eligible
lexical unit in a transcript. Nothing is ever discarded for being *low value* — only for not
being a language item at all. The reason is that the two error types are not symmetric: a
false positive costs one keystroke and is visible in an inbox, while a false negative is
invisible forever, with no query that could ever surface it.

**Nothing becomes a learning item without you saying so.** There is no auto-approval path,
not even a disabled one. The pipeline proposes; the user disposes.

**An item is not finished when it is memorised.** It is finished when you recognise it in
the clip it came from, at speed, without subtitles. That is what the video loop exists for.

## Constraints

Several of these are unusual enough to state up front, because they rule out approaches a
reader might otherwise assume:

- **P80 never acquires media.** You point it at a video file you already have; it reads
  that file where it is. No downloader, no stream extraction, and no copy — the application
  stores a reference, so its own storage never holds a gigabyte of video. Deleting a video
  in P80 does not touch your library.
- **Transcripts come from the file, not from the network.** Speech recognition runs locally
  on your own hardware. If you already have a subtitle file, supply it and it wins.
- **All inference is local.** The application holds no API keys and has no cloud provider.
  Language models run on your own hardware, on loopback.
- **The application makes no outbound requests at runtime — the list is empty.** Not the
  API, not the worker, not the sidecar, not the browser client. The dictionary, frequency,
  speech, and language-model artifacts are downloaded once during setup, and after that P80
  works with the network unplugged. No remote analytics, ever.
- **Binds to `127.0.0.1`.** LAN exposure is opt-in behind a warning.
- **The dictionary is the lexical authority; the language model is an explainer.** A
  definition without dictionary evidence is labelled unverified rather than presented as
  fact. Uncertainty is displayed, never hidden.
- **It works with no language model configured.** This is tested, not assumed.

One target language ships: **German → English.** Everything language-specific lives behind a
`LanguageAdapter` resolved from a registry, so a second language is a new adapter rather than
a refactor — but adding one is explicitly out of scope for now.

## Architecture

Two clients over one API, split by whether the surface needs media:

```
apps/tui        management surfaces — candidate inbox, items, stats, jobs, settings
apps/web        media surfaces — review sessions, video loop, video detail
apps/api        Node + TypeScript + Fastify + Zod
apps/worker     Node + TypeScript, SQLite-backed job polling
services/nlp    Python + FastAPI — spaCy annotation and local speech
                recognition. Loopback only.

packages/core               domain logic, scoring, pipeline stages
packages/database           schema + migrations (SQLite, explicit migrations)
packages/language-adapters  per-language behaviour
packages/providers          dictionary, LLM, and media adapters
packages/shared-ui          web only
```

Both clients talk to `/api/*` and nothing else. **Clients hold no domain logic** — scoring,
session generation, and scheduling live in `packages/core`, and a `curl` script can complete
a full review session.

## Setup

Setup is **not** `pnpm install`. It needs `ffmpeg` on the path and a speech-recognition
model; from Stage 4 it also downloads a spaCy model, two Wiktextract dumps, and a subtitle
corpus, then builds a dictionary index and frequency counts. Every step is written down in
**[`docs/SETUP.md`](docs/SETUP.md)**.

`P80_MEDIA_ROOT` must point at your video library before anything can be ingested. It is
the only directory P80 will read media from, and it has no default.

```bash
pnpm install
pnpm db:migrate
pnpm dev          # api + worker + web + nlp sidecar
```

```
pnpm test         vitest, unit + integration
pnpm typecheck    tsc --noEmit across all TypeScript packages
pnpm db:backup    snapshot the database (VACUUM INTO, not a copy)
```

A local model server is managed separately from `pnpm dev`, since it is long-lived and
expensive to start.

## Documentation

[**`docs/README.md`**](docs/README.md) is the index and explains how the tree is organised.
The short version:

- [`docs/contracts/`](docs/contracts/00-README.md) — **authoritative** for data shapes,
  endpoints, interfaces, and formulas. Read before writing code that touches any of them.
- [`docs/decisions/`](docs/decisions/README.md) — why anything is the way it is.
- [`docs/roadmap.md`](docs/roadmap.md) — the stages and their ordering.
- [`docs/original_spec.md`](docs/original_spec.md) — original product intent, frozen.

Where a contract and the original spec disagree, the contract wins; the divergence is marked
inline and backed by an ADR.
