#!/usr/bin/env bash
#
# Installs P80 as a systemd **user** service that runs the container stack, so it survives
# a logout and comes back after a reboot without anything running as root.
#
#   bash scripts/service-install.sh                 install (or reinstall) and start
#   bash scripts/service-install.sh --uninstall     stop, disable, and remove
#   bash scripts/service-install.sh --no-build      skip building the images
#   bash scripts/service-install.sh --smoke         run scripts/smoke.sh at the end
#
# Why containers is ADR 0025, and why a unit around them rather than restart policies is
# ADR 0025 §3: restart policies start containers when the daemon starts, but they do not
# start under this user's account at boot, give no single name to stop, and have no timer.
#
# Everything this writes comes from deploy/systemd/*.in with two tokens substituted. The
# templates are the reviewable artifact; the installed copies are generated and say so.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
TEMPLATE_DIR="${REPO}/deploy/systemd"
COMPOSE_FILE="${REPO}/docker-compose.yml"

ALL_UNITS=(
  p80.service
  p80-backup.service
  p80-backup.timer
)

do_build=1
do_smoke=0
do_uninstall=0
for arg in "$@"; do
  case "$arg" in
    --uninstall) do_uninstall=1 ;;
    --no-build)  do_build=0 ;;
    --smoke)     do_smoke=1 ;;
    -h|--help)   sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: ${arg}" >&2; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\n\033[31merror\033[0m %s\n' "$*" >&2; exit 1; }

# --- uninstall ---------------------------------------------------------------------

if (( do_uninstall )); then
  say "Removing P80 services"
  systemctl --user stop p80.service p80-backup.timer 2>/dev/null || true
  systemctl --user disable "${ALL_UNITS[@]}" 2>/dev/null || true
  # A glob rather than the list, so units from an earlier layout go too — including the
  # four this replaced, and the p80.target that used to group them.
  for path in "${UNIT_DIR}"/p80*.service "${UNIT_DIR}"/p80*.timer "${UNIT_DIR}"/p80*.target; do
    [[ -e "${path}" ]] || continue
    systemctl --user disable --now "$(basename "${path}")" 2>/dev/null || true
    rm -f "${path}"
  done
  rm -rf "${UNIT_DIR}/p80.target.wants"
  systemctl --user daemon-reload
  systemctl --user reset-failed 2>/dev/null || true
  # Containers, but not the images and not the bind-mounted directories. `down` removes
  # what this script created and nothing that holds data.
  if command -v docker >/dev/null && [[ -f "${COMPOSE_FILE}" ]]; then
    COMPOSE_ENV_FILES="${REPO}/.env.local" docker compose -f "${COMPOSE_FILE}" down 2>/dev/null || true
  fi
  note "removed. Your database, transcripts, and media are untouched."
  exit 0
fi

# --- preflight ---------------------------------------------------------------------
#
# Every check below refuses by name. A unit that installs cleanly and then fails to start
# is the failure mode this whole script exists to prevent.

say "Checking prerequisites"

[[ -d /run/systemd/system ]] || die "systemd is not the init system here."

if [[ ! -f "${REPO}/.env.local" ]]; then
  die "no .env.local at ${REPO}.
  Compose resolves the media-root mount from it and refuses to start without one, because
  P80_MEDIA_ROOT has no default and a wrong guess would be a silent one.
      cp .env.example .env.local   # then set P80_MEDIA_ROOT to your media directory"
fi

# Read the file the way loadConfig() does — process environment wins, quotes stripped,
# nothing interpolated. This is a config file, not a shell script, so it is never sourced.
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

