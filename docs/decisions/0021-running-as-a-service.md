# ADR 0021 — Running P80 as a service

**Status:** Accepted
**Date:** 2026-08-09
**Amends:** ADR 0007 (where the browser client is served from, once it is built)

## Context

P80 had no way to run except `pnpm dev`. That command starts four processes with file
watchers, pipes their output into one terminal, and kills all of them when any one exits —
a deliberate choice for development, where limping along with three of four running
produces confusing failures somewhere else entirely. Every one of those properties is wrong
for a system somebody uses. Closing the terminal ends the session; a crash ends it silently;
a reboot ends it permanently.

Nothing shipped a production run mode either. `apps/api` and `apps/worker` had only
`dev: tsx watch src/main.ts`, no package emitted compiled output, and nothing served
`apps/web/dist` — the browser client existed only behind Vite's dev server, which also
proxied `/api/*` to make the client's relative URLs resolve.

The constraints are unusual enough to decide the answer:

- P80 reads the user's own media **in place**, from a single `P80_MEDIA_ROOT`, and rejects
  any path that escapes it (ADR 0015). The path is not a detail of the deployment; it is the
  containment boundary.
- The NLP sidecar is sent a media **path**, which it opens on its own filesystem (ADR 0016).
  Two components must agree on what an absolute path means.
- Transcription wants a GPU, and the sidecar is the one component with a heavy,
  platform-specific dependency tree.
- Everything binds `127.0.0.1`, and the external-request list at runtime is empty.
- It is one user, on one machine, reading their own files.

## Decision

### 1. systemd user units, not containers

Units under the user's own account, grouped by a `p80.target`, with lingering enabled so
they start at boot and survive logout. Nothing runs as root.

The comparison, since containers are the obvious alternative:

| | systemd user units | Containers |
|---|---|---|
| GPU for ASR | native | needs a container runtime wired for the GPU, per host |
| Media root | read in place; one path with one meaning | bind-mounted at an **identical absolute path** in three services, or the sidecar opens the wrong file |
| Native modules | built once for the host | rebuilt per image; `node_modules` cannot cross architectures |
| Speech model cache | a directory that persists | an explicit volume, or gigabytes re-downloaded per start |
| Configuration | one `.env.local` | `.env.local` plus image env, volumes, and port publishing |
| Loopback binding | binds `127.0.0.1` directly | binds `0.0.0.0` inside; loopback depends on the publish flag |
| Isolation and reproducibility | none beyond the user account | the real advantage |

Containers buy isolation and portability. P80 is a single-user application whose entire job
is reaching the user's own filesystem, so it has little use for either, and it pays for them
in exactly the two places that matter here: GPU access and the meaning of a path.

**What this does not close.** A sidecar in a CUDA container remains the sensible answer when
the host's own speech-recognition build cannot reach the GPU, and it needs no new mechanism:
`P80_NLP_BASE_URL` already points the rest of the system at wherever the sidecar is, and the
installer already declines to start a local one when it points elsewhere. That is a
deployment choice per machine, not a reversal of this decision.

### 2. The API serves the built browser client

Installed, there is no Vite, so `apps/web/dist` is served by the API on the API's own port.
The client uses relative URLs and needed no change.

This makes the deployed system one origin, which removes the proxy hop and stops CORS from
being load-bearing for the application's own requests. It does mean the API's origin joins
the allowlist — browsers attach `Origin` to same-origin requests whenever the method is not
GET or HEAD, so without it every write from the deployed UI would be refused. Both entries
are loopback; this widens *which loopback port* may talk to the API, not who may.

ADR 0007's split — management surfaces in the TUI, media surfaces in the browser, clients
holding no domain logic — is untouched. What changes is which process hands the browser its
files.

An unbuilt `dist` is not an error. `pnpm dev` never builds, so the API logs that it has no
client to serve and starts anyway.

### 3. `ExecStart` runs the entry point directly

Not `pnpm --filter @p80/api start`. Through pnpm the process chain is
`pnpm → sh -c → tsx → node`, so the service manager supervises pnpm: `SIGTERM` never
reaches the shutdown handler, and the service is killed at the stop timeout instead of
draining. The worker's "finish the job I have claimed" logic never runs at all.

`node --import tsx <entry>` is one process and one signal path. The sidecar uses its
environment's console script for the same reason.

This also means **the deployment runs TypeScript from source**, exactly as development does.
Adding a compile step would be a second way to build the same programs, and a second thing
to be stale. `tsx` is already a dependency and the startup cost is a fraction of a second.

### 4. Migrations are their own unit

The API and the worker each migrate on start and are written to tolerate losing the race.
A `oneshot` unit that both order themselves after removes the race instead, and — the real
reason — makes failure legible. A checksum mismatch on an applied migration is a hard error;
as a failed unit that is one line in `systemctl status`, where inside the API it is a
restart loop that reads as "the API is broken".

### 5. Backups are scheduled

`db:backup` existed and nothing ran it. A daily timer takes a `VACUUM INTO` snapshot
(ADR 0012 — not a file copy, because the database is in WAL mode and held open).

Retention is deliberately narrow, because deleting a backup is the only destructive thing
here. Only *routine* snapshots are pruned: backups tagged with a reason, such as the one
taken before a migration, are kept indefinitely, since they exist precisely because the act
they preceded cannot be undone. A floor of recent snapshots survives regardless of age, so a
machine that was off for two months does not come back, take one backup, and drop every
older one on the same schedule.

## Consequences

- P80 survives a reboot, restarts on failure, and logs to the system journal.
- The URL differs between the two ways of running it: the client is on the web port under
  `pnpm dev` and on the API port when installed. Nothing listens on the web port in a
  deployment, and the two cannot run at once.
- A rebuild is a deploy step. The API serves the files that were on disk when it started.
- Five failures in five minutes stops the restart loop. A unit that retries forever on a
  configuration error still reports "activating", which is the least useful thing it could
  say.
- Units load `.env.local` with no fallback, so a missing config file stops the unit by name
  rather than failing one layer deeper as `P80_MEDIA_ROOT: Required` — which reads as a
  broken API rather than as an unloaded config file.
- The installer removes P80 units it does not recognise. A unit left behind from an earlier
  layout stays enabled and keeps failing at every boot.

## Alternatives considered

**A supervisor around `pnpm dev`.** One unit, no new files. Rejected: the fail-fast group
kill turns any single crash into a full outage, the file watchers are pure cost, and the
signal problem is worse rather than better with another process in the chain.

**`vite preview` as the client server.** Cheaper — a script and a proxy block, and the URL
stays where development has it. Rejected in favour of one origin: the proxy exists only to
make relative URLs resolve, and the API can satisfy them directly. Vite also describes
`preview` as a way to check a build locally rather than as a way to serve one.

**System-wide units.** Rejected. P80 reads one user's files and binds loopback; running it
as root, or as a service account that then needs access to a home directory, adds privilege
without adding capability.
