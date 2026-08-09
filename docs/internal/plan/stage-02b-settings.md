# Stage 2b — Runtime-editable settings

**Milestone:** M1
**Depends on:** Stage 1 (config, migrations, both clients), Stage 2 (media root consumers)
**Spec reference:** none. Spec §35 has no settings stage; §29's endpoint list has no
settings surface. This stage exists because ADR 0019 was written, not because the spec
asked for it.

## Objective

`P80_MEDIA_ROOT` and the six ASR options become editable while the system runs, from either
client, and the rest of the configuration becomes visible without opening a dotfile. After
this stage, pointing a fresh install at a media library is something you do in the
application rather than in a text editor followed by four process restarts.

## Why this is its own stage

It is out of Stage 2's scope by any reading — new table, new endpoints, a new page in the
web client, and a change to how the media root reaches its consumers. Working agreement
§5.1 says that needs a brief rather than a quiet expansion, and §5.4 says the decision needs
an ADR. That is ADR 0019.

Stage 2's remaining work is M1–M5, which needs a person, a browser, and a real video file.
This stage does not touch anything M1–M5 exercises except the source of the media root, and
criterion 5 below is the test that says so.

## Contracts in scope

Read before starting:

- `docs/decisions/0019-runtime-settings.md` — the whole of it; this stage is its
  implementation
- `docs/contracts/02-database.md` §3 (migration rules), and the new `settings` section
- `docs/contracts/03-api.md` §2a
- `docs/contracts/04-providers.md` §1a (the ASR request gains `options`)

May be changed by this stage:

- `02-database.md`, `03-api.md`, `04-providers.md` — all three amended, all three under
  ADR 0019

**Must not be changed by this stage:**

- `resolveMediaPath` / `assertInsideMediaRoot`. The containment check is not what changes;
  only where its root argument comes from. A diff that touches `media-path.ts` is a signal
  something went wrong.
- The `videos.media_path` semantics. Still relative, still repairable, still not absolute.
- Anything in the boot tier becoming writable. `P80_ALLOW_LAN` in particular.

## Steps

- [x] 1. ADR 0019, and the amendment note in ADR 0007
- [x] 2. ~~Migration `0003_settings`~~ — **not needed.** The `settings` table has been in
      migration 0001 and in `02-database.md` since the contracts were extracted, unused,
      and this is what it was for
- [x] 3. `packages/core/src/settings.ts` — the key registry, tiers, per-key schemas,
      `resolveRuntimeSettings`
- [x] 4. `packages/core/src/media-root.ts` — `validateMediaRoot`, the refusal list
- [x] 5. Six `P80_ASR_*` keys into `configSchema`, matching `asr.py`'s defaults
- [x] 6. `packages/database/src/repositories/settings.ts` — read, write, clear
- [x] 7. `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/media-root/preflight`
- [x] 8. Every media-root consumer reads it per use, not from `Config`
- [x] 9. ASR options in `AsrRequest` → the sidecar wire → `TranscribeRequest.options`
- [x] 10. `p80 settings` and `p80 settings set`
- [x] 11. Web `/settings` page, nav entry, API client functions
- [x] 12. Docs: `SETUP.md`, `.env.example`, `CLAUDE.md` §4, contracts

## Exit criteria

| # | Criterion | Verified by | State |
|---|---|---|---|
| 1 | A written setting survives a process restart and beats the environment | `packages/database/test/settings-repository.test.ts` | ☑ |
| 2 | A key with no row reports the environment value, and says so | `packages/database/test/settings-repository.test.ts`; `apps/api/test/settings.test.ts` | ☑ |
| 3 | A boot-tier key is refused by `PUT`, naming the restart | `apps/api/test/settings.test.ts` | ☑ |
| 4 | The refusal list holds: `/`, a system directory, a non-directory, a missing path, and a relative path are each rejected with a distinct reason | `packages/core/test/media-root.test.ts`; `apps/api/test/settings.test.ts` | ☑ |
| 5 | Changing the root changes what the API and the worker each resolve, in the same request cycle, with no restart | `apps/api/test/settings.test.ts`; `apps/worker/test/settings-media-root.test.ts` | ☑ |
| 6 | A root change that would orphan a video is refused without `acknowledgeOrphans` and reports the count | `apps/api/test/settings.test.ts` | ☑ |
| 7 | After a root change, `media_missing` is recomputed for every video | `apps/api/test/settings.test.ts` | ☑ |
| 8 | ASR options set through the API reach the sidecar request body | `apps/worker/test/transcribe.test.ts`; `packages/providers/test/asr-options.test.ts` | ☑ |
| 9 | The sidecar's request options override its environment, field by field | `services/nlp/tests/test_transcribe.py` | ☑ |
| 10 | The TypeScript and Python ASR defaults are identical | `packages/core/test/settings.test.ts`; `services/nlp/tests/test_transcribe.py` | ☑ |
| 11 | No settings key is credential-shaped | `packages/core/test/settings.test.ts` | ☑ |
| 12 | Both clients reach the surface through `/api/settings` and validate nothing themselves | `test/web-safety.test.ts`; `apps/tui` has no validation to test — reviewed | ☑ |

**Manual check.** One, and it needs the browser:

- **M6** — With `pnpm dev` running, open `/settings`. Change the media root to a directory
  that holds no video. The page states how many videos will stop resolving and requires a
  second confirmation; confirm, and the Videos list shows every video as missing with a
  repair affordance. Set the root back, and every video resolves again with no repair
  needed.
  **Fails if:** the change goes through with no count shown, or setting the root back leaves
  anything permanently marked missing.

## Explicitly out of scope

- **Any boot-tier key becoming writable.** Ports and the bind host are displayed, not
  edited. `P80_ALLOW_LAN` especially — ADR 0019 §2 explains why that one is not merely a
  restart problem.
- A settings *profile* concept, or per-video overrides. One machine, one set.
- A directory picker. The field takes a typed absolute path; a browse dialog means the API
  enumerating the filesystem for a client, which is a bigger surface than the problem.
- A restart button. P80 does not manage its own processes.
- Hot-reloading the log level. It is boot-tier because nothing reads it at the point of
  use, and making pino's level live means a watcher in every process for a setting nobody
  changes mid-session.
- Anything touching Stage 2's M1–M5.

## Risks

- **The media root becomes attacker-reachable configuration.** Contained by the refusal
  list, the existing extension allowlist, loopback binding, and strict CORS — and named as
  a real change in ADR 0019 §3 rather than absorbed. The refusal list is explicitly not
  claimed as a security boundary.
- **A cached root.** The whole live tier depends on nobody holding the value across a
  request. `createLocalMediaSource(mediaRoot)` closes over one by construction, so it is
  now built per use rather than per process.
- **Two ASR default tables drifting.** Pinned by a test on each side, each pointing at the
  other.

## Notes

- `Config` stops being the right thing to read for a live key while remaining the right
  thing for a boot key, and TypeScript cannot tell the two apart — both are string fields
  on the same object. `resolveRuntimeSettings` is the single entry point, and the media-root
  consumers were converted by grep. A new consumer reaching for `config.P80_MEDIA_ROOT`
  would compile.
- `P80_MEDIA_ROOT` is still required at startup even though the database can override it.
  Dropping the requirement was tempting — the settings page could supply it — but a process
  that has not started serves no settings page, and the failure it replaces is the clearest
  error message in the system.
