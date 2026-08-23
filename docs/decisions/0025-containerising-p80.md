# ADR 0025 — Containerising P80

**Status:** Accepted
**Date:** 2026-08-23
**Supersedes:** ADR 0021 (systemd user units over containers)
**Amends:** ADR 0022 (what a deploy does, and how it rolls back)

## Context

ADR 0021 chose systemd user units and rejected containers, with a seven-row comparison
table. ADR 0022 recorded the question as settled and not to be reopened. Reopening it needs
an argument, and the argument is a specific defect rather than a preference.

`uv sync` is exact by default: it uninstalls every package outside the set it just resolved.
The sidecar's speech-recognition dependency is an *extra*, installed as a separate operator
choice on top of the base sync, so it was outside that set — and the deploy script ran a
plain `uv sync`. **Every deploy silently uninstalled the ASR dependency.** The next
transcription job then failed with `ASR_UNAVAILABLE`, having never been touched by the
change that was deployed. Nothing in the deploy's own output said so, the smoke suite passed
throughout, and the failure was only findable by reading the worker's logs.

That has been fixed where it happened, and a test guards the flag. But the shape of the
problem is worth naming: **the deployed environment is a directory that commands mutate, and
the guard rail is a promise that no future command will mutate it wrongly.** The extras are
not the only thing living there. An image cannot drift, because there is no later command
with the power to prune it.

Three of ADR 0021's objections have also expired since it was written.

| ADR 0021's row | Status |
|---|---|
| GPU for ASR: native, versus a container runtime wired for the GPU per host | **Withdrawn.** Speech recognition measures 0.32× realtime on CPU — three times faster than the audio plays. The machine's speech-recognition library publishes no GPU wheels for its architecture anyway, and the local inference server it would otherwise borrow a GPU through exposes no audio endpoint. No container needs a GPU. |
| Media root: bind-mounted at an identical absolute path in three services, or the sidecar opens the wrong file | **Stands, and is one line of configuration.** A stored media reference is *root-relative*, so the database does not pin a location; only the worker-to-sidecar request carries a resolved absolute path. Mounting the root at the path it already has satisfies it, and a test asserts the mount is path-identical. |
| Loopback binding: binds `127.0.0.1` directly, versus binds `0.0.0.0` inside and loopback depends on the publish flag | **Withdrawn** under host networking (§2). The process still binds `127.0.0.1` itself. |
| Native modules: rebuilt per image; `node_modules` cannot cross architectures | Stands. The build host and the deploy host are the same machine, so this costs a builder stage rather than a cross-compile. |
| Speech model cache: a directory that persists, versus an explicit volume or gigabytes re-downloaded per start | Stands, and costs one bind mount. The systemd unit already had to pin `HF_HOME` explicitly for exactly this reason; the decision moves, it does not appear. |
| Configuration: one `.env.local`, versus `.env.local` plus image env, volumes, and port publishing | Stands. This is the honest price of the change. |
| Isolation and reproducibility: the real advantage | The reason to do it. |

ADR 0021 also left one door open, and it is the door this walks through: *"A sidecar in a
container remains the sensible answer when the host's own speech-recognition build cannot
reach the GPU, and it needs no new mechanism."* The mechanism was already there. What changed
is that the sidecar's dependency drift turned out to be a defect in production rather than a
hypothetical.

## Decision

### 1. P80 deploys as containers, in two steps

**Step one is the NLP sidecar alone.** It is the service whose dependency drift caused the
outage, it shares no source with the TypeScript packages, and every script that cares
already branches on whether the sidecar is local. Step one changes no script and no unit: it
adds an image, a compose file, and a test, and the operator swaps one for the other to prove
it.

**Step two is everything else** — the API, the worker, the migration one-shot, and the
backup job — together with the deploy script and the collapse of the unit set.

Two steps rather than one because the deploy path is itself part of what changes, and a
migration that breaks the way changes are delivered is a migration that cannot be backed out
by delivering a change.

### 2. Host networking

`CLAUDE.md` rule 13 says P80 binds `127.0.0.1`. Under a bridge network a container binds
`0.0.0.0` and a publish flag decides what that means from outside — the guarantee moves out
of the process and into the orchestration file, where it holds because someone wrote
`127.0.0.1:` in front of a port mapping and keeps writing it.

Host networking keeps the guarantee where the rule puts it. Each process reads
`P80_BIND_HOST` and binds loopback itself, exactly as it does today. Everything that
addresses P80 by a loopback URL — the CORS allowlist, the reverse-proxy origin from ADR
0023, the worker's sidecar client, the terminal client's health probe, the smoke suite, and
the deploy script's health poll — keeps working with no change and no second definition of
where anything is.

The cost is that the containers share the host's network namespace, so they are not isolated
from each other or from the host at the network layer. For a single-user application with no
authentication, whose entire purpose is reaching one user's own filesystem, that isolation
was never load-bearing. The isolation worth having here is of the *dependency set*, and
that is unaffected.

### 3. A systemd unit supervises compose; it does not disappear

