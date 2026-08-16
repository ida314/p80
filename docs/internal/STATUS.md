# P80 — Status

> Working notes. Single source of truth for *where the project is*. Read at the start of
> every session, update at the end of every session. Keep it short — this is a dashboard,
> not a journal.
>
> **Rationale does not belong here.** If you find yourself explaining *why* rather than
> *where*, write an ADR.

**Current stage:** Stage 3 — Manual learning-item prototype (code-complete, four manual checks)
**Also open:** Stage 2 and 2b, code-complete, six manual browser checks outstanding
**Milestone:** M1 — First vertical slice
**Running at:** <http://127.0.0.1:5180> as systemd user services (ADR 0021)
**Last updated:** 2026-08-15

---

## Now

**Stage 3 is code-complete. The vertical slice closes M1's code half.** Highlight
transcript text, describe it, get three FSRS-scheduled cards, review them against the
source clip, and inspect the history. Brief at `plan/stage-03-manual-items.md`; ADR 0020
carries the three decisions the contracts did not answer.

**547 TypeScript tests, 24 Python tests, nine packages typechecking clean,
`scripts/smoke.sh` 75/75 against a live `pnpm dev` (twice, idempotently), and
`pnpm --filter @p80/web build` clean.** No migration: every table Stage 3 touches has been
in migration 0001 since the contracts were extracted.

**The whole learning loop works over `curl`** — `POST /api/items` from a segment id and
character offsets, start a session, fetch a card, answer, rate, watch the due date move,
read the history back. That is ADR 0007's standing test passing on the surface it was
written for.

| What | State |
|---|---|
| ADR 0020 written and accepted; contracts 01 and 03 amended | **done** |
| `ts-fsrs` wrapper, snapshot round trip, `SkillState` projection | **done** |
| Card generation rules, cloze rendering, clip windows | **done** |
| Session builder: tiers, sibling burying, budget, new-item allowance, §8 burden | **done** |
| `POST /api/items` + the eight §5 routes; the eight §6 review routes | **done** |
| Web: transcript selection, creation form, card preview, review session, Today dashboard | **done** |
| TUI: `p80 items`, `p80 due` | **done** |
| `smoke.sh` extended to 75 checks | **done** |
| Manual checks M1–M4 | **not run** |

**Stage 2's five manual checks and Stage 2b's one are still outstanding**, and Stage 3 adds
four of its own. All ten need the same thing: a browser and one German video file.

| What | State |
|---|---|
| ADRs 0015–0018 written and accepted | **done** |
| Contracts 01–05 amended; `CLAUDE.md` media rules rewritten | **done** |
| Migration 0002 + Drizzle mirror | **done** |
| `local_media` adapter; YouTube adapter and IFrame player deleted | **done** |
| `POST /transcribe` on the NLP sidecar, with its three refusals | **done** |
| `INGEST_MEDIA` and `TRANSCRIBE` handlers | **done** |
| `GET .../media` (Range), `POST .../media/repair`, `GET .../transcript/words` | **done** |
| Web `<video>` player, add-by-path form, missing-media repair affordance | **done** |
| Media-policy tests rewritten; smoke script extended to 40 checks | **done** |
| Manual checks M1–M5 | **not run** |

**What is left is M1–M5** — they need a real video file and a person at a browser. One
thing the rewrite made cheaper: none of them needs a network any more.

### What the rewrite cost, and what it did not

Worth recording because it is the evidence for `MediaSourceAdapter` having been worth
building. **Deleted outright:** the YouTube adapter, its URL parser, the IFrame player
wrapper, `EmbedDescriptor`, `youtubeWatchUrl`, and two hard media rules. **Untouched:** the
transcript parsers, the warning vocabulary, corrections, the job loop, the storage-path
rules, and every client component except the player. Removing YouTube was a deletion rather
than a refactor because nothing above the adapter had learned anything about it.

Three things got *better* rather than merely different, and all three were previously
recorded as limitations:

- **Seeks are exact.** `KEYFRAME_TOLERANCE_MS` (2000) became `SEEK_TOLERANCE_MS` (50), and
  the UI copy warning users about it is gone rather than reworded.
- **Word-level timing exists**, which closes ADR 0013's first open question by removing the
  constraint that raised it. The Stage 4 pause sweep is now per-tier.
- **The external-request list is empty**, not short. `CLAUDE.md` rule 15 went back to the
  unqualified form Stage 2 had to weaken it out of.

### Stage 2 — local media ingestion (ADRs 0015–0018)

