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
**Running at:** <http://127.0.0.1:5180> as four containers under one systemd user unit
(ADR 0025), and at <https://p80.tail2e282c.ts.net> over Tailscale (ADR 0023)
**Last updated:** 2026-08-23

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

### Deployment (ADR 0025, superseding ADR 0021)

**P80 runs as four containers under one systemd user unit on the development machine.**
Outside a stage; noted here per §5.1. Installed with `bash scripts/service-install.sh`.

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

### Reaching P80 from the laptop (ADR 0023)

**Done.** Outside a stage; noted here per §5.1. `tailscale serve` in front of `:5180`,
`P80_TRUSTED_ORIGINS=https://p80.tail2e282c.ts.net` in `.env.local`.

| What | State |
|---|---|
| ADR 0023 written and accepted | **done** |
| `P80_TRUSTED_ORIGINS`, boot-tier, wildcards refused at startup | **done** |
| CORS 403 names the permitted list; second startup warning | **done** |
| `docs/SETUP.md` section | **done** |

### Media library CRUD (ADR 0024)

**Code-complete; five manual checks outstanding.** Outside a stage; noted here per §5.1.
Upload from the laptop, browse the media root, delete what P80 wrote.

| What | State |
|---|---|
| ADR 0024 written and accepted; `CLAUDE.md` rules 1/3/4 and `04-providers.md` §1 amended | **done** |
| Migration 0003 `media_uploads` + Drizzle mirror | **done** |
| `safeMediaFilename`, `uploadPartialPath`, `resolveMediaDir`, `nextChunkPlan` | **done** |
| `POST/GET/PUT/DELETE /api/uploads*`, chunked and resumable | **done** |
| `GET /api/library`, `DELETE /api/library/file` | **done** |
| Web `/library` — dropzone, progress, resume, browser, two-step delete | **done** |
| Media-policy scan rewritten as an exact writer inventory | **done** |
| `smoke.sh` extended to 96 checks | **done** |
| Manual checks M1–M5 | **not run** |

**M1** upload a multi-hundred-MB file from the laptop over Tailscale. **M2** toggle Wi-Fi
mid-upload and confirm it resumes rather than restarts. **M3** cancel and confirm no
`.part` survives and no video row was created. **M4** browse and confirm `scp`'d files
appear correctly marked. **M5** delete a referenced upload — refusal, then acknowledged
delete, then the video still opens with its transcript and offers repair.

`/home/dylan/Videos` is currently **empty**, which is why the ten older manual checks have
never run. This is the feature that fixes that: M1 produces the German video file all of
them have been waiting on, so do M1 first and then work through the backlog in one sitting.

#### Three defects found, none of them caused by this work

- **The media-policy static scan was never enforcing its own rule.** It only inspected
  files that literally mention `P80_MEDIA_ROOT` or call `assertInsideMediaRoot`, so a
  module taking `mediaRoot` as a parameter — the normal way to write one — was invisible to
  it, and its primitive list omitted `writeSync`, `linkSync`, and `renameSync`. It would
  have gone on passing while an upload writer was added. Now an exact inventory of all four
  filesystem writers in production code, verified to fail when a fifth appears.
- **Every Fastify framework refusal was reported as `500 INTERNAL_ERROR`.**
  `toEnvelope` only recognises `P80Error`, so `FST_ERR_CTP_BODY_TOO_LARGE` (413) and
  `FST_ERR_CTP_INVALID_MEDIA_TYPE` (415) both became "the server broke". Already true of
  the transcript route's 4 MB limit; latent only because nothing had exceeded it. Handled
  as a class in `setErrorHandler`, not one code at a time.
- **`resolveMediaPath` resolves lexically, so a symlink out of the media root was
  followed.** `..` was caught; `<root>/link-to-elsewhere/file.mp4` was not. Pre-existing
  and unrelated to uploads, but the library browser turns it from a hand-built path into a
  clickable entry. `realPathEscapesRoot` closes it on the read side.

