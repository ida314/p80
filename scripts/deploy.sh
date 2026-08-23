#!/usr/bin/env bash
#
# Gets a change into the P80 that is actually running, or puts the previous one back.
#
#   bash scripts/deploy.sh                  fetch, gate, build, snapshot, restart, verify
#   bash scripts/deploy.sh --no-pull        deploy the working tree as it stands
#   bash scripts/deploy.sh --ref <sha|tag>  deploy a specific ref
#   bash scripts/deploy.sh --skip-tests     skip typecheck and the suite (hotfix only)
#   bash scripts/deploy.sh --no-smoke       skip scripts/smoke.sh at the end
#   bash scripts/deploy.sh --dry-run        preflight, then print what would happen
#
# The code rolls back automatically. The database never does — see the note above
# `rollback`, and ADR 0022 for why the deploy is a pull rather than something that listens.
#
# Since ADR 0025 the deployed artifact is a pair of images rather than a checkout that the
# services are read out of. That is what makes the rollback below cheap: the previous
# version is a tag that still exists, not a rebuild that has to succeed while something is
# already going wrong.
#
# Installing the unit in the first place is scripts/service-install.sh. This script assumes
# it exists and deliberately does not touch it: it names an absolute `docker` path, and
# changing that is what the installer is for.

set -uo pipefail

# Everything lives inside main() so that bash has parsed the whole program before `git
# merge` can rewrite this file underneath it. Bash reads a script incrementally, by byte
# offset; a self-updating script that runs top-level statements will eventually resume in
# the middle of a different line than it started. A function definition is one command, so
# by the time `main` runs, nothing further is read from disk.
main() {

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO}" || exit 1

do_pull=1
do_tests=1
do_smoke=1
dry_run=0
target_ref=""

while (( $# )); do
  case "$1" in
    --no-pull)    do_pull=0 ;;
    --skip-tests) do_tests=0 ;;
    --no-smoke)   do_smoke=0 ;;
    --dry-run)    dry_run=1 ;;
    --ref)        target_ref="${2-}"; [[ -n "${target_ref}" ]] || { echo "--ref needs a value" >&2; exit 2; }; shift ;;
    -h|--help)    sed -n '3,11p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }

# How far we got. Rollback only has work to do from `build` onward, because that is the
# first step whose effect the running system can see: the API serves apps/web/dist off the
# disk, per request.
STAGE=preflight
PREV_SHA=""
# The commit the *running images* were built from, which is a different question from what
# is checked out. They coincide when a deploy is a pull; under `--no-pull` they do not, and
# rolling the images back to the checkout's own HEAD restores the broken build.
DEPLOYED_SHA=""
SNAPSHOT=""

