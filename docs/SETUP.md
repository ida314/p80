# Setup

**Setup is not `pnpm install`.** It needs `ffmpeg` and a speech-recognition model to
transcribe anything; from Stage 4 it also downloads a spaCy model, two Wiktextract dumps,
and the OpenSubtitles corpus, then builds a dictionary index and a frequency count. Every
step is written down here because it is a real cost paid by every future contributor, agent
sessions included.

The first two sections are enough to add a video and read its transcript.

---

## Prerequisites

| Tool | Version | Why |
|---|---|---|
| Node | ≥ 22 | API, worker, clients |
| pnpm | ≥ 10 | Workspaces |
| uv | any recent | Python toolchain for the NLP sidecar (ADR 0002) |
| ffmpeg | ≥ 6 | Decoding audio for transcription, and reading a file's duration (ADR 0015). `ffprobe` ships with it. |
| a container runtime | Compose v2+ | Only to *run* P80 in the background (ADR 0025). Not needed to develop it. |

Everything above except the container runtime is for developing P80 — `pnpm dev` runs the
processes on this machine. An installed P80 runs from images that carry their own Node,
Python, speech-recognition dependencies, and `ffmpeg`, so a machine that only *uses* P80
needs the runtime and an environment file.

**`ffmpeg` was previously forbidden and is now required.** ADR 0015 replaced the embedded
player with local media files, and decoding a file the user already holds is the whole of
what transcription does. It reads local files only — P80 has no downloader, and
`test/media-policy.test.ts` enforces that.

Without `ffmpeg`, everything still works except transcription and duration detection. A
video's duration stays unknown rather than being guessed, and you supply a subtitle file
instead of having one produced.

`better-sqlite3` and `esbuild` run install scripts. They are allow-listed in
`pnpm-workspace.yaml` under `allowBuilds`, with a note explaining why each is permitted.
Both are build-time only, so spec §32.2's empty steady-state external-request list still
holds.

## Stage 1 — the skeleton

```bash
git clone <repo> && cd p80
pnpm install

cp .env.example .env.local          # required — then set P80_MEDIA_ROOT

# Python sidecar. uv reads services/nlp/.python-version and fetches 3.13 if needed.
uv sync --project services/nlp

pnpm db:migrate                     # optional; the API and worker also migrate on start
pnpm dev                            # api + worker + web + nlp
```

**`.env.local` is not optional**, even though every value in it but one has a working
default. `P80_MEDIA_ROOT` has none, deliberately (see *The media library*, below), so the
API and worker exit at startup naming it until the file exists and sets it.

Then, in another terminal:

```bash
bash scripts/smoke.sh               # 75 checks against the running system
pnpm --filter @p80/tui dev health   # the management client
```

Open <http://127.0.0.1:5173>.

### Why the Python version is pinned

`services/nlp/pyproject.toml` sets `requires-python = ">=3.11,<3.14"` and
`.python-version` pins 3.13.

spaCy's binary wheels lag new CPython releases by months, and `de_core_news_lg` ships as
a wheel too. Without the pin, Stage 4's model install fails partway through a large
download on a machine whose default interpreter is newer. With it, `uv sync` says so
immediately.

If uv reports no interpreter:

```bash
uv python install 3.13
```

## Commands

| Command | Does |
|---|---|
| `pnpm dev` | Starts api, worker, web, and the NLP sidecar |
| `bash scripts/service-install.sh` | Installs P80 as background services (ADR 0021) |
| `pnpm --filter @p80/tui dev settings` | Show configuration, editable and read-only |
| `pnpm test` | Vitest, unit + integration |
| `pnpm typecheck` | `tsc --noEmit` across all nine TypeScript packages |
| `pnpm db:migrate` | Applies pending migrations |
| `pnpm db:backup` | Snapshots the database into `data/backups/` |
| `pnpm dev:noop` | Enqueues a `NOOP` job so the worker has something to claim |
| `bash scripts/smoke.sh` | End-to-end check against a running P80, however it was started |
| `uv run --project services/nlp pytest services/nlp/tests` | Sidecar tests |

## Two processes `pnpm dev` does *not* start

Both are long-lived and expensive to start, so they are managed outside the dev command
(`CLAUDE.md` §4).

### vLLM (ADR 0005)

Serves the local model on loopback, OpenAI-compatible. **Expect it to be down through
Stages 1–6** — that is the spec §5.2 degraded path getting free exercise, not a
misconfiguration. Nothing in P80 performs a startup provider check, and no surface treats
an absent model as an error.

