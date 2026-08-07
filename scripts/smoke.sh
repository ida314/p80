#!/usr/bin/env bash
#
# End-to-end smoke check against a running `pnpm dev`.
#
# This is Stage 1 exit criterion 1's recorded manual check, and a first instalment on
# ADR 0007's standing test: a shell script using `curl` alone must be able to drive P80.
# When that stops being true, domain logic has leaked into a client.
#
#   pnpm dev          # in one terminal
#   bash scripts/smoke.sh
set -uo pipefail

API_PORT="${P80_API_PORT:-5180}"
WEB_PORT="${P80_WEB_PORT:-5173}"
NLP_PORT="${P80_NLP_PORT:-5181}"
HOST="${P80_BIND_HOST:-127.0.0.1}"
API="http://${HOST}:${API_PORT}"

pass=0
fail=0

check() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  ok   %-52s %s\n' "$label" "$actual"
    pass=$((pass + 1))
  else
    printf '  FAIL %-52s expected %s, got %s\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

echo "P80 smoke check — ${API}"
echo

echo "health"
check "api /api/health"            200 "$(status "${API}/api/health")"
check "nlp /health"                200 "$(status "http://${HOST}:${NLP_PORT}/health")"
check "web dev server"             200 "$(status "http://${HOST}:${WEB_PORT}/")"
# Not implemented until Stage 4, and it says so rather than degrading (ADR 0002).
check "nlp /annotate refuses"      501 "$(status -X POST -H 'content-type: application/json' \
                                            -d '{"language":"de","sentences":["Hallo"]}' \
                                            "http://${HOST}:${NLP_PORT}/annotate")"

echo
echo "profile persists"
check "GET  /api/profile"          200 "$(status "${API}/api/profile")"
check "PUT  /api/profile"          200 "$(status -X PUT -H 'content-type: application/json' \
                                            -d '{"dailyMinutes":25}' "${API}/api/profile")"
minutes=$(curl -s "${API}/api/profile" | grep -o '"dailyMinutes":[0-9]*' | cut -d: -f2)
check "value survived the write"   25  "${minutes:-none}"

echo "worker claims a job"
# Enqueued by a script, not an endpoint: `03-api.md` has no generic enqueue route and
# should not grow one. `NOOP` exists so this is checkable without a real pipeline stage.
job=$(pnpm --silent dev:noop 2>/dev/null | tail -1)
if [[ -z "${job}" ]]; then
  check "enqueue NOOP" "an id" "nothing"
else
  claimed=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    claimed=$(curl -s "${API}/api/jobs/${job}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    [[ "${claimed}" == "succeeded" || "${claimed}" == "failed" ]] && break
    sleep 0.5
  done
  check "job reached succeeded" succeeded "${claimed:-none}"
fi

echo
echo "origins"
check "loopback origin allowed"    200 "$(status -H "Origin: http://127.0.0.1:${WEB_PORT}" \
                                            "${API}/api/health")"
check "remote origin rejected"     403 "$(status -H 'Origin: http://evil.example' \
                                            "${API}/api/health")"

echo
if (( fail > 0 )); then
  echo "${pass} passed, ${fail} FAILED"
  exit 1
fi
echo "${pass} passed"