# --- rollback ----------------------------------------------------------------------
#
# Code goes back; the database does not, and that asymmetry is deliberate.
#
# Restoring the snapshot would silently discard every review completed since it was taken,
# and a script is the wrong thing to be making that call. Migrations here are forward-only
# and additive, so the previous code against the newer schema is usually fine — and where
# it is not, the person deploying needs to know that before losing review history, not
# after. So the path is printed, with the command, and left for them.
rollback() {
  [[ -n "${PREV_SHA}" ]] || return 0
  [[ "$(git rev-parse HEAD)" == "${PREV_SHA}" ]] && [[ "${STAGE}" != build ]] \
    && [[ "${STAGE}" != restart ]] && [[ "${STAGE}" != verify ]] && return 0

  # Two things are being put back and they are not always the same commit: the checkout
  # returns to where this run found it, and the images return to what was serving. Naming
  # only one of them is how the last rehearsal read as a success while P80 stayed down.
  if [[ -n "${DEPLOYED_SHA}" ]] && [[ "${DEPLOYED_SHA}" != "${PREV_SHA:0:12}" ]]; then
    say "Rolling back — checkout to ${PREV_SHA:0:12}, images to ${DEPLOYED_SHA}"
  else
    say "Rolling back to ${PREV_SHA:0:12}"
  fi
  # Back onto the branch first when there was one. `--ref` detaches HEAD, and a rollback
  # that restores the right commit while leaving HEAD detached has put the repository in a
  # state the next deploy refuses to run from.
  if [[ "${BRANCH}" != HEAD ]] && [[ "$(git rev-parse --abbrev-ref HEAD)" != "${BRANCH}" ]]; then
    git checkout --force "${BRANCH}" >/dev/null 2>&1 || note "WARNING: could not return to ${BRANCH}."
  fi
  git reset --hard "${PREV_SHA}" >/dev/null 2>&1 || note "WARNING: could not reset the tree."
  # The host's node_modules is not what runs — it is what the gates run against. Restoring
  # it keeps the next attempt honest rather than un-deploying anything.
  pnpm install --frozen-lockfile >/dev/null 2>&1 || note "WARNING: pnpm install failed during rollback."

  # Only put images back and restart if the running system had been changed. Failing at the
  # gates means nothing was deployed, so there is nothing to undo but the checkout.
  case "${STAGE}" in
    restart|verify)
      # The images go back to what was *running*, not to what was checked out. Those are the
      # same commit when the deploy was a pull, and they are not under `--no-pull` — where
      # the checkout is already the broken build, so restoring it would restore the failure
      # and report success while P80 stayed down.
      local restore="${DEPLOYED_SHA:-${PREV_SHA:0:12}}"
      if [[ -n "${NEW_SHA:-}" ]] && [[ "${restore}" == "${NEW_SHA:0:12}" ]]; then
        # Nothing to go back to: this deploy replaced a build of the same commit. Said
        # plainly rather than performed as a no-op that looks like a recovery.
        note "the previous images were built from this same commit — no earlier version to"
        note "restore. The checkout is back; the running code is not."
      elif point_images_at "${restore}"; then
        ok "images restored to ${restore}"
      else
        # No image for that commit — this was the first deploy after the migration, or the
        # tags have been pruned. Rebuilding is slower and can itself fail, which is exactly
        # why it is the fallback and not the mechanism.
        note "no image tagged ${restore}; rebuilding from the restored checkout"
        compose build >/dev/null 2>&1 || note "WARNING: rebuild failed during rollback."
        tag_images "${restore}" >/dev/null 2>&1 || true
        point_images_at "${restore}" >/dev/null 2>&1 || true
      fi
      systemctl --user restart p80.service || note "WARNING: could not restart p80.service."
      if wait_for_health; then
        ok "previous version is back and healthy"
        # The tree and the running code can now disagree, and silently disagreeing about
        # which commit is serving is how the next deploy surprises someone.
        if [[ "$(git rev-parse --short=12 HEAD)" != "${restore}" ]]; then
          note "NOTE: the checkout is at $(git rev-parse --short=12 HEAD); ${restore} is what is running."
        fi
      else
        note "WARNING: the previous version is not answering either. Check:"
        note "         journalctl --user -u p80 -n 50"
      fi
      ;;
    *)
      ok "working tree restored; the running system was never changed"
      ;;
  esac

  if [[ -n "${SNAPSHOT}" ]]; then
    printf '\n'
    note "The database was NOT rolled back. If a migration ran and you need it undone:"
    note "    systemctl --user stop p80.service"
    note "    cp ${SNAPSHOT} ${DB_PATH}"
    note "    systemctl --user start p80.service"
    note "That snapshot is tagged, so retention will never prune it."
  fi
}

fail() { rollback; die "$*"; }

# --- images ------------------------------------------------------------------------
#
# Two images, tagged twice. `:<sha>` is the durable name — it is what a rollback reaches
# for — and `:dev` is the moving pointer the compose file resolves by default, so that the
# installed unit needs no argument and cannot drift from what was deployed.
IMAGES=(p80-node p80-nlp)

compose() {
  COMPOSE_ENV_FILES="${REPO}/.env.local" docker compose -f "${REPO}/docker-compose.yml" "$@"
}

tag_images() {
  local sha="$1" image
  for image in "${IMAGES[@]}"; do
    docker tag "${image}:dev" "${image}:${sha}" || return 1
  done
}

# Moves `:dev` onto an existing per-commit tag. Fails without side effects when any of the
# images is missing, so the caller can fall back rather than half-apply a rollback.
point_images_at() {
  local sha="$1" image
  for image in "${IMAGES[@]}"; do
    docker image inspect "${image}:${sha}" >/dev/null 2>&1 || return 1
  done
  for image in "${IMAGES[@]}"; do
    docker tag "${image}:${sha}" "${image}:dev" || return 1
  done
}

