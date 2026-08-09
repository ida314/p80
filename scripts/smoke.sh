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
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORAGE="${P80_STORAGE_PATH:-${REPO}/data/storage}"

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
# ADR 0016. The sidecar reports capabilities separately, so a working ASR model does not
# imply a working annotator. Either flag may be false — what must never happen is a
# transcript being returned when the model is absent, which is asserted in the unit tests.
check "nlp reports asr capability" "yes" \
  "$(curl -s "http://${HOST}:${NLP_PORT}/health" | grep -qo '"transcribe_available":' && echo yes || echo no)"

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
echo "ingestion — add, upload, parse, read, correct, delete"
# ADR 0007's standing test, in full for Stage 2: everything the web client can do, `curl`
# can do. If a step here needs the browser, domain logic has leaked into a client.
#
# It also exercises the one thing no unit test can: the API writing a transcript file that
# a *separate worker process* reads back. That is exactly where this project's silent bugs
# have lived — a relative path resolved against two different working directories fails
# here and nowhere else.
# ADR 0015: P80 is pointed at a file it can already reach. The script creates one under
# `P80_MEDIA_ROOT` — a few bytes, never decoded — because the API checks existence before
# writing a row, and a smoke test that skipped that would skip the whole containment path.
media_root="${P80_MEDIA_ROOT:-${REPO}/data/media}"
media_rel="smoke/smoke-$(date +%s | tail -c 7).mp4"
mkdir -p "$(dirname "${media_root}/${media_rel}")"
printf 'not a real container' > "${media_root}/${media_rel}"
# A non-media file inside the root, so "refused because of its extension" is tested against
# something that actually exists — otherwise it could pass for the wrong reason.
printf 'not media' > "${media_root}/smoke/notes.txt"

video=$(curl -s -X POST -H 'content-type: application/json' \
          -d "{\"path\":\"${media_rel}\",\"title\":\"Smoke test\"}" \
          "${API}/api/videos" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "${video}" ]]; then
  check "POST /api/videos" "an id" "nothing"