Rewritten around a new media source part way through and code-complete again. Brief at
`plan/stage-02-ingestion.md`, which carries the before/after table.

### Stage 2b — runtime settings (ADR 0019)

**Code-complete; one manual check (M6) outstanding.** Brief at `plan/stage-02b-settings.md`.
`P80_MEDIA_ROOT` and the six `P80_ASR_*` options are editable from both clients and take
effect without a restart; everything else is displayed read-only.

| What | State |
|---|---|
| ADR 0019 written and accepted; ADR 0007 amended | **done** |
| `settings` registry, tiers, `resolveRuntimeSettings` | **done** |
| `validateMediaRoot` + refusal list | **done** |
| `GET/PUT /api/settings`, `POST .../media-root/preflight` | **done** |
| Every media-root consumer reads per use | **done** |
| ASR options in the sidecar request body | **done** |
| `p80 settings` / `p80 settings set` | **done** |
| Web `/settings` page | **done** |
| Manual check M6 | **not run** |

No migration was needed: `settings` has been in migration 0001 since the contracts were
extracted, unused, and this is what it was for.

**`.env.local` was read by nothing, and the API and worker could not start.** Found while
verifying Stage 2b against a live `pnpm dev`. `dev.mjs` checked the file existed and printed
a note; no process ever loaded it. Vite loads it for the web client on its own, so the
browser and the sidecar came up and the two TypeScript services died on
`P80_MEDIA_ROOT: Required` — which reads as a broken API rather than as an unloaded config
file. `loadConfig()` now reads the file when called with no argument, with the process
environment taking precedence; passing an explicit env skips it, so the suite cannot inherit
a developer's dotfile. Three regression tests in `packages/core/test/config.test.ts`.

This is why `smoke.sh` had not been run since the ADR 0015–0018 rewrite made
`P80_MEDIA_ROOT` required: it needs a live API, and there had not been one.

### Deployment (ADR 0021)

**P80 runs as systemd user services on the development machine.** Outside a stage; noted
here per §5.1. Installed with `bash scripts/service-install.sh`.

| What | State |
|---|---|
| ADR 0021 written and accepted | **done** |
| `deploy/systemd/*.in` — target, migrate, api, worker, nlp, backup service + timer | **done** |
| `scripts/service-install.sh` with preflight, remote-sidecar skip, `--uninstall` | **done** |
| API serves `apps/web/dist`; `allowedOrigins` widened to the API port | **done** |
| `pruneBackups` retention, wired into `db:backup` | **done** |
| `smoke.sh`: client check works from either origin; media root read from the API | **done** |
| Verified: restart, graceful stop, loud config failure, backup restore | **done** |
| Verified: survives a reboot | **not run** |

### CI and deployment updates (ADR 0022)

**Every push is checked by GitHub Actions; updating the installed P80 is
`bash scripts/deploy.sh`.** Outside a stage; noted here per §5.1.

| What | State |
|---|---|
| ADR 0022 written and accepted | **done** |
| `.github/workflows/ci.yml` — `typescript` and `python` jobs | **done** |
| `scripts/deploy.sh` — preflight, gates, snapshot, restart, verify, rollback | **done** |
| `pnpm db:backup --reason <slug>`, validated; `backup` CLI logs to fd 2 | **done** |
| `docs/SETUP.md` update section; `CLAUDE.md` §6 command | **done** |
| Verified: clean-clone CI steps, dry run, happy path, rollback path, lock | **done** |
| Verified: a real GitHub Actions run is green | **done** — both jobs, every step |

First run: the TypeScript job 69s, the sidecar job 10s. The deploy script was exercised
against the live services both ways — a clean deploy to smoke 75/75, and a deliberately
broken build that rolled back to the previous commit and came up healthy.

CI synthesizes `.env.local` from `.env.example`, which is the one thing the suite needs and
does not carry: `packages/core/test/config.test.ts` asserts `loadConfig()` reads the file,
and `P80_MEDIA_ROOT` has no default. Exporting the variable instead would pass for the wrong
reason — the process environment wins, so the file would never be read.

**A seventh silent bug, and the second found by giving something a consumer rather than by a
test.** `db:backup` wrote its path to stdout as a data channel while pino logged to the same
descriptor — identical to the `dev:noop` defect that made `smoke.sh` flaky, and latent here
only because nothing had ever parsed backup's output. `deploy.sh` parses it. Now
`createCliLogger`, fd 2.

