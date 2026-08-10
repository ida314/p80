#!/usr/bin/env bash
#
# Installs P80 as systemd **user** services, so it survives a logout and comes back after a
# reboot without anything running as root.
#
#   bash scripts/service-install.sh                 install (or reinstall) and start
#   bash scripts/service-install.sh --uninstall     stop, disable, and remove
#   bash scripts/service-install.sh --no-build      skip pnpm install + pnpm build
#   bash scripts/service-install.sh --smoke         run scripts/smoke.sh at the end
#
# Why user units rather than containers is ADR 0021. The short version: P80 reads the
# user's own media where it lies, and the sidecar opens those paths on its own filesystem,
# so identical absolute paths matter more here than isolation does.
#
# Everything this writes comes from deploy/systemd/*.in with three tokens substituted. The
# templates are the reviewable artifact; the installed copies are generated and say so.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
TEMPLATE_DIR="${REPO}/deploy/systemd"

ALL_UNITS=(
  p80.target
  p80-migrate.service
  p80-api.service
  p80-worker.service
  p80-nlp.service
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
  systemctl --user stop p80.target p80-backup.timer 2>/dev/null || true
  # `disable` on the target does not disable its members: each was enabled on its own and
  # owns its own symlink.
  systemctl --user disable "${ALL_UNITS[@]}" 2>/dev/null || true
  rm -f "${UNIT_DIR}/p80.target"
  # A glob rather than the list, so units from an earlier layout go too.
  for path in "${UNIT_DIR}"/p80-*.service "${UNIT_DIR}"/p80-*.timer; do
    [[ -e "${path}" ]] || continue
    systemctl --user disable --now "$(basename "${path}")" 2>/dev/null || true
    rm -f "${path}"
  done
  rm -rf "${UNIT_DIR}/p80.target.wants"
  systemctl --user daemon-reload
  systemctl --user reset-failed 2>/dev/null || true
  note "removed. Your database, transcripts, and media are untouched."
  exit 0
fi

# --- preflight ---------------------------------------------------------------------
#
# Every check below refuses by name. A unit that installs cleanly and then fails to start
# is the failure mode this whole script exists to prevent: it was the state of this
# machine before ADR 0021, where the units referenced an .env.local that no longer existed
# and a `start` script that was never written.

say "Checking prerequisites"

[[ -d /run/systemd/system ]] || die "systemd is not the init system here."

if [[ ! -f "${REPO}/.env.local" ]]; then
  die "no .env.local at ${REPO}.
  The units load it with no fallback, because P80_MEDIA_ROOT has no default and a
  process that cannot start does not serve a settings page.
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
[[ "${MEDIA_ROOT}" == /* ]] || MEDIA_ROOT="${REPO}/${MEDIA_ROOT}"
[[ -d "${MEDIA_ROOT}" ]] || die "P80_MEDIA_ROOT points at ${MEDIA_ROOT}, which is not a directory."
note "media root  ${MEDIA_ROOT}"

API_PORT="$(env_value P80_API_PORT)"
API_PORT="${API_PORT:-5180}"

for tool in node pnpm; do
  command -v "$tool" >/dev/null || die "${tool} is not on PATH."
done
NODE_BIN="$(command -v node)"
note "node        ${NODE_BIN} ($(node -v))"

command -v ffmpeg >/dev/null \
  || note "WARNING: no ffmpeg. Transcription and duration detection will not work; see docs/SETUP.md."

# Where the sidecar lives decides whether one is installed here. Same rule and the same
# loopback list as scripts/dev.mjs, which has skipped starting a local sidecar since the
# endpoints became configurable.
NLP_URL="$(env_value P80_NLP_BASE_URL)"
NLP_URL="${NLP_URL:-http://127.0.0.1:5181}"
NLP_HOST="${NLP_URL#*://}"; NLP_HOST="${NLP_HOST%%/*}"; NLP_HOST="${NLP_HOST%%:*}"
NLP_IS_LOCAL=0
case "${NLP_HOST}" in
  127.0.0.1|localhost|::1|'[::1]') NLP_IS_LOCAL=1 ;;
esac

if (( NLP_IS_LOCAL )); then
  command -v uv >/dev/null || die "uv is not on PATH, and the NLP sidecar runs here."
  # uv's default is a `.venv` inside the project, but UV_PROJECT_ENVIRONMENT relocates it
  # and is resolved relative to the project directory. Honouring it here means the unit
  # names wherever the environment actually is rather than where it usually is.
  NLP_VENV="${UV_PROJECT_ENVIRONMENT:-.venv}"
  [[ "${NLP_VENV}" == /* ]] || NLP_VENV="${REPO}/services/nlp/${NLP_VENV}"
  NLP_BIN="${NLP_VENV}/bin/p80-nlp"
  [[ -x "${NLP_BIN}" ]] || die "no sidecar environment at ${NLP_VENV}. Create it first:
      uv sync --project services/nlp --extra asr"
  note "sidecar     local, on ${NLP_URL}"
else
  note "sidecar     REMOTE, at ${NLP_URL} — no local unit will be installed."
  note "            It opens media paths on its OWN filesystem: that host needs"
  note "            P80_MEDIA_ROOT at the same absolute path."
fi

# --- build -------------------------------------------------------------------------

if (( do_build )); then
  say "Installing dependencies and building the browser client"
  ( cd "${REPO}" && pnpm install --frozen-lockfile )
  # The API serves this directory. Without it P80 runs headless — the API comes up, says so
  # in its log, and there is no page at the root.
  ( cd "${REPO}" && pnpm build )
fi

[[ -f "${REPO}/apps/web/dist/index.html" ]] \
  || note "WARNING: no apps/web/dist. The API will serve no browser client. Run: pnpm build"

# --- units -------------------------------------------------------------------------

say "Writing unit files to ${UNIT_DIR}"
mkdir -p "${UNIT_DIR}"

# Any p80 unit that is installed but no longer in ALL_UNITS is left over from an earlier
# layout and has to go. Leaving one behind is not harmless: it stays enabled, systemd
# still tries to start it at boot, and it fails against a service that no longer exists.
# `p80-web.service` is the concrete case — the browser client used to be its own process
# and is now served by the API.
for path in "${UNIT_DIR}"/p80-*.service "${UNIT_DIR}"/p80-*.timer; do
  [[ -e "${path}" ]] || continue
  unit="$(basename "${path}")"
  for known in "${ALL_UNITS[@]}"; do
    [[ "${unit}" == "${known}" ]] && continue 2
  done
  systemctl --user disable --now "${unit}" 2>/dev/null || true
  rm -f "${path}"
  note "${unit} (removed — no longer part of P80)"
done

# systemd does not inherit a login shell's PATH, and node, pnpm, and uv are all likely to
# live somewhere a default PATH does not reach. Built from where they actually are, and
# deduplicated — the hand-written units this replaces repeated one directory three times.
build_path() {
  local dirs=() seen=" " dir
  for tool in node pnpm uv; do
    dir="$(command -v "$tool" 2>/dev/null)" || continue
    dir="$(cd "$(dirname "$dir")" && pwd)"
    [[ "$seen" == *" ${dir} "* ]] && continue
    seen+="${dir} "
    dirs+=("$dir")
  done
  for dir in /usr/local/bin /usr/bin /bin; do
    [[ "$seen" == *" ${dir} "* ]] && continue
    seen+="${dir} "
    dirs+=("$dir")
  done
  local IFS=':'; printf '%s' "${dirs[*]}"
}
UNIT_PATH="$(build_path)"

# `&` and `\` mean something to sed on the right-hand side of a substitution, and `|` is
# the delimiter. A checkout under a directory containing any of them would otherwise
# produce a unit file that is quietly wrong rather than one that fails.
sed_escape() { printf '%s' "$1" | sed -e 's/[\\&|]/\\&/g'; }

install_unit() {
  local name="$1"
  sed -e "s|@REPO@|$(sed_escape "${REPO}")|g" \
      -e "s|@NODE@|$(sed_escape "${NODE_BIN}")|g" \
      -e "s|@NLP_BIN@|$(sed_escape "${NLP_BIN-}")|g" \
      -e "s|@PATH@|$(sed_escape "${UNIT_PATH}")|g" \
      "${TEMPLATE_DIR}/${name}.in" > "${UNIT_DIR}/${name}"
  note "${name}"
}

INSTALLED=()
for unit in "${ALL_UNITS[@]}"; do
  if [[ "${unit}" == p80-nlp.service ]] && (( ! NLP_IS_LOCAL )); then
    # Not merely skipped: removed. A stale unit left from when the sidecar was local is
    # exactly the two-processes-one-ignored bug this branch exists to avoid.
    if [[ -f "${UNIT_DIR}/${unit}" ]]; then
      systemctl --user disable --now "${unit}" 2>/dev/null || true
      rm -f "${UNIT_DIR}/${unit}"
      note "${unit} (removed — sidecar is remote)"
    fi
    continue
  fi
  install_unit "${unit}"
  # p80-backup.service has no [Install] section on purpose — the timer is what pulls it in,
  # and `enable` on a unit with nothing to install is an error rather than a no-op.
  [[ "${unit}" == p80-backup.service ]] || INSTALLED+=("${unit}")
done

say "Enabling and starting"
systemctl --user daemon-reload
systemctl --user enable "${INSTALLED[@]}" >/dev/null
# Restart rather than start: a reinstall over a running P80 should pick up the new units.
systemctl --user restart p80.target
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
note "logs      journalctl --user -u p80-api -f"
note "restart   systemctl --user restart p80.target"
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
