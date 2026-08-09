# ADR 0019 — Runtime-editable settings

**Status:** Accepted
**Date:** 2026-08-09
**Amends:** ADR 0007 (which client carries the settings surface), ADR 0015 (how the media
root is chosen), ADR 0016 (how ASR options reach the sidecar)

## Context

Every knob P80 has is an environment variable read once at process start. `loadConfig()`
runs in the API, in the worker, and in each CLI; the NLP sidecar reads its own `P80_ASR_*`
values from its own environment. Changing any of them means editing a dotfile and
restarting four processes.

For most of them that is correct. A port, a bind host, or a database path is an install
decision, and making it editable from a running process buys nothing. Two are different:

- **`P80_MEDIA_ROOT`** is the first thing a new install must set, and the thing that
  changes whenever the library moves to another disk. It has no default, deliberately
  (ADR 0015), so the first run is a text-editor round trip before the application can do
  anything at all.
- **`P80_ASR_REQUIRE_GPU`** is a per-run decision, not an install-time one. Its purpose is
  to make an absent GPU loud rather than silently twenty times slower (ADR 0016). A user
  who decides to accept one slow CPU run should not have to restart the worker to do it,
  and — more to the point — should not have to remember to set it back afterwards.

The generalisation of both is: **a setting that is read at the point of use can be edited
while the system runs; a setting that is consumed at startup cannot.** That distinction is
the decision.

## Decision

### 1. The existing `settings` table, seeded by the environment

`settings` — `key`, `value_json`, `updated_at` — has been in the schema since migration
0001 and in `02-database.md` since the contracts were extracted, unused. This is what it was
for, so no migration is needed and none is added. The API and the worker already share that
database, so they cannot disagree about a value the way two processes reading their own
environments can — which matters more for the media root than for anything else in the
system (the anchoring note in `loadConfig` is the same hazard one layer down).

**Precedence: the database wins, and the environment is the seed.** On a key with no row,
the effective value is the one `loadConfig()` produced. Writing the key stores a row, and
the row is authoritative from then on; deleting the row reverts to the environment. Every
read reports which of the two it came from, so a value that no longer matches the dotfile
is visibly overridden rather than mysteriously ignored.

The reverse precedence was rejected. An installation that has ever set `P80_MEDIA_ROOT` in
its environment — which is every installation, since the variable is required — would find
the settings surface inert for the one setting that motivated it.

### 2. Two tiers, and the boundary is honest

| Tier | Keys | Behaviour |
|---|---|---|
| **Live** | `P80_MEDIA_ROOT`, `P80_ASR_MODEL`, `P80_ASR_DEVICE`, `P80_ASR_COMPUTE_TYPE`, `P80_ASR_REQUIRE_GPU`, `P80_ASR_ALIGN`, `P80_ASR_LANG_MIN_PROB` | Editable; takes effect on the next use, no restart |
| **Boot** | bind host, LAN flag, all three ports, database path, storage path, log level, the two vLLM keys, the sidecar base URL | Displayed, never writable |

A key is **live only if every consumer reads it at the point of use.** Nothing caches the
media root in a module variable or closes over it at construction time; each request and
each job resolves it again. A SQLite read of one row costs microseconds and buys the
property that there is no window in which the API validates a path against one root while
the worker resolves it against another. That window is the temporal form of the bug
ADR 0012 records, and it is the reason "just reload the config object on change" was
rejected — a reload has a window, a read at the point of use does not.

The boot tier is shown read-only rather than hidden. A settings page that omits the port
it is served on is a settings page the user will not trust. Each row says where the value
came from and that a restart is what changes it.

**`P80_ALLOW_LAN` and `P80_BIND_HOST` are boot-tier for a second reason**, beyond being
consumed by `listen()`. Spec §32.5 makes LAN exposure an opt-in act with a warning. A
browser-reachable toggle would make it something a page can do, which is a weaker
guarantee than the one the spec asks for — and it is the one setting where the difference
is a security property rather than a convenience.

### 3. The media root stays a boundary, and gains guards

`CLAUDE.md` rule 4 assumes the containment root is trusted configuration. Making it
writable over HTTP is a real change to that assumption and is named here rather than
absorbed: whatever the root points at becomes readable through
`GET /api/videos/:id/media`, subject to the extension allowlist.

Four guards, in place of the previous guarantee that the value came from a file only the
operator could edit:

