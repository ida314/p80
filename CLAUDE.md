# P80 — Working Instructions

P80 is a **local-first language-learning application**. It turns user-selected YouTube
videos plus user-supplied transcripts into a small, high-value curriculum of words,
multiword expressions, and constructions, then trains recognition, production, and
contextual transfer while reconnecting each item to its original source clip.

Read this file first. Then read `docs/STATUS.md` to find out where the project is.

---

## 1. Document map — read the right thing

| Need | Read |
|---|---|
| Where the project is right now | `docs/STATUS.md` |
| What to build in the current stage | `docs/plan/stage-NN-*.md` |
| Data shapes, schema, endpoints, interfaces, formulas | `docs/contracts/` — **authoritative** |
| Why a decision was made | `docs/decisions/` |
| Original product intent and rationale | `docs/original_spec.md` — **frozen, never edit** |

**Before writing code that touches a data shape, an endpoint, a provider, or a formula,
read the relevant file in `docs/contracts/`.** They are the specification; the original
spec is the intent behind it. Where they disagree, the contract wins and the divergence is
already documented inline.

Do not edit `docs/original_spec.md`. Ever. If it is wrong, fix the contract and write an
ADR.

---

## 2. Hard rules

These come from product policy and legal constraints, not preference. Violating one is a
defect regardless of how well it works.

### Media (spec §8, §38.8)
1. **Never download YouTube video or audio.** No `yt-dlp`, no stream extraction, no media
   proxying. If a task seems to require it, the task is wrong — stop and ask.
2. **Never isolate or store an audio track.**
3. **Never scrape public captions.** Transcripts are user-supplied in MVP.
4. Playback is exclusively through the YouTube IFrame Player API.
5. Never claim frame-accurate playback in UI copy — the player starts near a keyframe.

Rules 1–4 constrain the **YouTube adapter**, which is MVP's only media path. They are not a
statement that P80 is a YouTube product: the domain unit is a timed media source plus a
transcript — an `.mp4` or equivalent — and everything YouTube-specific stays behind
`MediaSourceAdapter`, so local files and other providers remain new adapters rather than a
refactor. See `docs/contracts/04-providers.md` §1, *Provider independence*.

### Human control (spec §7.3)
6. **No candidate ever becomes a learning item without an explicit user action.** There is
   no auto-approval path, not even a disabled one.
7. Batch actions require an explicit list of IDs. No "apply to everything matching this
   filter".

### Trust boundaries (spec §16.4, §32.6)
8. **Transcript text is untrusted input.** Escape it on render. Never interpolate it into
   a system prompt. Never let it build a URL, path, or command.
9. LLM calls use schema-constrained output with bounded retries. Invalid output is
   rejected, never hand-repaired.
10. The LLM has no tools, no browsing, and no code execution in MVP.
11. **The dictionary is the lexical authority; the LLM is an explainer and disambiguator.**
    A definition without dictionary evidence is labelled unverified.
12. Display uncertainty. Never present a low-confidence result as confident.

### Local-first (spec §7.2, §32)
13. Bind to `127.0.0.1`. Strict CORS. LAN exposure is opt-in behind a warning. This covers
    the NLP sidecar (ADR 0002) and the vLLM server (ADR 0005) as much as the API.
14. **All inference is local (ADR 0005). P80 holds no API keys.** Do not add a cloud
    provider, an SDK, or a key-reading code path. If a task seems to need one, the task is
    wrong — stop and ask. `.env.local` holds local endpoint config only, which is not a
    secret. Should this ever be revisited, the rule reverts to: keys from `.env.local`
    only, never the database, a response body, a log line, or an error message.
15. No remote analytics. Every external request is identifiable and disclosed — and the
    steady-state list is **empty**. P80 makes no outbound requests at runtime; the
    dictionary, frequency, and model artifacts are downloaded once during setup.
16. Recordings are not persisted unless the user explicitly saves them.

### Scope (spec §6)
17. The non-goals list in spec §6 is binding. Do not build multilingual support,
    pronunciation grading, conversation mode, web search, social features, cloud sync, or
    accounts. If a task drifts toward one, stop and flag it.
18. **MVP ships one target language: German → English** (ADR 0001). All language-specific
    behaviour goes in a `LanguageAdapter`, resolved from a registry keyed by
    `profile.target_language` (`docs/contracts/04-providers.md` §2). No
    `if (language === ...)` outside an adapter. The registry is the *only* concession to
    the eventual Portuguese/Spanish/French ambition — a profile switcher, a second adapter,
    or a second evaluation corpus is rule 17 territory.

---

## 3. Architectural invariants

- **Capture is complete; ranking decides visibility.** Extraction observes every eligible
  lexical unit. Nothing is ever dropped for being *low value* — only for not being a
  language item at all (wrong language, numeral, URL, transcription artifact). A false
  positive costs a keystroke; a false negative is invisible forever. See ADR 0008 and
  `docs/contracts/07-extraction.md`.