Point `P80_VLLM_BASE_URL` and `P80_VLLM_MODEL_ID` at it when you run one.

### uselimit

Enforces the enrichment ceilings — 100 candidates per video and 45 minutes per job, both
hard; 40 h/month, warn only. Not integrated until enrichment exists in Stage 6. It needs
a transactional SQLite `StorageAdapter` written upstream first, because the shipped
`InMemoryAdapter` is single-process and both the API and the worker consume budget.

### And one it starts *conditionally*

`pnpm dev` starts the NLP sidecar only when `P80_NLP_BASE_URL` names a loopback host.
Pointed at another machine, it prints a note and starts three processes instead of four —
a local sidecar would be a Python process on 5181 that nothing talks to, and both answer
`/health` identically while only one of them has the model.

A sidecar elsewhere opens media paths on **its own** filesystem, so that machine needs
`P80_MEDIA_ROOT` at the same absolute path. `scripts/service-install.sh` applies the same
rule and installs no sidecar unit in that case.

## Speech recognition (ADR 0016)

Optional, and the endpoint reports `501` when it is absent rather than returning an empty
transcript. Without it, ingestion falls back to supplying your own subtitle file.

```bash
# The ASR model. Roughly 1.5 GB for large-v3, downloaded on first use and cached.
uv sync --project services/nlp --extra asr

# Forced alignment refines word timings. Optional on top of the above: when it is missing,
# timings come from the model's own attention weights, the transcript records
# `asr_alignment_model_id: null`, and a warning says the timings are less precise. The
# difference is reported, never absorbed.
uv sync --project services/nlp --extra asr --extra align
```

**A GPU is strongly recommended and its absence is loud by default.** Transcription on CPU
is roughly twenty times slower and otherwise identical, which produces a job that looks
like it is working for forty minutes. `P80_ASR_REQUIRE_GPU=true` (the default) makes that a
refusal naming the reason; set it to `0` to run on CPU deliberately.

## The media library (ADR 0015)

`P80_MEDIA_ROOT` is the only directory P80 will read media from. It has **no default**,
deliberately: every other path can be wrong quietly and recover, but this one decides what
is reachable at all, and a default would silently make an empty directory your library.

```bash
# In .env.local
P80_MEDIA_ROOT=/path/to/your/videos
```

**After the first run you can change it without editing this file** — the Settings page in
the browser client, or `pnpm --filter @p80/tui dev settings set P80_MEDIA_ROOT <path>`. See
*Changing settings while P80 runs*, below. It still has to be set here once, because a
process that cannot start does not serve a settings page.

Videos are added by path relative to that root. P80 reads them where they are — it never
copies, modifies, or deletes them, and deleting a video inside P80 leaves your file alone.
A path that escapes the root is rejected rather than normalised.

Supported containers: `.mp4`, `.m4v`, `.mkv`, `.webm`, `.mov`. Playback is a `<video>`
element, so the browser also has to be able to decode the codec inside — a file that
transcribes correctly may still not play in every browser, and the transcript works either
way.

## Stage 4 and later — the expensive parts

Not yet needed. Recorded so the shape of the work is visible:

- spaCy `de_core_news_lg` (~500 MB) into the sidecar's environment
- Wiktextract dumps for **both** the English and German Wiktionary editions (ADR 0003)
- The OpenSubtitles-DE corpus, and a unigram + n-gram counting pass (ADR 0004)
- A dictionary index build into a local SQLite FTS store

## Changing settings while P80 runs (ADR 0019)

Most configuration is read once at startup, and changing it means editing `.env.local` and
restarting. Two groups are not: **the media library path and the transcription options**.
Both are read at the point of use, so they can be changed from either client and take effect
on the next request or the next job.

```bash
pnpm --filter @p80/tui dev settings                              # everything, both tiers
pnpm --filter @p80/tui dev settings set P80_ASR_REQUIRE_GPU false
pnpm --filter @p80/tui dev settings set P80_MEDIA_ROOT /mnt/videos
```

Or open <http://127.0.0.1:5173/settings>.

A value set this way is stored in P80's own database and **wins over `.env.local`**, which
both surfaces show: a setting that no longer matches your dotfile is marked as overridden,
with the dotfile's value beside it.

Everything else — ports, the bind host, the LAN flag, the database and storage paths, the
log level — is displayed read-only. Those are consumed at startup, so a change here would do
nothing, and P80 refuses the write rather than accepting one that has no effect. `P80_ALLOW_LAN`
is deliberately in that group for a second reason: exposing P80 to your network should be an
explicit act at the config file, not something a web page can do.