1. **Structural.** Absolute, non-empty, no NUL byte, at most 1024 characters.
2. **A refusal list.** The filesystem root, and anything at or inside `/etc`, `/proc`,
   `/sys`, `/dev`, `/boot`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/usr`, `/var`, or `/run`.
   Also anything at or inside `P80_STORAGE_PATH`, because rule 3 says the storage
   directory holds no media and a root that contained it would contradict that.
3. **It must exist**, be a directory, and be readable. A typo becomes a rejection rather
   than an empty library.
4. **It is logged** at `warn` on every change, with the old and new values.

The refusal list is not a security boundary and is not claimed as one — a determined
caller with API access can still choose a directory full of media. It is there so that the
worst single keystroke is not `/`. The actual boundary remains what it was: loopback
binding and strict CORS.

**Rejected: an environment-declared allowlist** (`P80_MEDIA_ROOTS`, with the surface
choosing between entries). It preserves rule 4's exact shape and was the safer option, but
it reintroduces the dotfile round trip for the case that motivated the change — pointing a
fresh install at a library for the first time.

### 4. Changing the root states its cost before paying it

`videos.media_path` is relative to the root (ADR 0015), so a new root makes every existing
video resolve somewhere else — in practice, nowhere. Nothing is destroyed: the rows, the
transcripts, the corrections, and everything built on them are untouched, and setting the
root back restores playback exactly.

That is still a change the user must see coming, so it is preflighted. The write reports
how many videos resolve under the proposed root and how many do not, and a write that
would orphan any video is refused with `409 MEDIA_ROOT_WOULD_ORPHAN` unless it carries
`acknowledgeOrphans: true`. After a successful change every video's `media_missing` flag is
recomputed, so the library list is truthful immediately rather than one click at a time.

This is the same shape as `TRANSCRIPT_ALREADY_EXISTS` requiring `replace: true`: the cost
is counted, stated, and then paid deliberately.

### 5. ASR options travel in the request, not in the sidecar's environment

The sidecar keeps no settings of its own to be edited. `POST /transcribe` gains an optional
`options` object, and any field present overrides what `Settings.from_env()` would have
produced. This keeps the sidecar stateless per request (ADR 0002) and keeps SQLite out of
Python.

The TypeScript configuration schema becomes the authority for the ASR defaults, which is a
change: they used to live only in `asr.py`. The Python defaults remain, because direct
callers and the sidecar's own tests need them, and the two tables are pinned to identical
values by a test on each side. Two defaults that silently disagree would surface as a model
change nobody made.

`GET /health` on the sidecar still answers from its own environment. It reports whether
`faster-whisper` is importable, which no P80 setting affects.

### 6. Both clients carry the surface

ADR 0007 assigned settings to the TUI, on the grounds that the split runs along whether a
surface needs media. Settings does not need media, so the rule placed it in the terminal.

That rule is amended, narrowly. The web client gains a settings page, and the TUI gains
`p80 settings` and `p80 settings set`. The justification is not convenience: **the media
root governs whether the media surfaces work at all**, and a browser client that renders a
library of unplayable videos while the control that fixes them lives in another application
is a worse split than the one ADR 0007 was avoiding. The remaining management surfaces —
candidate inbox, items, stats, diagnostics — stay in the TUI, and the reasoning that put
them there is untouched.

Both clients go through `/api/settings` and hold no validation of their own. The refusal
list, the orphan count, and the parsing all live behind the API, which is what keeps a
second client cheap (ADR 0007's `curl` test).

## Consequences

- **No migration.** The one table this needs already exists and was already documented; it
  had simply never been written to. The `settings` key registry in `packages/core` is what
  constrains which keys may appear in it, rather than a CHECK constraint — the eligible set
  changes with the code that reads each key, and a CHECK would need the 12-step rebuild that
  `0002_local_media` warns against to follow along.
- Six `P80_ASR_*` keys join the closed `CONFIG_KEYS` allowlist. The credential-shaped-key
  guard still applies to it and to the settings key registry, which is the mechanical form
  of rule 14.
- `P80_MEDIA_ROOT` still has no default and is still required at startup. The database can
  override it; it cannot supply it. A first run with the variable unset still fails naming
  the variable, because a process that started with no root would have nothing to seed and
  nowhere to serve the settings page from.
- Every consumer of the media root now reads it per use. `Config` remains the boot-time
  snapshot and is no longer the right thing to read for a live key — the type system does
  not enforce that, so `resolveRuntimeSettings` is the single documented entry point.
- The settings surface is a new render path for values the user typed. It is escaped like
  any other untrusted text (rule 8); a media root is a string that will be displayed.
- Reversible. Deleting the `settings` rows returns the system to environment-only
  configuration with no schema change and no data loss.
