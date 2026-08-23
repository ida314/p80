# ADR 0026 — Reverting a runtime setting to the environment

**Status:** Accepted
**Date:** 2026-08-23
**Amends:** ADR 0019 (runtime-editable settings)

## Context

ADR 0019 made seven keys editable while P80 runs. The `settings` table holds an **override**;
a key with no row takes its value from `.env.local`. The repository has said so since it was
written, and `clearSetting` — "reverts a key to its environment value" — has existed there
from the start.

It was never reachable. `PUT /api/settings` accepts `string | number | boolean` and nothing
else, so the only way to change a key is to write a row, and there is no way to remove one.
A setting written once stays written for the life of the database.

The surface makes the gap visible without offering a way out of it. Every row on the settings
page reports `source` (`environment` or `database`) and carries `environmentValue` alongside
the effective one — a user can *see* that `.env.local` says `large-v3` while the application
is running `medium`, and has no control that resolves the discrepancy. Typing the environment
value back in looks like a fix and is not: it writes a row holding the same string, which then
stops tracking `.env.local` and diverges silently at the next edit.

This was found through its consequence rather than by review. `scripts/smoke.sh` writes
`P80_ASR_MODEL: medium` to prove that a live key round-trips and reports itself as overriding
the environment. It cannot undo that write, so every smoke run permanently downgrades the
transcription model — the source of a `medium` override that was twice mistaken for a leftover
experiment. A test suite that cannot restore what it changed is a defect in the suite; a
suite that *has no way* to restore it is a missing capability.

## Decision

### 1. `null` in the write body means "drop the override"

`PUT /api/settings` accepts `null` as a value. The key's row is deleted and the effective
value returns to `loadConfig()`'s; the response reports `source: "environment"` for it, which
is how a caller confirms the revert rather than inferring it.

`null` rather than a `DELETE /api/settings/:key` route, for one reason: the ASR options are
edited together and the write is already a batch that either validates everything or writes
nothing. Reverting one key while writing two others is an ordinary edit, and splitting it
across two routes with two failure modes would make an atomic-looking form non-atomic.

Clearing a key that has no row is not an error. It is the state the caller asked for.

### 2. A cleared media root pays the same price as a written one

`P80_MEDIA_ROOT` is the key whose change decides what is reachable at all, so reverting it
runs the same path as setting it: validate the environment value, count the videos that would
stop resolving, and refuse without `acknowledgeOrphans` when that count is above zero.

Reverting is not inherently safer than writing. The environment value can be a directory that
no longer exists, or one holding none of the library — and a revert that orphaned a library
silently, because it was "only" undoing something, would be the worse of the two failures.

### 3. Both clients offer it, and only where it means something

The control appears on a row exactly when `source` is `database`. On a row already tracking
the environment there is nothing to revert, and a disabled button would imply otherwise.

## Consequences

- `writeSetting` gains a sibling, `revertSetting`, which refuses a non-editable key the same
  way and reports what it removed. The refusal matters here too: clearing a boot key would
  appear to work and change nothing.
- The settings surface becomes reversible, which is the property ADR 0019 §2 assumed when it
  chose to show `environmentValue` at all.
- `scripts/smoke.sh` can restore exactly what it read — the previous value when there was a
  row, and no row when there was not. Distinguishing those two is the whole point: writing the
  environment value back would leave the database subtly different from how the run found it.
- Nothing about precedence changes. The environment is still the floor, a row still wins, and
  `getRuntimeSettings` is still read per use.