else
  # Step 16, duplicate detection: the same path a second time is refused before it costs
  # anything. The *renamed*-file case is content-hash based and lives in the worker.
  check "duplicate path refused"     409 "$(status -X POST -H 'content-type: application/json' \
                                              -d "{\"path\":\"${media_rel}\"}" "${API}/api/videos")"
  # Rule 4: a media path is untrusted input, resolved under the root or rejected. Not
  # normalised into something acceptable.
  check "traversal refused"          400 "$(status -X POST -H 'content-type: application/json' \
                                              -d '{"path":"../../etc/passwd.mp4"}' \
                                              "${API}/api/videos")"
  check "absolute path refused"      400 "$(status -X POST -H 'content-type: application/json' \
                                              -d '{"path":"/etc/shadow.mp4"}' \
                                              "${API}/api/videos")"
  check "non-media file refused"     400 "$(status -X POST -H 'content-type: application/json' \
                                              -d '{"path":"smoke/notes.txt"}' \
                                              "${API}/api/videos")"

  # The media route serves the user's bytes and produces no copy. Range support is what a
  # <video> element needs to seek at all.
  check "GET .../media serves bytes" 200 "$(status "${API}/api/videos/${video}/media")"
  check "range request is partial"   206 "$(status -H 'Range: bytes=0-3' "${API}/api/videos/${video}/media")"
  check "range past the end is 416"  416 "$(status -H 'Range: bytes=9999-99999' "${API}/api/videos/${video}/media")"
  check "no media copied to storage" ""  "$(find "${STORAGE:-./data/storage}" -name '*.mp4' 2>/dev/null | head -1)"

  vtt='WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nGuten Tag.\n\n00:00:03.000 --> 00:00:05.000\nWie geht es Ihnen?\n'
  body=$(printf '{"content":"%s","filename":"smoke.vtt"}' "${vtt}")

  # Preview persists nothing — §12.1 step 7.
  check "POST .../transcript/preview" 200 "$(status -X POST -H 'content-type: application/json' \
                                               -d "${body}" \
                                               "${API}/api/videos/${video}/transcript/preview")"

  # The upload path is the ADR 0016 fallback, and it wins over ASR when both exist. It is
  # what this script exercises, because the ASR path needs a GPU and a real audio track.
  upload=$(curl -s -X POST -H 'content-type: application/json' -d "${body}" \
             "${API}/api/videos/${video}/transcript")
  parse_job=$(echo "${upload}" | grep -o '"jobId":"[^"]*"' | cut -d'"' -f4)
  check "POST .../transcript accepted" "an id" "$([[ -n "${parse_job}" ]] && echo 'an id' || echo 'nothing')"

  # The worker is a different process. This is the cross-process step.
  parsed=""
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    parsed=$(curl -s "${API}/api/jobs/${parse_job}" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    [[ "${parsed}" == "succeeded" || "${parsed}" == "failed" ]] && break
    sleep 0.5
  done
  check "PARSE_TRANSCRIPT succeeded" succeeded "${parsed:-none}"

  transcript=$(curl -s "${API}/api/videos/${video}/transcript")
  segment=$(echo "${transcript}" | grep -o '"id":"[^"]*"' | sed -n 2p | cut -d'"' -f4)
  check "transcript is ready"        ready "$(echo "${transcript}" | grep -o '"transcriptStatus":"[^"]*"' | cut -d'"' -f4)"
  check "first segment starts at 1s" 1000  "$(echo "${transcript}" | grep -o '"startMs":[0-9]*' | head -1 | cut -d: -f2)"
  # ADR 0017: an uploaded file is cue-tier, always. Word timing is offered separately and
  # says so rather than silently returning something coarser.
  check "upload is cue-tier"         cue   "$(echo "${transcript}" | grep -o '"timingGranularity":"[^"]*"' | cut -d'"' -f4)"
  check "word timing unavailable"    409   "$(status "${API}/api/videos/${video}/transcript/words")"

  # No filesystem path ever leaves the API, including through the job payload.
  check "no storage path in response" ""   "$(echo "${transcript}" | grep -o 'storage_path\|storagePath' | head -1)"
  check "no storage path in job"      ""   "$(curl -s "${API}/api/jobs/${parse_job}" | grep -o 'storage_path\|storagePath' | head -1)"
  check "no media path in response"   ""   "$(echo "${transcript}" | grep -o 'mediaPath\|media_path' | head -1)"

  if [[ -n "${segment}" ]]; then
    check "PUT a correction"         200 "$(status -X PUT -H 'content-type: application/json' \
                                              -d '{"text":"Guten Tag!"}' \
                                              "${API}/api/videos/${video}/transcript/segments/${segment}")"
    # The original is never mutated — the correction is a separate row.
    check "original text preserved" "Guten Tag." \
      "$(curl -s "${API}/api/videos/${video}/transcript" | grep -o '"rawText":"[^"]*"' | head -1 | cut -d'"' -f4)"
  fi

  # A second upload without `replace` is refused, because it would destroy corrections.
  check "replace requires the flag"  409 "$(status -X POST -H 'content-type: application/json' \
                                              -d "${body}" "${API}/api/videos/${video}/transcript")"

  # A missing file is a repairable broken link, not a cascade (ADR 0018 §3).
  rm -f "${media_root}/${media_rel}"
  check "missing media is a 404"     404 "$(status "${API}/api/videos/${video}/media")"
  check "the video survives it"      200 "$(status "${API}/api/videos/${video}")"
  check "and is flagged for repair"  true "$(curl -s "${API}/api/videos/${video}" | grep -o '"mediaMissing":[a-z]*' | cut -d: -f2)"

  check "DELETE the transcript"      200 "$(status -X DELETE "${API}/api/videos/${video}/transcript")"
  check "DELETE the video"           200 "$(status -X DELETE "${API}/api/videos/${video}")"
fi

echo
echo "media policy"
# ADR 0015: the media route is the ONLY endpoint that serves bytes, and it is gone with the
# video. Nothing else may produce media, and nothing may produce an isolated audio track.
check "no audio endpoint exists"     404 "$(status "${API}/api/videos/${video}/audio")"
check "no stream endpoint exists"    404 "$(status "${API}/api/videos/${video}/stream")"
check "no download endpoint exists"  404 "$(status "${API}/api/videos/${video}/download")"

echo
echo "settings"
# ADR 0019. The `curl` path has to be complete here too — a surface only the web client can
# reach would mean the API response is incomplete (ADR 0007).
check "settings are readable"      200 "$(status "${API}/api/settings")"
check "media root is editable"     live "$(curl -s "${API}/api/settings" \
                                            | grep -o '"key":"P80_MEDIA_ROOT","tier":"[a-z]*"' \
                                            | cut -d'"' -f8)"
# Accepted-and-ignored is the failure mode this refusal exists to prevent.
check "a boot key is refused"      400 "$(status -X PUT -H 'content-type: application/json' \
                                            -d '{"settings":{"P80_API_PORT":9999}}' \
                                            "${API}/api/settings")"
check "LAN exposure is refused"    400 "$(status -X PUT -H 'content-type: application/json' \
                                            -d '{"settings":{"P80_ALLOW_LAN":true}}' \
                                            "${API}/api/settings")"
check "an unknown key is refused"  400 "$(status -X PUT -H 'content-type: application/json' \
                                            -d '{"settings":{"P80_NOPE":"x"}}' \
                                            "${API}/api/settings")"
check "/ is not a media root"      400 "$(status -X PUT -H 'content-type: application/json' \
                                            -d '{"settings":{"P80_MEDIA_ROOT":"/"}}' \
                                            "${API}/api/settings")"
check "/etc is not a media root"   400 "$(status -X PUT -H 'content-type: application/json' \
                                            -d '{"settings":{"P80_MEDIA_ROOT":"/etc"}}' \
                                            "${API}/api/settings")"
# Preflight reports a rejection inside a 200 — the field is still being typed.
check "preflight rejects in a 200" 200 "$(status -X POST -H 'content-type: application/json' \
                                            -d '{"path":"/etc"}' \
                                            "${API}/api/settings/media-root/preflight")"
check "and says why"     system_directory "$(curl -s -X POST -H 'content-type: application/json' \
                                              -d '{"path":"/etc"}' \
                                              "${API}/api/settings/media-root/preflight" \
                                              | grep -o '"reason":"[^"]*"' | cut -d'"' -f4)"
# An ASR option round-trips, and reports itself as overriding the environment.
check "an ASR option is writable"  200 "$(status -X PUT -H 'content-type: application/json' \
                                            -d '{"settings":{"P80_ASR_MODEL":"medium"}}' \
                                            "${API}/api/settings")"
check "and wins over .env.local" database "$(curl -s "${API}/api/settings" \
                                              | grep -o '"key":"P80_ASR_MODEL"[^}]*"source":"[a-z]*"' \
                                              | grep -o '"source":"[a-z]*"' | cut -d'"' -f4)"

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