- **Three tiers: observed → candidate → item.** Observed units are cheap key:value rows,
  language-scoped, never enriched, reachable only by browse. Candidates are promoted and
  enriched. Items are user-approved. Each transition has exactly one trigger.
- **Enrichment is lazy.** Dictionary and LLM run on promotion, per candidate — never across
  the observed pool. This is a precondition of recall-first, not an optimization.
- **Admission ≠ scheduling.** Importance score decides whether an item enters the
  curriculum. FSRS decides when a card is next reviewed. Never wire one to the other.
- **Skills schedule independently.** Audio recognition, cloze, and production each carry
  their own FSRS state. Never average them.
- **`cards` is the single authority for scheduling state.** `SkillState` is projected on
  read, never stored twice.
- **Transfer is a presentation mode, not a card type** (`reviews.context_mode`).
- **Original data is immutable.** Transcript segments are never mutated; corrections are
  separate rows. Review history is append-only.
- **Every score stores its breakdown.** A total without components is unusable, because
  the user must be able to inspect ranking.
- **Every job is idempotent, retryable, inspectable, and versioned.** Provider failure
  preserves completed stages and never fabricates a fallback definition.
- **P80 works with no LLM configured.** This is tested, not assumed.
- **Clients hold no domain logic.** Scoring, session generation, sibling burying, and FSRS
  live in `packages/core`, reachable only through `/api/*`. A `curl` script must be able to
  complete a full review session. See ADR 0007.

---

## 4. Stack

All eleven ADRs in `docs/decisions/` are accepted. The stack below is settled, not
provisional — check there for *why* before changing any of it.

Two clients over one API, split by whether the surface needs media (ADR 0007):

```
apps/tui      management surfaces — candidate inbox, items, stats,
              diagnostics, jobs, settings. Keyboard-only, no media.
apps/web      media surfaces — review sessions, video loop, video detail.
              React + TypeScript + Vite, YouTube IFrame API, MediaRecorder.
apps/api      Node + TypeScript + Fastify + Zod
apps/worker   Node + TypeScript, SQLite-backed job polling
services/nlp  Python + FastAPI + spaCy de_core_news_lg (ADR 0002).
              Stateless, loopback only, one narrow HTTP interface
              matching LanguageAdapter.annotate.
packages/core             domain logic, scoring, pipeline stages
packages/database         schema + migrations
packages/language-adapters
packages/providers        dictionary, LLM, media adapters
packages/shared-ui        web only
```

Both clients talk to the same `/api/*` surface and nothing else. There is no UI-abstraction
layer — two concrete clients, not a client framework.

SQLite with explicit migrations. `ts-fsrs` for scheduling. No Redis. One root command
starts the API, worker, both clients, and the NLP sidecar.

**Two external processes, managed outside `pnpm dev`** because both are long-lived and
expensive to start:

- **vLLM** serving the local model on loopback, OpenAI-compatible (ADR 0005). Expect it to
  be *down* during Stages 1–6 — that is the §5.2 degraded path getting free exercise.
- **`uselimit`** (`~/Projects/uselimit`, workspace link until published) enforces the
  enrichment ceilings. Needs a transactional SQLite `StorageAdapter`, to be written
  upstream; the shipped `InMemoryAdapter` is single-process and will not do, since the API
  and worker both consume budget.

**Setup is not `pnpm install`.** It also downloads the spaCy model, two Wiktextract dumps,
and the OpenSubtitles corpus, then builds the dictionary index and the frequency counts.
Document every step — this is a real cost paid by every future contributor, agent sessions
included.

---

## 5. Working agreement

1. **Work one stage at a time.** The stage brief defines scope. Work outside it — even
   obviously useful work — needs a note in `STATUS.md` or a new stage.
2. **A stage is done when its exit criteria pass as tests**, not when it feels done.
   Convert each exit criterion into a test or an explicit manual-check line.
3. **Update `docs/STATUS.md` at the end of a work session.** Current stage, what landed,
   what is blocked, next actions.
4. **Write an ADR for any decision** that changes an interface, a table, a formula, or a
   dependency. Cheap file, saves re-litigation.
5. **Fixtures before extraction logic.** Stages 4–8 are tuned against the labelled
   evaluation transcript. Do not tune extraction on anecdotes (spec §34.5).
6. If the spec is ambiguous, do not guess silently. Resolve it in the contract with a
   `RESOLVED` marker explaining the reading you chose, or ask.

## 6. Commands

Populated during Stage 1.

```
# pnpm dev        start web + api + worker
# pnpm test       unit + integration
# pnpm db:migrate run migrations
# pnpm db:backup  snapshot the SQLite file
```