**2723 TypeScript tests** (up from 562 — most of the jump is a 2000-case fuzz property over
`safeMediaFilename`), nine packages typechecking, `pnpm --filter @p80/web build` clean, and
`smoke.sh` 93/96 against a scratch instance with the sidecar deliberately not started.

**Not yet deployed.** The change is uncommitted and `deploy.sh` refuses a dirty tree;
smoke ran against a throwaway API+worker on `:5199` with its own database and media root,
so the installed services and `/home/dylan/Videos` were untouched and migration 0003 has
**not** been applied to the live database.

### A silently disarmed sidecar, and a UI that could not say so (2026-08-22)

**M1 ran.** A 7-minute German video uploaded from the laptop over Tailscale, 38.5 MB in five
chunks, and `/home/dylan/Videos` is no longer empty — the thing the ten older manual checks
were waiting on. The upload itself worked on the first try. What followed did not, and took
three fixes.

The video appeared stuck at "loading". It was not stuck: `INGEST_MEDIA` succeeded — hash,
duration, the lot — and `TRANSCRIBE` then failed three times in 25 ms with
`ASR_UNAVAILABLE`. `faster-whisper` was simply gone from `services/nlp/.venv`.

| What | State |
|---|---|
| `deploy.sh` syncs `--inexact`; `test/deploy-parity.test.ts` guards it | **done** |
| `listJobs` + `useLatestJob`; the upload panel follows `TRANSCRIBE` | **done** |
| `VideoDetail` renders the job's real error instead of guessing | **done** |
| `listJobs` orders `created_at DESC, id DESC`; `apps/api/test/jobs.test.ts` | **done** |
| ASR extra reinstalled; `/health` reports `transcribe_available: true` | **done** |

- **`scripts/deploy.sh` was uninstalling the ASR extra on every deploy.** `uv sync` is exact
  by default and prunes anything outside the set it resolved; `service-install.sh` tells you
  to build the venv *with* `--extra asr`, so the two disagreed and deploy ran more often. The
  venv's site-packages mtime matched the 2026-08-16 deploy exactly. Now `--inexact`, which
  preserves `align` too — `docs/SETUP.md` offers the two extras as independent choices, so a
  hardcoded `--extra asr` would have half-fixed it. CI stays bare on purpose and the new test
  asserts both halves.
- **`smoke.sh` could not have caught it and still cannot.** Check 62 greps for the *key*
  `"transcribe_available":`, not its value, because smoke has to pass on a base install.
  Left alone deliberately; the deploy-parity test is the guard instead.
- **The browser followed only the ingest job.** `TRANSCRIBE` is enqueued inside the worker,
  long after the `202 { video, jobId }` went out, so its id was in no response the client
  ever saw. Ingest succeeded, `<JobStatus>` renders nothing for a success, and the panel fell
  silent while the real work had already failed. `GET /api/jobs?entityId=` was already in the
  contract and already implemented — nothing needed adding to the API.
- **`listJobs` had no tiebreak.** `ORDER BY created_at DESC` on millisecond timestamps, with
  both new surfaces using `limit=1` to mean "the current attempt". Ids are ULIDs, so
  `id DESC` makes it deterministic.

**Effective ASR settings are not what `.env.local` says.** `P80_ASR_MODEL` had a `settings`
row of `medium` overriding the environment's `large-v3`, and the sidecar's `/health` reports
the *environment* value — so `/health` said `large-v3` while every job ran `medium`. Exactly
the trap `CLAUDE.md` §4 warns about. Now `large-v3-turbo`: multilingual, and both faster and
more accurate than `medium`.

**Transcription is 3× faster than realtime on CPU, and no GPU is wanted.** The retried job
finished 7:01 of audio in 134 s of wall clock — 0.32× realtime, `int8` on 20 aarch64 cores,
*including* the one-time model download. 123 segments, 526 words, `detectedLanguage: de`,
four `low_asr_confidence` warnings. Steady-state will be faster still, since `asr.py:240`
reloads the model on every request.