# What is running right now, read from the images rather than remembered.
#
# Every deploy tags the image it built with its commit and then moves `:dev` onto it, so
# `:dev` carries both names and the second one is the answer. No new state to keep in sync,
# and nothing to go stale if a deploy is interrupted between the two.
#
# Empty when the images were built by `service-install.sh`, which tags only `:dev`. That is
# the first-deploy case, and the caller falls back to the checkout as before.
deployed_sha() {
  docker image inspect --format '{{join .RepoTags "\n"}}' "${IMAGES[0]}:dev" 2>/dev/null \
    | sed -n "s|^${IMAGES[0]}:||p" | grep -vx dev | head -1
}

step() {
  local label="$1"; shift
  if ! "$@"; then fail "${label} failed."; fi
  ok "${label}"
}

# --- preflight ---------------------------------------------------------------------

say "Checking prerequisites"

[[ -d /run/systemd/system ]] || die "systemd is not the init system here."
# node and pnpm are here for the gates, which run on the host against this machine's real
# config and its own better-sqlite3 binding. Nothing that gets deployed needs them.
for tool in git node pnpm curl systemctl docker; do
  command -v "$tool" >/dev/null || die "${tool} is not on PATH."
done
docker compose version >/dev/null 2>&1 \
  || die "\`docker compose\` is unavailable. This needs Compose v2 or later, as a plugin."
docker info >/dev/null 2>&1 || die "the container daemon is not reachable"

# One deploy at a time. Two racing each other would interleave a checkout with a build.
if command -v flock >/dev/null; then
  exec 9>"${REPO}/.deploy.lock"
  flock -n 9 || die "another deploy is already running (${REPO}/.deploy.lock)."
else
  note "WARNING: no flock, so concurrent deploys are not prevented."
fi

systemctl --user list-unit-files p80.service >/dev/null 2>&1 \
  || die "P80 is not installed as a service here. Install it first:
      bash scripts/service-install.sh"

[[ -f "${REPO}/.env.local" ]] || die "no .env.local at ${REPO}.
  Compose resolves the media-root mount from it and refuses to start without one, so a
  deploy would restart into a stopped service."

# Read the file the way loadConfig() does — process environment wins, quotes stripped,
# nothing interpolated. This is a config file, not a shell script, so it is never sourced.
# Same function as scripts/service-install.sh, for the same reason.
env_value() {
  local key="$1" value
  if [[ -n "${!key-}" ]]; then printf '%s' "${!key}"; return; fi
  value="$(grep -E "^[[:space:]]*${key}=" "${REPO}/.env.local" | tail -n 1 || true)"
  value="${value#*=}"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  value="${value%\"}"; value="${value#\"}"
  value="${value%\'}"; value="${value#\'}"
  printf '%s' "$value"
}

API_PORT="$(env_value P80_API_PORT)"; API_PORT="${API_PORT:-5180}"
HEALTH="http://127.0.0.1:${API_PORT}/api/health"