562 TypeScript tests, 24 Python tests, nine packages typechecking, `smoke.sh` 75/75 against
the installed services. Check count unchanged at 75 — the client check moved rather than
multiplied.

**The deployed URL is <http://127.0.0.1:5180>, not 5173.** There is no web unit; the API
serves the built client. Nothing listens on 5173 unless `pnpm dev` is running, and the two
cannot run at once.

Three findings from the machine, none of which the code caused:

- **Transcription runs on CPU here.** The available CTranslate2 build carries no CUDA
  libraries, so `P80_ASR_REQUIRE_GPU=true` made every job a refusal. `.env.local` sets
  `cpu`/`int8`/`require_gpu=false`/`align=false`; all live-tier, so the Settings page can
  flip them back with no redeploy.
- **`P80_VLLM_MODEL_ID` now names the model the local server actually serves**, so
  `/api/health` reports `inference.configured` truthfully. Nothing consumes it until Stage 6.
- **`smoke.sh` was writing fixtures into the media root and leaving them.** Harmless when
  the root was `data/media`; litter in a real library. It cleans up after itself now.

Two sidecar bugs fell out of having the ASR extra actually installed, both fixed:

- **A `device=cuda` request on a build without CUDA returned 500 `ASR_FAILED`.**
  `assert_device` asks whether a GPU is present, which is a different question from whether
  this build can reach one, so the failure landed on `WhisperModel(...)` and escaped as
  "transcription failed" — a setup problem reported as a broken file. Now a 501
  `ASR_UNAVAILABLE` naming the model, device, and compute type.
- **`test_options_reach_the_settings_the_endpoint_uses` assumed no model was installed**
  and failed for anyone who followed `docs/SETUP.md`. It now asserts the claim it meant —
  this build cannot transcribe with these settings — and is indifferent to the extra.

**Still owed, and deliberately not written here:** the ADR that commit `da31427` says is
required before `P80_NLP_BASE_URL` or `P80_VLLM_BASE_URL` may point off this machine —
`CLAUDE.md` rules 13 and 15 say the runtime external-request list is empty, and changing
that is a decision. ADR 0021 does not touch it; the installer only declines to start a
local sidecar when the URL already points elsewhere.

## Blocked on

Nothing blocks the remaining Stage 2 phases.

**Outstanding Stage 0 work**, unchanged, none of which gated the skeleton:

- [ ] **ADR 0006 Pass A** — video 1, exhaustive word labels (~500 lemmas) plus
      `worth_learning` and reasons. ~1 day. *Still the only unmet Stage 0 exit criterion.*
      It gates Stage 4 tuning, and it is now the nearest thing to a critical path item.
- [ ] Stage 0 step 7 — source-use and privacy notices (`docs/policy/`)
- [ ] Stage 0 step 9 — initial German function-word list, in the adapter

## Done

- [x] Repo initialized, spec frozen, contracts extracted, `CLAUDE.md` written
- [x] **ADRs 0001–0011 accepted** — see `docs/decisions/README.md`
- [x] **ADR 0021 accepted (2026-08-09)** — systemd user units over containers; the API
      serves the built browser client, which amends ADR 0007 on where the client is served
      from; migrations and backups get their own units.
- [x] **ADR 0019 accepted (2026-08-09)** — runtime-editable settings. The `settings` table
      overrides the environment; live vs boot tiers; the settings surface goes in both
      clients, which amends ADR 0007.
- [x] **ADRs 0015–0018 accepted (2026-08-09)** — local media replaces embedded YouTube;
      local ASR primary with upload fallback; word-level timing as the source of truth;
      content-hash file identity. The largest revision so far.
- [x] **Stage 1 complete (2026-08-07)** — `plan/stage-01-skeleton.md`.
      Monorepo, four processes, full schema, migrations, structured logging, strict CORS,
      loopback binding, error envelope, backup, one-command start.
- [x] **ADR 0013 accepted (2026-08-08)** — reuse inventory for
      `~/Projects/bilingual-audio-generator`. It solves a different problem, but its stage 3
      is P80's Stage 4: sentence reconstruction from timed tokens. Taken, adapted, and
      explicitly rejected parts are all listed there.
- [x] **ADR 0012 accepted** — Drizzle over `better-sqlite3`. The migrations stay
      hand-authored SQL, because `02-database.md` §3 rule 1 forbids applying a generated
      diff without review. A parity test keeps the Drizzle mirror honest.

## Next actions

