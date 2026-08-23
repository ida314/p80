# P80 — Working Instructions

P80 is a **local-first language-learning application**. It turns user-selected YouTube
videos plus user-supplied transcripts into a small, high-value curriculum of words,
multiword expressions, and constructions, then trains recognition, production, and
contextual transfer while reconnecting each item to its original source clip.

Read this file first. Then read `docs/internal/STATUS.md` to find out where the project is.

---

## 1. Document map — read the right thing

| Need | Read |
|---|---|
| Where the project is right now | `docs/internal/STATUS.md` |
| What to build in the current stage | `docs/internal/plan/stage-NN-*.md` |
| Data shapes, schema, endpoints, interfaces, formulas | `docs/contracts/` — **authoritative** |
| Why a decision was made | `docs/decisions/` |
| The stages and their ordering | `docs/roadmap.md` |
| Original product intent and rationale | `docs/original_spec.md` — **frozen, never edit** |

Everything here except `docs/internal/**` is written for a stranger — see **hard rule 19**.
Decide a document's audience before its filename.

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

### Media (ADR 0015 — replaces spec §8, §38.8; amended by ADR 0024)
1. **P80 never acquires media.** No downloader, no stream extraction, no URL that resolves
   to media bytes — **P80 makes no outbound request to obtain a file.** It accepts one the
   user hands it: a path already under `P80_MEDIA_ROOT`, or bytes the user's own browser
   pushes into `<P80_MEDIA_ROOT>/uploads/` (ADR 0024). Both are pushes; neither leaves the
   machine. Where the user got the file is outside the system. If a task seems to require
   *obtaining* media, the task is wrong — stop and ask.
2. **P80 makes no outbound request to obtain a transcript.** ASR is local (ADR 0016);
   upload is user-supplied. Neither path leaves the machine.
3. **P80 never copies media into its own storage.** It holds a reference — a path plus a
   content hash — and reads through it. An upload produces the *only* server-side copy;
   what stays forbidden is a **second** copy of a file P80 already holds — a cache, a
   transcode, a decoded audio track. `P80_STORAGE_PATH` holds transcripts and derived
   artifacts, **never media, including a partially received upload**.
   **`<P80_MEDIA_ROOT>/uploads/` is the only directory P80 writes media into, and the only
   one it deletes from.** `test/media-policy.test.ts` asserts that exactly one production
   module writes there; a second one fails the build.
4. **A media path is untrusted input.** It resolves under `P80_MEDIA_ROOT` or it is
   rejected. Never sanitised into something acceptable. **So is a filename, and it never
   becomes a path**: the partial file is named from a ULID, and a proposed final name is
   *validated* by `resolveMediaPath` rather than trusted (ADR 0024 §4).

The domain unit is a timed media source plus a transcript — an `.mp4` or equivalent — and
everything file-specific stays behind `MediaSourceAdapter`. That interface earned its keep
once already: ADR 0015 removed the YouTube adapter by deleting it rather than by refactoring
around it. See `docs/contracts/04-providers.md` §1, *Provider independence*.

**Two former rules are deleted, deliberately.** *Never isolate or store an audio track* had
no subject left once the user supplies the file — decoding its audio is the whole of what
ASR does, and rule 3 is what now protects the storage directory. *Never claim frame-accurate
playback* went with the keyframe-bounded player; seeking a local file is exact. ADR 0015
records what each deletion costs. Do not reintroduce either as a hedge.

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
15. No remote analytics. **P80 makes no outbound request at runtime — the list is empty.**
    Not the API, not the worker, not the NLP sidecar, and since ADR 0015 removed the
    embedded player, not the browser client either. The dictionary, frequency, ASR, and
    spaCy artifacts are downloaded once during setup. Adding a runtime request is a
    decision, not an implementation detail, and it would be the first one.
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

### Documentation audience
19. **Every document except `docs/internal/**` is written for a stranger.** Assume anyone —
    a user, another developer, a reviewer — reads `README.md`, `CLAUDE.md`,
    `docs/contracts/`, `docs/decisions/`, `docs/roadmap.md`, and `docs/SETUP.md`. Keep them
    free of anything personal to whoever is building this: no names of real people, no
    home-directory or machine-local paths, no specific personal hardware, no email
    addresses, no first-person working narrative.

    - Name sibling repositories **without paths**. If one is private, say so and make the
      document stand on its own without it.
    - Real names used as linguistic or data examples count. Substitute a neutral one.
    - Where a personal detail is load-bearing, **abstract it into the property that
      mattered** rather than deleting it. *"A 128 GB unified-memory workstation,
      bandwidth-constrained rather than capacity-constrained"* explains a decision; a brand
      name does not. A redaction leaves a hole where an explanation should be.

    `docs/internal/` holds the working notes — status and stage briefs — and is where local
    paths and concrete personal context belong. Being concrete there is the point; do not
    sanitise it.

    **Do not document this rule outside this file.** It is guidance for you, not a policy
    to announce. Reader-facing docs should simply *be* clean, with no page explaining that
    a distinction exists or that anything is curated. `docs/README.md` frames the same
    constraints as ordinary portability hygiene, which is how they should read; do not add
    "public vs internal" framing to it, to the internal files, or to commit messages.

    Two directions of drift to watch:

    - **Progress leaking into a public doc.** ADRs record a decision and its reasoning, not
      status. Status goes to `docs/internal/STATUS.md`.
    - **Rationale stuck in an internal doc.** If you are writing *why* rather than *where*,
      it belongs in an ADR — public, and written to stand alone.

    `test/docs-hygiene.test.ts` under `pnpm test` catches the mechanically detectable cases
    across the reference documentation set. It is a backstop, not the rule; it cannot see
    first-person narrative or a judgement call about hardware.

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

