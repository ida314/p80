# ADR 0022 — How a change reaches the running system

**Status:** Accepted; amended by 0025
**Date:** 2026-08-15
**Builds on:** ADR 0021 (P80 runs as systemd user units; the API serves the built client)

> **Amended by [ADR 0025](0025-containerising-p80.md) (2026-08-23).** Every decision here
> stands — checking is hosted and deploying is a local, pull-based command; the gates run
> twice; the code rolls back and the database never does. What changed is the artifact.
> Deploying now builds two images and tags them with the commit, and rolling back points a
> tag at the previous pair rather than rebuilding from a restored checkout. The claim in §1
> that *"there is no artifact"* is the one sentence 0025 makes false, and it made the
> rollback better rather than worse.

## Context

ADR 0021 gave P80 a way to run. It did not give it a way to *change*. Updating an installed
P80 was a paragraph of documentation — rerun the installer, or `pnpm build` followed by
`systemctl --user restart p80.target` — with nothing checking the change first, no snapshot
before the migrate unit ran, no verification afterwards, and no way back. The gates that do
exist (`pnpm -r typecheck`, `pnpm test`, `pnpm build`) were run by hand, when remembered.

Three properties of this system rule out the conventional answer, which is a pipeline that
builds an artifact and pushes it to a host:

- **There is no artifact.** ADR 0021 §3 runs TypeScript from source under `tsx`, on the
  grounds that a compile step would be a second way to build the same programs and a second
  thing to be stale. The only build output in the whole repository is `apps/web/dist`. So
  there is nothing for a pipeline to *produce* — only something for it to *check*.
- **The deploy target is the machine that holds the user's library.** P80 reads the user's
  media in place (ADR 0015), binds loopback, and makes no outbound request at runtime. It is
  one user, on one machine, reading their own files.
- **That machine is not a build machine.** It is `aarch64`, it has the real `.env.local`,
  the real media root, and a `better-sqlite3` binding compiled for it. A hosted runner has
  none of those and is `x86_64`.

## Decision

Two halves, deliberately not joined into one pipeline.

### 1. Checking is hosted. Deploying is local, manual, and pull-based.

| | Where | Trigger | What it proves |
|---|---|---|---|
| CI — `.github/workflows/ci.yml` | GitHub Actions, `ubuntu-latest` | every push | the change is correct on a clean machine that has never been configured |
| CD — `scripts/deploy.sh` | the machine P80 is installed on | run by hand | the change is correct *here*, and the running system survived it |

Nothing listens for a deploy instruction. There is no webhook, no runner, no agent, and no
inbound path of any kind; a deploy is somebody typing `bash scripts/deploy.sh`, and it works
with the network down as long as the commit is already local.

### 2. The gates run twice, and that is not redundancy

CI runs on a clean checkout with a synthesized `.env.local`, which is the only way to catch
the class of bug where the suite passes because of a file on one developer's disk — the
failure `packages/core/test/config.test.ts` was written to make visible. The deploy script
runs the same gates against the real configuration on the real architecture, which is the
only way to catch a native binding, a path, or a model that exists in one place and not the
other. Neither is a superset of the other, and a green CI run is not permission to skip the
local one.

### 3. The code rolls back automatically. The database never does.

`deploy.sh` snapshots the database before restarting — the restart is what runs
`p80-migrate.service`, and a migration is the one step in a deploy that cannot be undone. The
snapshot is tagged, which under ADR 0021 §5's retention means it is never pruned.

If anything from the build onward fails, the script returns the checkout to the previous
commit, reinstalls, rebuilds, restarts, and re-verifies. It then **prints the snapshot path
and the restore command without running it.**

Restoring would silently discard every review completed since the snapshot was taken. A
script is the wrong thing to be making that trade. Migrations here are forward-only and
additive, so the previous code against the newer schema is usually fine — and in the case
where it is not, the person deploying needs to know before losing review history rather than
after. Rolling back code is reversible; rolling back a database is not.

### 4. This is development tooling, not P80's runtime

Worth stating plainly, because a workflow file that talks to GitHub sitting in this
repository invites the wrong reading. `CLAUDE.md` rule 15 says P80 makes no outbound request
at runtime and that the list is empty. That claim is about what a *running P80 process*
does, and no deployed process — not the API, the worker, the sidecar, or the browser client —
talks to GitHub, or knows it exists. CI is something a developer's push does, on somebody
else's computer, to a checkout that is not this deployment. The empty list is unaffected.

Rule 14 is likewise untouched: **the workflow uses no secrets, and needs none.** It builds
its `.env.local` by copying the committed `.env.example`, which holds local endpoint config
only and says so in its own header. There is no credential to leak because there is no
credential.

## Consequences

- A push is checked without anyone remembering to check it. A deploy is one command that
  refuses on a red gate rather than half-completing.
- **`pnpm db:backup` gained `--reason <slug>`.** `backupDatabase` already supported a tag and
  the CLI did not expose it, so every snapshot was routine and expired on the 30-day window.
  The reason is validated rather than sanitised: it becomes a filename segment, and
  retention decides what is routine by counting segments, so a reason containing a dot would
  quietly return a tagged snapshot to the prunable set. That failure is discovered by finding
  the snapshot gone at the moment it is needed.
- **A latent stdout collision in `db:backup` became a real one and was fixed.** The CLI wrote
  its path to stdout as a data channel while pino logged to the same descriptor — the exact
  defect that made `scripts/smoke.sh` flaky against `dev:noop`, latent here only because
  nothing had ever consumed backup's stdout. `deploy.sh` consumes it, so the CLI now logs
  through `createCliLogger` to fd 2.
- The deploy script refuses to run against a dirty tree, a detached HEAD it was not pointed
  at, a non-fast-forward, or a port already held by something that is not the `p80-api` unit
  — that last one being `pnpm dev`, which cannot coexist with the installed services.
- CI cannot run `scripts/smoke.sh` or `scripts/service-install.sh`; both need live systemd
  units. The smoke suite is the deploy script's verification step instead, which is the only
  place it can meaningfully run.
- No linter is introduced. There is none in the repository, and adding one is a separate
  decision rather than a thing to smuggle in with a pipeline. The source-scanning policy
  tests already run inside `pnpm test`.

## Alternatives considered

**A self-hosted runner, with a `deploy` job after CI.** The obvious way to get both halves
from one workflow file, and the reason it is rejected is not cost: it would put a
GitHub-controlled agent with checkout and execute rights on the machine that holds the user's
media library and database, and it would make deploying depend on GitHub being reachable. A
pull-based script inverts both — nothing listens, nothing inbound, and the deploy works
offline. For a single-user local-first application this is strictly less machinery for
strictly more control.

**A timer that polls `origin/main` and deploys itself.** Attractive, and rejected for one
reason: it makes an unattended migration possible. Every deploy here should have someone
present who can read the rollback message and decide about the database. Push-to-deploy is a
property of systems where a bad deploy is undone by deploying again, which is not true of a
step that migrates.

**A pre-push git hook running the suite.** Cheap, and it would catch things earlier.
Rejected as the primary gate because hooks are per-clone, invisible, and skipped by
`--no-verify` exactly when someone is in a hurry — which is when a gate matters. Nothing
stops one being added later as a convenience; it would not be the thing being relied upon.

**Containers, again.** Settled by ADR 0021 and not reopened. The argument there — GPU access
and the meaning of an absolute path — applies unchanged to deployment.