This retires most of the speed question before it was asked. `docs/SETUP.md` and ADR 0016
both claim CPU is "roughly twenty times slower" and warn of a job that "looks like it is
working for forty minutes" — measured against `large-v3`, and not true of `large-v3-turbo`
here by two orders of magnitude. Both documents overstate the case and should be corrected
against a real number rather than left as folklore; `P80_ASR_REQUIRE_GPU` defaulting to
`true` is a refusal protecting against something this machine does not experience. Beam
size, batching, and a CUDA build are all unnecessary at this speed. **ADR 0016's open
question is now half-answered** — turbo's wall clock is recorded, its WER is not, and the
comparison still needs the ADR 0006 corpus rather than one football broadcast.

**`isJobStalled` misreports a queued job and was left alone.** It fires on `pending` past
120 s and says "the worker process is not running", which is wrong when the single worker is
simply busy with another transcription — now a realistic wait rather than a theoretical one.
Re-dating the clock from `job.createdAt` was tried and reverted: it makes the wrong message
appear *sooner*, and the case it would have helped does not arise, since the video page
reads a settled job rather than polling one. Telling "no worker" from "worker busy" needs
more than a clock.

Three follow-ups, deliberately not done here: the retry bug (`failJob` ignores
`P80Error.retryable` and `loop.ts` only sleeps when nothing was claimed, so a non-retryable
failure burns all three attempts instantly and a retryable one re-runs with no backoff); a
retry button, since `POST /api/jobs/:id/retry` exists and no client uses it; and caching
`WhisperModel`, which `asr.py:240` currently constructs inside `transcribe()` on every
request.

**Next: Docker.** Agreed direction — all four processes, superseding ADR 0021. Not started,
no ADR yet, container scope undecided. All GPU access on this machine goes through SIR on
`:8000`, so the sidecar must not take a GPU directly and a CUDA CTranslate2 build is not the
path. `deploy.sh --inexact` is the stopgap until the sidecar is an image with its extras
baked in.

## Containerised, in two steps (2026-08-23)

**ADR 0025 accepted; ADR 0021 superseded in part.** §1 (user units over containers) is
reversed. §2 (the API serves the built client) and §3 (entry points invoked directly, for
signal delivery) survive and are relied on.

| | Before | Now |
|---|---|---|
| Units | `p80.target` + migrate/api/worker/nlp + backup timer | `p80.service` + backup service/timer |
| Processes | four, out of the checkout under `tsx` | four containers, same entry points |
| Networking | loopback, directly | loopback, directly — `network_mode: host` |
| Deploy artifact | the checkout | `p80-node` and `p80-nlp`, tagged with the commit |
| Rollback | re-checkout, reinstall, rebuild, restart | retag `:dev`, restart |
| Host needs | node, pnpm, uv, ffmpeg | a container runtime |

Landed as two steps against the running system, each verified before the next:

- **Step 1** — `deploy/docker/Dockerfile.nlp`, `services/nlp/.dockerignore`,
  `docker-compose.yml`, `test/docker-parity.test.ts`. Swapped the unit for the container and
  back. Health `transcribe_available: true`, transcription correct.
- **Step 2** — `deploy/docker/Dockerfile.node`, root `.dockerignore`, the other four compose
  services, `deploy/systemd/p80.service.in`, the four removed unit templates, rewritten
  `service-install.sh` and `deploy.sh`, amended `deploy-parity`, a CI image-build job, and
  the docs.

**Verified:** 2741 tests / 58 files; nine packages typecheck; `scripts/smoke.sh` 96/96
against the containerised stack, twice — once by hand and once after
`bash scripts/service-install.sh`. The installer's stale-unit sweep removed all five old
units. A full add → `INGEST_MEDIA` → `TRANSCRIBE` → `ready` chain ran across the worker and
sidecar containers, which is the media-path-identity property ADR 0021 called the central
risk. `p80-backup.service` produced a snapshot from a container; the timer is scheduled.