All twenty-four ADRs in `docs/decisions/` are accepted. The stack below is settled, not
provisional — check there for *why* before changing any of it.

Two clients over one API, split by whether the surface needs media (ADR 0007):

```
apps/tui      management surfaces — candidate inbox, items, stats,
              diagnostics, jobs, settings. Keyboard-only, no media.
apps/web      media surfaces — review sessions, video loop, video detail —
              plus settings, which ADR 0019 puts in both clients because the
              media root decides whether the rest of this list works.
              React + TypeScript + Vite, HTML5 <video>, MediaRecorder.
apps/api      Node + TypeScript + Fastify + Zod. Serves media by byte range
              from P80_MEDIA_ROOT; copies nothing (ADR 0015).
apps/worker   Node + TypeScript, SQLite-backed job polling
services/nlp  Python + FastAPI. spaCy de_core_news_lg (ADR 0002) and
              faster-whisper + forced alignment (ADR 0016). Loopback only.
              Stateless per request, but ASR holds it for minutes — see
              04-providers.md §2 for the condition that splits it out.
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
- **`uselimit`** enforces the enrichment ceilings. Not yet on npm, so it is consumed as a
  workspace link against a local sibling checkout until it is published. Needs a
  transactional SQLite `StorageAdapter`, to be written upstream; the shipped
  `InMemoryAdapter` is single-process and will not do, since the API and worker both
  consume budget.

**Setup is not `pnpm install`.** It also needs `ffmpeg` on the path, and it downloads the
spaCy model, the ASR and forced-alignment models (ADR 0016), two Wiktextract dumps, and the
OpenSubtitles corpus, then builds the dictionary index and the frequency counts. Document
every step — this is a real cost paid by every future contributor, agent sessions included.

`P80_MEDIA_ROOT` must point at a directory of media files before anything can be ingested.
It is the only place P80 will read media from, and it has no default: a wrong guess would be
a silent one.

**It and the six `P80_ASR_*` options are editable while P80 runs** (ADR 0019). The
`settings` table overrides the environment, both clients carry the surface, and every
consumer reads a live key at the point of use — never from the `Config` snapshot. Reach for
`getRuntimeSettings(handle, config)`; `config.P80_MEDIA_ROOT` compiles and is wrong. Nothing
else is writable, and `P80_ALLOW_LAN` is deliberately not, because rule 13's opt-in should
not be something a page can do.

---

## 5. Working agreement

1. **Work one stage at a time.** The stage brief defines scope. Work outside it — even
   obviously useful work — needs a note in `docs/internal/STATUS.md` or a new stage.
2. **A stage is done when its exit criteria pass as tests**, not when it feels done.
   Convert each exit criterion into a test or an explicit manual-check line.
3. **Update `docs/internal/STATUS.md` at the end of a work session.** Current stage, what landed,
   what is blocked, next actions. *Where*, not *why* — see rule 19.
4. **Write an ADR for any decision** that changes an interface, a table, a formula, or a
   dependency. Cheap file, saves re-litigation. Written for a stranger (rule 19), so the
   reasoning stands alone.
5. **Fixtures before extraction logic.** Stages 4–8 are tuned against the labelled
   evaluation transcript. Do not tune extraction on anecdotes (spec §34.5).
6. If the spec is ambiguous, do not guess silently. Resolve it in the contract with a
   `RESOLVED` marker explaining the reading you chose, or ask.

## 6. Commands

Full setup, including the parts that are not `pnpm install`, is in `docs/SETUP.md`.

```
pnpm dev          start api + worker + web + nlp sidecar (four processes)
pnpm test         vitest, unit + integration
pnpm typecheck    tsc --noEmit across all nine TypeScript packages
pnpm db:migrate   apply pending migrations
pnpm db:backup    snapshot the SQLite file (VACUUM INTO, not a copy)
pnpm dev:noop     enqueue a NOOP job so the worker has something to claim

bash scripts/smoke.sh                                    end-to-end, against a running P80
bash scripts/service-install.sh                          build the images, install the unit
bash scripts/deploy.sh                                   update the installed P80 (ADR 0022)
pnpm --filter @p80/tui dev health|jobs|profile           the management client
uv run --project services/nlp pytest services/nlp/tests  sidecar tests
```

`pnpm dev` does **not** start vLLM or `uselimit` — both are long-lived, expensive to
start, and managed outside the dev command (§4). vLLM being down through Stages 1–6 is
expected, not a misconfiguration. It starts the NLP sidecar only when `P80_NLP_BASE_URL`
is loopback; pointed elsewhere it starts three processes and says so.

**Installed, P80 is one systemd unit running four containers, not four processes**
(ADR 0025, superseding ADR 0021). There is no web container: the API serves the built
client on its own port, so the deployed URL is `P80_API_PORT` while `pnpm dev` stays on
`P80_WEB_PORT`, and the two cannot run at once. `systemctl --user status p80.service`,
`journalctl --user -u p80 -f`. If P80 appears to be running when you did not start it, that
is why.

The containers share the host's network namespace, so rule 13 stays a property of each
process rather than of a publish flag, and every loopback URL keeps one meaning. Compose
resolves the media-root mount from `.env.local`, which is not its default env file — so
driving it by hand needs `COMPOSE_ENV_FILES=.env.local`. **`pnpm dev` is unchanged and
still native**; containers are the deployment target only.