MEDIA_ROOT="$(env_value P80_MEDIA_ROOT)"
[[ -n "${MEDIA_ROOT}" ]] || die "P80_MEDIA_ROOT is not set in .env.local. It has no default."
# Absolute, and checked here rather than left to compose. The bind mount puts this path at
# the same path inside every container, so that the worker and the sidecar agree about what
# an absolute media path means (ADR 0025). A relative one has no such answer.
[[ "${MEDIA_ROOT}" == /* ]] \
  || die "P80_MEDIA_ROOT must be an absolute path. It is mounted into the containers at the
  path it has here, and a relative one would mean something different in each of them."
[[ -d "${MEDIA_ROOT}" ]] || die "P80_MEDIA_ROOT points at ${MEDIA_ROOT}, which is not a directory."
note "media root  ${MEDIA_ROOT}"

API_PORT="$(env_value P80_API_PORT)"
API_PORT="${API_PORT:-5180}"

command -v docker >/dev/null || die "docker is not on PATH."
docker compose version >/dev/null 2>&1 \
  || die "\`docker compose\` is unavailable. This needs Compose v2 or later, as a plugin."
docker info >/dev/null 2>&1 \
  || die "the container daemon is not reachable. Start it, or add this user to its group."
DOCKER_BIN="$(command -v docker)"
note "docker      ${DOCKER_BIN} ($(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?'))"
note "compose     $(docker compose version --short 2>/dev/null || echo '?')"

# The containers run as this user so they can read the media library and write the
# database. Compose defaults these to 1000, which is right on a single-user machine and
# wrong on one where somebody else owns the media root.
if [[ "$(id -u)" != "1000" || "$(id -g)" != "1000" ]]; then
  if [[ -z "$(env_value P80_UID)" || -z "$(env_value P80_GID)" ]]; then
    note "NOTE: you are $(id -u):$(id -g), and compose defaults the containers to 1000:1000."
    note "      Set P80_UID and P80_GID in .env.local, or the containers will not be able"
    note "      to read your media or write the database."
  fi
fi

# Nothing here needs node, pnpm, uv, or ffmpeg. That is the point of ADR 0025: the host
# needs a container runtime and an environment file, and the rest is in the images.

# --- build -------------------------------------------------------------------------

if (( do_build )); then
  say "Building images"
  # The browser client is built inside the node image, so there is no `pnpm build` here and
  # no apps/web/dist on the host for the API to disagree with.
  COMPOSE_ENV_FILES="${REPO}/.env.local" docker compose -f "${COMPOSE_FILE}" build
fi

for image in p80-node p80-nlp; do
  docker image inspect "${image}:${P80_IMAGE_TAG:-dev}" >/dev/null 2>&1 \
    || die "no ${image}:${P80_IMAGE_TAG:-dev} image. Run without --no-build."
done

# --- units -------------------------------------------------------------------------

say "Writing unit files to ${UNIT_DIR}"
mkdir -p "${UNIT_DIR}"

# Any p80 unit that is installed but no longer in ALL_UNITS is left over from an earlier
# layout and has to go. Leaving one behind is not harmless: it stays enabled, systemd still
# tries to start it at boot, and it fails against a service that no longer exists. The four
# process units and the target that grouped them are the concrete case — ADR 0025 replaced
# all five with one unit that runs the compose stack.
for path in "${UNIT_DIR}"/p80*.service "${UNIT_DIR}"/p80*.timer "${UNIT_DIR}"/p80*.target; do
  [[ -e "${path}" ]] || continue
  unit="$(basename "${path}")"
  for known in "${ALL_UNITS[@]}"; do
    [[ "${unit}" == "${known}" ]] && continue 2
  done
  systemctl --user disable --now "${unit}" 2>/dev/null || true
  rm -f "${path}"
  note "${unit} (removed — no longer part of P80)"
done
rm -rf "${UNIT_DIR}/p80.target.wants"

# `&` and `\` mean something to sed on the right-hand side of a substitution, and `|` is
# the delimiter. A checkout under a directory containing any of them would otherwise
# produce a unit file that is quietly wrong rather than one that fails.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

install_unit() {
  local name="$1"
  sed -e "s|@REPO@|$(sed_escape "${REPO}")|g" \
      -e "s|@DOCKER@|$(sed_escape "${DOCKER_BIN}")|g" \
      "${TEMPLATE_DIR}/${name}.in" > "${UNIT_DIR}/${name}"
  note "${name}"
}

INSTALLED=()
for unit in "${ALL_UNITS[@]}"; do
  install_unit "${unit}"
  # p80-backup.service has no [Install] section on purpose — the timer is what pulls it in,
  # and `enable` on a unit with nothing to install is an error rather than a no-op.
  [[ "${unit}" == p80-backup.service ]] || INSTALLED+=("${unit}")
done

say "Enabling and starting"
systemctl --user daemon-reload
systemctl --user enable "${INSTALLED[@]}" >/dev/null
# Restart rather than start: a reinstall over a running P80 should pick up the new units.
systemctl --user restart p80.service
systemctl --user start p80-backup.timer

# Without lingering, user units stop at logout and never start at boot. The one thing here
# that cannot be done from inside the user session.
#
# `id -un` rather than $USER: this may run from cron, a provisioning tool, or any other
# context that does not set it, and `set -u` would make that a crash rather than a note.
WHO="$(id -un)"
if ! loginctl show-user "${WHO}" --property=Linger 2>/dev/null | grep -q 'Linger=yes'; then
  note "NOTE: lingering is off, so P80 will stop when you log out. To fix:"
  note "      sudo loginctl enable-linger ${WHO}"
fi

say "Status"
systemctl --user --no-pager --plain list-units 'p80*' || true

printf '\n'
note "logs      journalctl --user -u p80 -f"
note "restart   systemctl --user restart p80.service"
note "remove    bash scripts/service-install.sh --uninstall"
note "open      http://127.0.0.1:${API_PORT}"

if (( do_smoke )); then
  command -v curl >/dev/null || die "--smoke needs curl, which is not on PATH."
  say "Smoke check"
  # Give the API a moment to bind before curling it.
  for _ in $(seq 1 30); do
    curl -sf "http://127.0.0.1:${API_PORT}/api/health" >/dev/null && break
    sleep 1
  done
  bash "${REPO}/scripts/smoke.sh"
fi