**Changing the media root does not move, copy, or delete anything.** Videos are stored as
paths relative to the root, so videos outside the new one stop playing until you change it
back — their transcripts, corrections, and review history are untouched either way. Both
surfaces count how many videos that affects and ask again before doing it.

## Running P80 in the background (ADR 0025)

`pnpm dev` is for developing P80. To *use* it — to have it survive a reboot and be there
when you open a browser — install it as containers supervised by a systemd **user** unit.
Nothing runs as root.

```bash
bash scripts/service-install.sh              # build the images, install the unit, start
bash scripts/service-install.sh --smoke      # ...and run the end-to-end check after
bash scripts/service-install.sh --no-build   # reinstall the unit against existing images
bash scripts/service-install.sh --uninstall  # stop, disable, and remove
```

You need a container runtime with Compose v2 or later, and nothing else: the images carry
Node, Python, the sidecar's speech-recognition dependencies, and `ffmpeg`. The installer
refuses rather than installing something that cannot start — it checks that `.env.local`
exists, that `P80_MEDIA_ROOT` names a real absolute directory, and that the daemon is
reachable.

One unit, one timer, and four containers inside them:

| | What |
|---|---|
| `p80.service` | Runs the whole stack. Attached, so container output goes to the journal |
| `p80-backup.timer` | A daily `VACUUM INTO` snapshot, with retention |
| `migrate` | Applies migrations once and exits; the other two wait for it to succeed |
| `api` | The API **and the built browser client**, on `P80_API_PORT` |
| `worker` | The job worker |
| `nlp` | The NLP sidecar |

```bash
systemctl --user status p80.service      # all of it at once
systemctl --user restart p80.service
journalctl --user -u p80 -f              # every container's logs, in one place
```

To drive compose directly — to read one container's logs, or to bring the stack up without
the unit — point it at P80's environment file. Compose defaults to `.env`, which P80 does
not use, and the media-root mount is written so that forgetting is an error rather than an
empty bind mount:

```bash
export COMPOSE_ENV_FILES=.env.local
docker compose ps
docker compose logs -f worker
```

**The containers share the host's network namespace.** Each process still binds
`127.0.0.1` itself, exactly as it does under `pnpm dev`, rather than binding `0.0.0.0`
inside a private network and relying on a published port to make loopback true.

**They also run as your own user.** That is what lets them read your media library and
write the database. On a machine where you are not uid 1000, set `P80_UID` and `P80_GID` in
`.env.local`; the installer says so if it applies to you.

**The media library is mounted at the path it already has** — the same absolute path inside
every container, because the worker resolves a media path and the sidecar opens it. One
consequence is worth knowing in advance: changing `P80_MEDIA_ROOT` from the settings page
takes effect for the running processes, but a directory that is not mounted is not there,
and P80 will tell you so. Point it somewhere new in `.env.local` and restart the unit.

**One difference from `pnpm dev`, and it changes the URL.** In development Vite serves the
client on `P80_WEB_PORT` and proxies the API. Installed, there is no Vite: the API serves
the built client itself, so everything is one origin and nothing listens on the web port.

| | Client | API |
|---|---|---|
| `pnpm dev` | `P80_WEB_PORT` | `P80_API_PORT` |
| Installed | `P80_API_PORT` | `P80_API_PORT` |

Both bind `127.0.0.1`. The two cannot run at once — they want the same API port — so stop
the unit before `pnpm dev`.

User services stop at logout unless lingering is enabled. The installer says so if it is
not; enabling it is the one step that needs root:

```bash
sudo loginctl enable-linger "$USER"
```

## Reaching P80 from another device (ADR 0023)

P80 binds `127.0.0.1` and accepts loopback browser origins only. To review on a tablet or a
second laptop, put a mesh VPN or reverse proxy in front of it — something that
authenticates the device, terminates TLS, and forwards to `127.0.0.1:5180`. P80 keeps
binding loopback; the proxy is what listens.

**P80 has no authentication of any kind.** Accounts are a non-goal, so whatever can reach
the API can read and change everything in it — and since ADR 0024 that includes **writing
files into your media library and deleting the ones P80 put there**. Bounded to a single
`uploads` folder, to the media formats P80 plays, and to a size cap, but a real capability
rather than a theoretical one. The proxy's access control is the entire security model.
Restrict it to your own devices, and do not put P80 on the public internet — not through a
public tunnel, not through a port forward on a router.