DB_PATH="$(env_value P80_DB_PATH)"; DB_PATH="${DB_PATH:-./data/p80.db}"
[[ "${DB_PATH}" == /* ]] || DB_PATH="${REPO}/${DB_PATH#./}"

wait_for_health() {
  local i
  for i in $(seq 1 30); do
    curl -sf "${HEALTH}" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# `pnpm dev` and the installed services want the same port and cannot both have it. If
# something is answering while the unit is not the thing running, a restart will land in a
# bind-failure loop that reads as a broken API rather than as two copies of P80.
if [[ "$(systemctl --user is-active p80.service 2>/dev/null)" != "active" ]] \
   && curl -sf "${HEALTH}" >/dev/null 2>&1; then
  die "something is already serving port ${API_PORT}, and it is not the p80 unit.
  If that is \`pnpm dev\`, stop it: the two cannot run at once."
fi

PREV_SHA="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
DEPLOYED_SHA="$(deployed_sha)"
note "repo        ${REPO}"
note "at          ${PREV_SHA:0:12} on ${BRANCH}"
if [[ -n "${DEPLOYED_SHA}" ]] && [[ "${DEPLOYED_SHA}" != "${PREV_SHA:0:12}" ]]; then
  # Worth saying out loud: it means the checkout has moved since the last deploy, or that
  # this is a `--no-pull` run of a tree that is ahead of what is serving.
  note "running     ${DEPLOYED_SHA}  (not the checkout)"
elif [[ -z "${DEPLOYED_SHA}" ]]; then
  note "running     unknown — the images carry no commit tag, so a rollback would rebuild"
fi
note "api         ${HEALTH}"
note "database    ${DB_PATH}"

if [[ -z "${target_ref}" ]] && [[ -n "$(git status --porcelain)" ]]; then
  die "the working tree is dirty. Commit or stash first — a rollback cannot tell your
  changes from the ones it is undoing."
fi

# The sidecar is a compose service now, so a deploy no longer has an environment of its own
# to keep in step — which is the defect ADR 0025 exists to remove. What is still worth
# saying is when the stack builds one nothing will talk to.
NLP_URL="$(env_value P80_NLP_BASE_URL)"; NLP_URL="${NLP_URL:-http://127.0.0.1:5181}"
NLP_HOST="${NLP_URL#*://}"; NLP_HOST="${NLP_HOST%%/*}"; NLP_HOST="${NLP_HOST%%:*}"
case "${NLP_HOST}" in
  127.0.0.1|localhost|::1|'[::1]') note "sidecar     local, on ${NLP_URL}" ;;
  *) note "sidecar     REMOTE, at ${NLP_URL} — the compose stack still starts a local one,"
     note "            which nothing will use. Remove it from docker-compose.yml, or point"
     note "            P80_NLP_BASE_URL back at loopback." ;;
esac

if (( dry_run )); then
  say "Dry run — nothing below has happened"
  if [[ -n "${target_ref}" ]]; then note "checkout ${target_ref}"
  elif (( do_pull )); then          note "git fetch origin && git merge --ff-only origin/${BRANCH}"
  else                              note "(no pull — deploy the tree at ${PREV_SHA:0:12})"; fi
  note "pnpm install --frozen-lockfile        # for the gates, not for the deploy"
  if (( do_tests )); then note "pnpm -r typecheck && pnpm test"; else note "(gates skipped)"; fi
  note "docker compose build                  # then tag both images with the commit"
  note "pnpm db:backup --reason predeploy"
  note "docker tag <image>:<sha> <image>:dev"
  note "systemctl --user restart p80.service  # compose up; the migrate service runs first"
  note "poll ${HEALTH}"
  (( do_smoke )) && note "bash scripts/smoke.sh"
  printf '\n'
  exit 0
fi

# --- update ------------------------------------------------------------------------

STAGE=update

if [[ -n "${target_ref}" ]]; then
  say "Checking out ${target_ref}"
  step "fetch" git fetch origin --tags
  step "checkout ${target_ref}" git checkout --detach "${target_ref}"
elif (( do_pull )); then
  say "Updating from origin"
  [[ "${BRANCH}" != HEAD ]] || die "HEAD is detached, so there is no branch to pull.
  Check out a branch, or use --no-pull, or name a ref with --ref."
  step "fetch" git fetch origin
  if ! git rev-parse --verify --quiet "origin/${BRANCH}" >/dev/null; then
    # A local-only branch is a normal thing to deploy — it is how a change gets tried here
    # before it goes anywhere. Not an error, but say so, because "pulled" and "there was
    # nothing to pull from" should not look the same.
    note "no origin/${BRANCH} — deploying the local branch as it stands"
  # --ff-only on purpose: a merge commit invented by a deploy script is a surprise, and a
  # conflict resolved unattended is worse.
  elif ! git merge --ff-only "origin/${BRANCH}"; then
    fail "cannot fast-forward to origin/${BRANCH}. Reconcile the branch by hand first."
  else
    ok "merged origin/${BRANCH}"
  fi
else
  say "Deploying the working tree (--no-pull)"
fi

NEW_SHA="$(git rev-parse HEAD)"
if [[ "${NEW_SHA}" == "${PREV_SHA}" ]]; then
  note "already at ${NEW_SHA:0:12} — nothing new, continuing anyway to rebuild and verify"
else
  note "${PREV_SHA:0:12} → ${NEW_SHA:0:12}"
  git --no-pager log --oneline "${PREV_SHA}..${NEW_SHA}" 2>/dev/null | sed 's/^/    /' || true
fi

# --- dependencies ------------------------------------------------------------------

STAGE=deps
say "Installing dependencies for the gates"
# Only for the gates. Nothing deployed reads this directory — the services run out of the
# image, which builds its own. There is deliberately no `uv sync` here any more: the
# sidecar's environment is a build instruction now, so a deploy has no way to prune it.
step "pnpm install" pnpm install --frozen-lockfile

# --- gates -------------------------------------------------------------------------
#
# Not redundant with GitHub Actions. CI runs on a clean x86_64 machine with a synthesized
# config; this runs on the machine P80 is installed on, against its real .env.local, its
# real media root, and a better-sqlite3 binding built for this architecture. CI catches what
# is portable, this catches what is local, and neither is a superset of the other.

STAGE=gates
if (( do_tests )); then
  say "Running the gates"
  step "typecheck" pnpm -r typecheck
  step "tests" pnpm test
else
  say "Gates skipped (--skip-tests)"
  note "Nothing has checked this build. That is a deliberate hotfix path, not a shortcut."
fi

# --- build -------------------------------------------------------------------------

STAGE=images
say "Building images"
# The browser client is built inside the node image, so there is no `pnpm build` here.
# Building changes nothing that is running — the containers keep serving the old image
# until `:dev` moves, below — which is why a failure at this stage needs no rollback.
step "docker compose build" compose build
step "tag ${NEW_SHA:0:12}" tag_images "${NEW_SHA:0:12}"

# --- snapshot ----------------------------------------------------------------------

STAGE=restart
say "Snapshotting the database"
# Before the restart, because the restart runs the migrate container and a migration is the
# one step here that cannot be undone. `--reason` tags it, and tagged snapshots are never
# pruned by retention.
SNAPSHOT="$(pnpm --silent db:backup --reason predeploy | tail -n 1)"
if [[ -z "${SNAPSHOT}" ]] || [[ ! -f "${SNAPSHOT}" ]]; then
  SNAPSHOT=""
  fail "the pre-deploy backup did not produce a file."
fi
ok "${SNAPSHOT}"

# --- restart -----------------------------------------------------------------------

say "Restarting P80"
# Moving `:dev` is the deploy. Everything before this point was preparation that the running
# system could not see, and this is the first line whose effect it can.
step "point :dev at ${NEW_SHA:0:12}" point_images_at "${NEW_SHA:0:12}"
# Restart, not start: it is the restart that re-runs the one-shot migrate service that the
# API and worker order themselves after.
step "systemctl restart p80.service" systemctl --user restart p80.service

STAGE=verify
if wait_for_health; then
  ok "healthy at ${HEALTH}"
else
  fail "the API did not become healthy within 30s.
  journalctl --user -u p80 -n 50"
fi

# A container that started and then died leaves health passing for a moment and the system
# broken. Ask the daemon directly rather than trusting the poll alone. The migrate service
# is deliberately not in this list: it is a one-shot and being exited is its success.
state="$(systemctl --user is-active p80.service 2>/dev/null)"
[[ "${state}" == active ]] || fail "p80.service is ${state}. journalctl --user -u p80 -n 50"
ok "p80.service"

running="$(compose ps --services --status running 2>/dev/null || true)"
for service in api worker nlp; do
  if grep -qx "${service}" <<<"${running}"; then
    ok "${service}"
  else
    fail "the ${service} container is not running. docker compose logs ${service}"
  fi
done

# --- smoke -------------------------------------------------------------------------

if (( do_smoke )); then
  say "Smoke check"
  if ! bash "${REPO}/scripts/smoke.sh"; then
    fail "the smoke suite failed against the deployed system."
  fi
fi

# --- done --------------------------------------------------------------------------

say "Deployed"
note "at        $(git rev-parse HEAD | cut -c1-12)"
note "snapshot  ${SNAPSHOT}"
note "open      http://127.0.0.1:${API_PORT}"
note "image     $(git rev-parse HEAD | cut -c1-12)"
note "logs      journalctl --user -u p80 -f"

}

main "$@"