Restart policies start containers when the daemon starts. They do not survive a reboot into
a session that has not started, they do not give the operator one name to stop, and they
have no timer. Everything ADR 0021 bought — start at boot under the user's own account,
nothing as root, one grouping name, logs in the journal, and a daily backup on a schedule —
is worth keeping, and a thin unit keeps all of it.

Five units become two and a timer: one that runs compose, and the backup job that was
already deliberately outside the group because a backup is worth taking whether or not the
rest of P80 is running.

### 4. Development stays native

Containers are the deployment target. The development command keeps starting processes on
the host with file watchers and hot reload, where they are fast and where a bind mount is
not in the path of every file change. ADR 0021 already established that the two ways of
running P80 differ and cannot run at once; this does not add a third.

### 5. The image ships source, because P80 has no build output

ADR 0021 §3 runs TypeScript from source under a loader, and §3's reasoning — one process,
one signal path, so a stopping worker finishes the job it claimed — applies unchanged to a
container entry point. Nothing in the repository emits compiled JavaScript, and the only
build output of any kind is the browser client.

So the runtime image contains the source tree and the development dependencies. That is
larger than a compiled artifact would be, and introducing an emit step is a real
improvement — but it is a *different* decision, and making both at once produces a
deployment where a regression cannot be attributed to either. ADR 0021 §3 stands until
something supersedes it on its own merits.

## Consequences

- **A live setting becomes effectively a boot setting.** ADR 0019 makes the media root
  editable from the settings surface while P80 runs. A bind mount is fixed when the stack
  starts, so pointing the setting at a directory that is not mounted cannot work until it
  restarts. This degrades honestly rather than silently: the validator runs *inside* the
  container, so the preflight endpoint that the settings surface already calls reports
  *"There is no directory at that path"* — the same refusal a genuinely missing directory
  gets. The capability is narrowed; the failure is not new and is not quiet.
- **Rollback improves.** ADR 0022 rolls code back by re-checking-out, reinstalling,
  rebuilding, and restarting — a sequence with several ways to fail while already failing.
  Images tagged with the commit make a rollback a start of the previous tag. The database
  still never rolls back automatically, and that is unchanged and deliberate.

  **The tag to start is the one that was running, not the one that is checked out.** Those
  are the same commit when a deploy is a pull that moves `HEAD`, and they are not under
  `--no-pull` or `--ref` — where the checkout is already the build being deployed, so
  restoring its own commit restores the failure. Rehearsing it found exactly that: the
  rollback reported the images restored and left P80 down. What is running is read back from
  the images themselves, since `:dev` and `:<commit>` name the same one, so there is no
  second record of the deployed version to keep in step. `test/deploy-parity.test.ts` holds
  the distinction.
- **A volume snapshot is not a backup.** The database is in WAL mode and held open, which is
  why backups are taken with `VACUUM INTO` rather than by copying the file. Container
  tooling makes snapshotting a volume look like the obvious move; it would produce a torn
  file. The backup job is a container running the same command as before.
- **Where a media root may live is constrained, and mounting it in place sidesteps that.**
  Validation refuses system directories — among them `/usr` and `/var` — so a container
  convention of `/var/media` would be rejected by P80 itself. Mounting the host path at the
  same path avoids the question, and is required anyway for the worker and the sidecar to
  agree on what a path means.
- **The host stops needing a correct toolchain.** No Python resolver, no Node version, no
  package manager, and no `ffmpeg` on the deploy machine's path. It needs a container
  runtime and the environment file.
- **Two mechanisms read the environment file, and both must be pointed at it.** Compose
  populates a container from one file and resolves `${...}` in its own configuration from
  another, and the second defaults to a name P80 does not use. An invocation that forgets it
  fails loudly rather than mounting something unintended, because the media root is written
  as a required substitution.
- **The build downloads packages; the runtime still does not.** Rule 15's empty
  outbound-request list is about P80 running, and is unaffected — the same distinction ADR
  0022 drew for continuous integration.

## Alternatives considered

**A bridge network with published loopback ports.** Real network isolation, and the sidecar
would stop being reachable from the host at all, which today it is. Rejected because it buys
isolation P80 has no use for at the price of the one rule that is stated in terms of a bind
address, and because it would require a second, different answer to "where is the sidecar"
in configuration that currently has one.

**Containers with no systemd at all.** A cleaner story, and it loses the boot behaviour, the
single grouping name, the journal, and the timer, replacing the last of those with a
scheduling container. Rejected: the unit is four lines and keeps four properties.

**Containerising only the sidecar and stopping there.** Genuinely tempting — it is where the
defect was, it needs no new mechanism, and it is step one of this ADR regardless. Rejected as
an endpoint because it leaves two deployment models to understand, and the remaining one
still depends on the host having a correct Node, package manager, and `ffmpeg`.

**Leaving it alone and trusting the guard test.** The test asserts one flag in one script. It
cannot assert that the environment is correct, only that one known command is not the thing
destroying it — which is a fair description of the class of bug, not of the instance.