With [Tailscale](https://tailscale.com), which needs MagicDNS and HTTPS certificates enabled
on the tailnet:

```bash
tailscale serve --bg 5180        # → https://<host>.<tailnet>.ts.net:5180
```

Then name that origin in `.env.local` and restart, or the client will load and every write
will fail:

```bash
P80_TRUSTED_ORIGINS=https://<host>.<tailnet>.ts.net:5180
```

```bash
systemctl --user restart p80.service
```

**Why the second step is not optional.** Browsers attach an `Origin` header to any request
that is not `GET` or `HEAD`, even a same-origin one. Served under a name that is not
loopback, every rating, item, and settings change arrives with an origin the default
allowlist does not hold, and comes back `403 ORIGIN_NOT_ALLOWED` while reads keep working —
which looks like a broken application rather than a CORS rule. The key takes a
comma-separated list of bare origins (`scheme://host[:port]`, no path, no wildcard), is
refused at startup if malformed, and logs a warning while set.

If you would rather change nothing, forward the port instead of proxying it, so the browser
still sees a loopback origin:

```bash
ssh -L 5180:127.0.0.1:5180 <host>    # then open http://127.0.0.1:5180
```

That works untouched, and needs the tunnel up on every client device.

### Uploading media from the browser (ADR 0024)

Once P80 is reachable from a second device, the **Library** page will send a video file
from that device into `<P80_MEDIA_ROOT>/uploads/` and add it — which is the only way to get
a file into the library from a machine that is not the one P80 runs on, short of copying it
across yourself.

Files are sent in pieces of a few megabytes, so a dropped connection resumes from where it
stopped rather than starting over, and **no single request is large**. That matters if you
put something other than a mesh VPN in front of P80: `tailscale serve` passes bodies through
without a size limit, but nginx caps request bodies at one megabyte by default
(`client_max_body_size`), and a proxy that refuses a chunk will refuse every chunk. If
uploads fail immediately while the rest of P80 works, that limit is the first thing to
check.

`uploads` is the only directory P80 writes media into, and the only one it will delete
from. Anything you copy in yourself is listed and playable, and P80 will not remove it.

## Updating an installed P80 (ADR 0022)

```bash
bash scripts/deploy.sh
```

Fetches, fast-forwards, installs the dependencies the gates need, runs the typecheck and
the suite, builds both images and tags them with the commit, snapshots the database, moves
the `dev` tag the compose file resolves, restarts the unit, and verifies the result with
`scripts/smoke.sh`.

If the restart or the verification fails, it puts the previous commit back and points the
`dev` tag at **the images built from it**, which still exist. That is the practical gain
from ADR 0025: a rollback is a retag and a restart, rather than a rebuild that has to
succeed while something is already going wrong. Only when there is no image for the previous
commit — the first deploy after the migration, or after pruning — does it fall back to
rebuilding.

**It never restores the database, and says so.** The snapshot it takes before restarting is
tagged, so retention keeps it indefinitely, and the script prints its path with the restore
command for you to decide about. Restoring would discard every review completed since the
snapshot was taken, which is not a script's call to make.

```bash
bash scripts/deploy.sh --dry-run     # preflight, then print what would happen
bash scripts/deploy.sh --no-pull     # deploy the working tree as it stands
bash scripts/deploy.sh --ref v0.3    # deploy a specific ref
bash scripts/deploy.sh --skip-tests  # hotfix path; nothing checks the build
```

It refuses to start against a dirty working tree, a non-fast-forward, or a port already held
by something that is not the `p80` unit — usually `pnpm dev`, which cannot run at the same
time.

By hand, the same thing is `docker compose build` followed by
`systemctl --user restart p80.service`: the containers keep serving the image they started
with. The script exists because that pair leaves out the snapshot, the gates, the commit
tag that makes a rollback cheap, and the way back.

Every push is separately checked by `.github/workflows/ci.yml`, which runs the same
typecheck, suite, and build on a clean machine. The two are not redundant — a hosted runner
has no media root, no local models, and a different architecture — and ADR 0022 explains why
deploying is a command you run rather than something that listens for a push.

## Configuration

`.env.local` is read from the repository root when a process starts, and **anything already
set in the environment wins over it** — so `P80_API_PORT=5280 pnpm dev` means what it looks
like it means. The web client is the exception in mechanism only: Vite loads the same file
itself.

`.env.local` holds **local endpoint configuration only**. There are no API keys in P80
(ADR 0005) — nothing here is a secret. The set of variables the application reads is
closed and asserted by a test; see `.env.example` for the list.

Every service binds `127.0.0.1`. `P80_ALLOW_LAN=true` opts into LAN exposure and logs a
warning at startup (spec §32.5).