`bash scripts/deploy.sh --dry-run` passes against a clean tree: the rewritten preflight
clears docker, compose, the daemon, the installed unit, and the port check, and prints the
new stage list.

**Not verified:** a real `deploy.sh` run end to end, including the rollback path, and a
reboot.

### Two things found on the way, both out of scope and both worth fixing

- ~~**`scripts/smoke.sh:441` writes `P80_ASR_MODEL: medium` into the live database and never
  restores it.**~~ **Fixed 2026-08-23 — see below.**
- **Transcription is not reproducible run to run.** Two identical requests to the same
  container, same model and options, gave 524 and 542 words. The entire difference was one
  region at the end of the audio, where the second run hallucinated across several scripts
  (`Edhoff 1983 -Ball ...`). It was correctly flagged — three `low_asr_confidence`
  `low_logprob` warnings on segments 65–67 — so rule 12's machinery worked. This matters for
  **next action 4**: WER differences smaller than the run-to-run variance cannot be measured
  by transcribing once per model. `condition_on_previous_text` is the usual cause of a
  hallucinating tail and is unplumbed (`asr.py:261-269`).

### Known regression, recorded in ADR 0025

`P80_MEDIA_ROOT` is live-tier (ADR 0019) but a bind mount is fixed at `compose up`, so
pointing it at an unmounted directory cannot work until the unit restarts. It fails
honestly — `validateMediaRoot` runs inside the container and the preflight endpoint returns
`not_found` — but the capability is narrower than it was.

## A smoke suite that puts back what it changed (2026-08-23)

**ADR 0026 accepted; ADR 0019 amended.** Outside a stage; noted here per §5.1.

`smoke.sh` wrote `P80_ASR_MODEL: medium` and could not undo it, because there was no way to
undo any setting: `PUT /api/settings` took no null and `clearSetting` was never exposed. The
settings page showed `environmentValue` and offered no way back to it.

| What | State |
|---|---|
| ADR 0026 written and accepted; `03-api.md` §2 amended | **done** |
| `revertSetting`; `PUT /api/settings` accepts `null` | **done** |
| A revert of the media root pays the same orphan gate as a write | **done** |
| Web "Revert to it"; `p80 settings revert <key>` | **done** |
| `smoke.sh` reads value **and** source first, then restores exactly | **done** |
| `trap cleanup EXIT` — the four straight-line `rm`s moved into it | **done** |

**2750 TypeScript tests / 58 files** (up from 2741), nine packages typechecking, and
`smoke.sh` **98/98** against a scratch instance on `:5199` with its own database and media
root — 96 plus two new checks that assert the suite's own footprint. After the run every live
key read `source: environment` and the media root was empty. An interrupted run was checked
separately: `SIGINT` mid-suite now removes the fixture tree the straight-line form leaked.

Two things deliberately not done. **The 14 archived `Guten` items** left in the live database
by past runs stay: there is no item-delete route, archiving is the correct outcome of deleting
their video (§7 invariant 5), and reaching into the table behind the API is what ADR 0007
forbids. **`P80_ASR_REQUIRE_GPU` keeps its `true` default** — flipping it is a decision, not a
correction, and belongs with the CPU-speed folklore fix.

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

0. **Commit, then run all fifteen manual checks in one browser session.** Committing also
   unblocks `bash scripts/deploy.sh --dry-run` and a real deploy, which are the two parts of
   ADR 0025 a dirty tree prevented verifying. Then ADR 0024's M1 — upload a German video from the laptop — which finally
   supplies the file the other ten have been blocked on: Stage 2's M1–M5
   (`plan/stage-02-ingestion.md`), Stage 2b's M6 (`plan/stage-02b-settings.md`), and
   Stage 3's M1–M4 (`plan/stage-03-manual-items.md`). They also need one folder holding no
   video, and — for the transcription half — the ASR extra installed. Fifteen checks is the
   accumulated cost of four code-complete efforts nobody has sat in front of; doing them
   together is much cheaper than four sittings.
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