0. **Run all ten manual checks in one browser session** — Stage 2's M1–M5
   (`plan/stage-02-ingestion.md`), Stage 2b's M6 (`plan/stage-02b-settings.md`), and
   Stage 3's M1–M4 (`plan/stage-03-manual-items.md`). They need one German video file under
   `P80_MEDIA_ROOT`, one folder holding no video, and — for the transcription half — the
   ASR extra installed. Ten checks is the accumulated cost of three code-complete stages
   nobody has sat in front of; doing them together is much cheaper than three sittings.
2. **Label ADR 0006 Pass A.** It blocked nothing in Stage 1 and blocks nothing in Stage 2,
   which is exactly why it keeps not happening — and Stage 4 cannot be tuned without it.
3. Verify ADR 0001's readiness checklist as Stage 4 approaches. The resources are *named*,
   none is *verified*, and the boxes stay unticked until a fixture exercises each.
4. **Measure the ASR model choice** (ADR 0016's open question). Transcribe both ADR 0006
   corpus videos with `large-v3` and `medium`, compare WER against a hand-corrected
   transcript, and record wall-clock for each. `medium` wins unless `large-v3` reduces WER
   by enough to change a Stage 4 sentence boundary.
5. ~~Add the two CHECK constraints when a migration is next needed.~~ **Migration 0002 was
   that migration and they still did not land** — the reason turned out to be a hazard, not
   an oversight. See Notes.

## Milestones

| # | Stages | Outcome | State |
|---|---|---|---|
| M0 | 0 | Scope locked, providers chosen, evaluation set exists | **decisions done; Pass A outstanding** |
| M1 | 1–3 | First complete vertical slice: add video → manual item → review it | **all three code-complete; ten manual checks outstanding** |
| M2 | 4–6 | Deterministic extraction + dictionary-grounded meanings | not started |
| M3 | 7–8 | LLM disambiguation, expressions, constructions | not started |
| M4 | 9–10 | Learner model, adaptive admission, video difficulty | not started |
| M5 | 11–12 | Video loop, struggle diagnosis, recommendations | not started |
| M6 | 13 | Metrics, export, pilot readiness | not started |

## Open questions

Two remain inside ADR 0011, both deliberately left to measurement. Neither blocks anything
before Stage 8.

- **Is the embedding non-compositionality path MVP or deferred?** Resolved as a *decision
  rule*: build the dictionary path in Stage 6, measure its recall against the Pass B
  idiomaticity labels at Stage 8, record the number.
- **Layer 2 write threshold** — default is persist on second sighting; validated at Stage 8.

Added by Stage 1:

- **Which TUI framework?** Deferred to Stage 5 on purpose. ADR 0007 requires the client
  but names no stack, and the surface that decides it — the candidate inbox, a long
  keyboard-driven filterable list — does not exist yet. Stage 1 ships a framework-free
  CLI (`p80 health|jobs|profile`), which is enough to prove the second client exists and
  holds no domain logic. Write the ADR in Stage 5, with the real screen in front of you —
  it takes whatever number is next by then, since Stage 2 used 0014.

Added by ADR 0013, both resolving at Stage 4 by measurement:

- **Does the pause signal survive cue-level timing?** BAG's `pause_weight` was fitted to
  word-level forced alignment; P80 only has gaps at cue boundaries. Sweep
  `{0, 0.15, 0.35}` against the corpus and record the number.
- **Does ADR 0006 Pass A need sentence-boundary labels?** Roughly an hour of extra
  labelling, but retrofitting means re-reading both transcripts. **Decide before Pass A
  starts.**

`07-extraction.md` §14 carries three further tunables with recorded defaults. One, the
recurrence promotion threshold (3 distinct videos), is **not measurable against a
two-video corpus** and has to wait for a real library.

## Notes

- **A sixth silent bug, and the first a live run found before a test did.** Deleting a
  video left its learning items `active` with no occurrence — the foreign keys cascade
  `item_occurrences` away and nothing set `archived`, so §7 invariant 5 was violated through
  the ordinary Delete button. The comment in `deleteVideo` asserted the schema enforced it;
  the schema does not. Nothing could have caught it before Stage 3, because there were no
  items, and the first smoke run that created one and then deleted its video hit it in the
  same pass. `DELETE /api/videos/:id` now archives and reports `archivedItems`. Same family
  as the five below, with the same shape: everything reported healthy while being wrong.
- **The greedy session builder needed one non-obvious tiebreak.** Nine cards across three
  items interleave perfectly, and a first-fit pass could not find the arrangement — it ran
  the last item's cards together and dropped one. Preferring the item with the most cards
  left to place fixes it. Recorded because the symptom (a plan one card short) looks like a
  budget or an allowance, and is neither.
- **A single-item session shows one card, by design.** §6 rule 2 introduces siblings on
  different days, and with one item there is nothing to put between them. The plan reports
  `deferredSiblings` because "1 card" on its own reads as a bug — which it did, twice, in
  tests written before the reasoning was.
- **A fifth silent bug, and the first that stopped the product from starting at all.**
  Nothing loaded `.env.local`. It is documented in `SETUP.md`, checked for by `pnpm dev`,
  and was read by no process — Vite loads it for the web client itself, which is why three
  of the four services appeared to work. Same family as the four below, with one difference
  worth recording: the previous four reported healthy while being wrong, and this one
  reported *unhealthy* while the config was fine. It stayed hidden because the symptom
  pointed at the API and the cause was in a file nobody was reading.
- **The two deferred CHECK constraints are now permanently deferred, and the reason is a
  trap.** SQLite cannot add a CHECK to an existing table; it needs the 12-step rebuild. But
  `DROP TABLE videos` under `PRAGMA foreign_keys = ON` — which `client.ts` sets — performs
  an implicit DELETE that **fires `ON DELETE CASCADE` on every child table**, destroying
  every transcript, segment, correction, sentence, token, and occurrence. `PRAGMA
  defer_foreign_keys` does not help: it defers constraint *violations*, not cascade
  *actions*, and `PRAGMA foreign_keys` is a no-op inside a transaction, which is where every
  migration runs. Landing them safely needs a migration runner that can take a file outside
  its transaction. Migration 0002 and `02-database.md` both carry the warning, because the
  tempting next move is to "just add the CHECK".
- **The empty-transcript guard was found by writing its test, not by review.** The
  `TRANSCRIBE` handler would have stored an ASR result with zero words as a `ready`
  transcript. The sidecar already refuses that case, so it needed a provider to disagree
  with its own contract — which is exactly the class of bug a stub test finds and a live run
  does not. An empty transcript stored as ready is indistinguishable from a silent video,
  and the difference decides whether the user goes looking for a subtitle file or for a bug.
- **`GET .../transcript/words` was documented in three places before it existed.** The
  contract, the error code, and the web API client all named it; the route did not. The
  live smoke run caught it — a 404 where a 409 was asserted. Worth noting as the failure
  mode of writing contracts first: the paper trail is not evidence the code exists.
- **A fourth silent bug, found by Stage 2 phase 4 and the same family as Stage 1's three.**
  `newId()` returned a plain ULID, whose entropy is re-randomised every call, so two ids
  minted in the same millisecond sort arbitrarily. `transcript_corrections` resolves *which
  correction wins* by `(created_at, id)`, and nudging a timestamp with the keyboard produces
  two corrections inside one millisecond routinely — so the older edit won about half the
  time. It surfaced only under full-suite load; the test passed in isolation. `newId()` now
  uses `monotonicFactory()`, and the SQL breaks the tie on `rowid`, which is insertion order
  and needs no cooperation across processes. The regression test forces the tie.
- **`CLAUDE.md` rule 15 was weakened during Stage 2 and has now been restored.** It
  originally claimed the steady-state external-request list is *empty*, which the embedded
  player contradicted the moment it loaded, so it was scoped to "P80's own processes make no
  outbound requests, and the browser loads the player". ADR 0015 removed the player, so the
  original unqualified wording is true again and is back. Both edits are in `README.md` too.
  Neither needed an ADR on its own — the first corrected a false statement, the second is a
  consequence of 0015.
- **ADR 0014 took the number that had been informally reserved for the TUI framework.** ADRs
  are numbered by creation, so the TUI decision takes whatever is next when Stage 5 makes it.
- **`~/Projects/bilingual-audio-generator` supplies part of Stage 4 — see ADR 0013 — and
  the two projects converged further with ADR 0015.** BAG was previously mostly off limits
  because it opens with a `yt-dlp` download. That is still forbidden here (rule 1: P80 never
  *acquires* media), but everything downstream of its fetch stage — ASR, forced alignment,
  the word array as the source of truth — is now P80's design too, arrived at independently
  and then recognised. ADR 0013 §4's claim that the confidence checks "do not transfer" was
  reversed by ADR 0016 for the same reason. But its stage 3 solves P80's Stage 4 step 1: turning timed
  tokens into sentences, because neither a Whisper segment nor a subtitle cue is a sentence.
  The three-signal noisy-OR fusion, the constraint layer, and the boundary-provenance record
  come across, with four named adaptations — the largest being that P80 has timing at cue
  boundaries only, not per word. One list reaches **Stage 2**: the subtitle-boilerplate
  regexes (`amara.org`, `please subscribe`, bare `[Music]`), which belong in the transcript
  parser as `ParseWarning`s rather than as a silent drop. Two of its patterns are
  **rejected on rule grounds** and are called out in the ADR so they are not copied along
  with the code around them: regex repair of malformed JSON (rule 9) and a bearer token
  (rule 14).
- **A third silent bug, found 2026-08-08 by re-running the Stage 1 checks.** `dev:noop`
  logged through `createLogger`, which writes to **stdout** and buffers until process exit,
  so the pino line raced the `process.stdout.write` of the job id. About two runs in five,
  `scripts/smoke.sh`'s `tail -1` captured the JSON log line, looked up a job id of
  `{"level":30,...`, and got a 404 — reported as *"job reached succeeded: got none"*, which
  points at the worker, not at the parsing. Fix: `createCliLogger` sends logs to fd 2, so
  stdout stays a pure data channel. `packages/database/test/enqueue-noop-cli.test.ts` pins
  the contract and runs the CLI ten times, because one green run proved nothing here.
  Same family as the two below: everything reported healthy while being wrong.
- **Two silent bugs found while building Stage 1**, both now with regression tests and both
  recorded in ADR 0012. The first is the instructive one: a relative `P80_DB_PATH` gave
  the API and worker **separate databases**, because `pnpm --filter` runs each in its own
  directory. Nothing errored — every service started, migrated, and reported healthy. It
  would have surfaced in Stage 2 as "my transcript never gets processed". The second, a
  race between the two processes migrating on boot, was *masked* by the first.
- **`pnpm dev` starts four processes, not three.** ADR 0002's Python sidecar is one of
  them. It ships as a stub: `/health` is real, `/annotate` returns 501. spaCy and
  `de_core_news_lg` arrive in Stage 4 — and the stub *refuses* rather than returning an
  empty token list, because silent degradation into whitespace tokenization is the named
  failure mode there.
- **Python 3.14 is ahead of spaCy's wheels.** `services/nlp` pins `>=3.11,<3.14` and
  `.python-version` pins 3.13, so Stage 4's model install fails at `uv sync` with a clear
  message rather than midway through a 500 MB download.
- **Web ships media surfaces only** — Today, Videos, Video detail, Review. Spec §35's
  "Initial pages" list also names Candidates, Items, Settings, and Diagnostics, but it
  predates ADR 0007, which assigns those to the TUI. Recorded as a divergence in the
  Stage 1 brief.
- **The empty external-request list is now structural.** Nothing in the codebase
  constructs a provider, and no startup path checks for one. vLLM will be down for all of
  Stages 1–6, which `04-providers.md` §4 treats as free exercise of the §5.2 degraded
  path — a claim that only holds because nothing was built here that assumes reachability.
- Contracts introduced 11 tables absent from spec §28. All 36 are in migration 0001, and
  `schema-parity.test.ts` compares the Drizzle definitions against SQLite's introspection
  so the mirror cannot drift silently.
- The contracts diverge from the frozen spec in three named places, all ADR-backed:
  §14.10's reject-on-value gates (ADR 0008), §27.1's enrich-before-score job order
  (ADR 0008), and §26.1's all-TypeScript monorepo (ADR 0002). All marked `RESOLVED` inline.
- **New dependency: `uselimit`** (`~/Projects/uselimit`). Not integrated until Stage 6. It
  still needs a transactional SQLite `StorageAdapter` written upstream, because the
  shipped `InMemoryAdapter` is single-process and both the API and worker consume budget.
- **Named risk: German lemmatization.** spaCy's German lemmatizer is rule/lookup-based and
  weakest on verb inflection and separable verbs — which is what §14.8 consolidation,
  §22.1 coverage, and MWE lemma identity all key on. Verify at Stage 4; the fallback is
  Stanza inside the same sidecar, a version bump rather than an architecture change.
- **Two dictionary editions introduce one failure mode worth watching:** a German-edition
  sense grounds an item, but its English rendering is an LLM bridge translation and must be
  labelled unverified. Never let that translation be presented as the dictionary's own
  definition.
