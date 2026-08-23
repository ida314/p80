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
# The sidecar may not be on this machine. Probe wherever the API is configured to reach
# it, or a remote-inference setup reports its own absent loopback sidecar as the failure.
NLP="${P80_NLP_BASE_URL:-http://${HOST}:${NLP_PORT}}"
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

# --- putting things back -----------------------------------------------------------
#
# Registered as things are created, not removed at the point of use. The straight-line form
# leaks on any early exit, and one of the things this script changes is a **live setting** —
# the user's real configuration, not scratch state. A smoke run that permanently downgrades
# the transcription model is a defect in the suite, and it was one for months.
CLEANUP_FILES=()
CLEANUP_TREES=()
CLEANUP_DIRS=()

# "" nothing to put back · "-" there was no row, so clear it · anything else, the old value.
# The two are not interchangeable: writing the environment value back leaves a row that has
# stopped tracking .env.local, which is the state this script used to leave behind.
ASR_MODEL_RESTORE=""

restore_asr_model() {
  [[ -n "${ASR_MODEL_RESTORE}" ]] || return 0
  local payload
  if [[ "${ASR_MODEL_RESTORE}" == "-" ]]; then
    payload='{"settings":{"P80_ASR_MODEL":null}}'
  else
    payload="{\"settings\":{\"P80_ASR_MODEL\":\"${ASR_MODEL_RESTORE}\"}}"
  fi
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' \
            -d "${payload}" "${API}/api/settings")"
  # Loud, because a silent failure here is exactly the defect this function exists to fix:
  # the run would end reporting success while having left the model overridden.
  if [[ "${code}" != 200 ]]; then
    printf '\n  WARNING  could not restore P80_ASR_MODEL (HTTP %s).\n' "${code}" >&2
    printf '           Put it back with: p80 settings %s\n' \
      "$([[ "${ASR_MODEL_RESTORE}" == "-" ]] && echo 'revert P80_ASR_MODEL' \
         || echo "set P80_ASR_MODEL ${ASR_MODEL_RESTORE}")" >&2
    return 1
  fi
  ASR_MODEL_RESTORE=""
}

cleanup() {
  local path
  for path in "${CLEANUP_FILES[@]:-}"; do [[ -n "${path}" ]] && rm -f "${path}"; done
  for path in "${CLEANUP_TREES[@]:-}"; do [[ -n "${path}" ]] && rm -rf "${path}"; done
  # Tolerated failure: these are shared with the user's own library and are only ours to
  # remove while they are empty.
  for path in "${CLEANUP_DIRS[@]:-}"; do [[ -n "${path}" ]] && rmdir "${path}" 2>/dev/null; done
  restore_asr_model
}
trap cleanup EXIT

echo "P80 smoke check — ${API}"
echo

echo "health"
check "api /api/health"            200 "$(status "${API}/api/health")"
check "nlp /health"                200 "$(status "${NLP}/health")"
# The browser client comes from one of two places and this script has to work against
# both. Under `pnpm dev` Vite serves it on its own port; in a deployment the API serves
# the build on its own port and there is nothing on ${WEB_PORT} at all. A built `dist` is
# what tells the two apart, and it is the same signal the API itself uses.
if [[ -f "${REPO}/apps/web/dist/index.html" ]]; then
  check "web client (served by api)" 200 "$(status "${API}/")"
else
  check "web dev server"           200 "$(status "http://${HOST}:${WEB_PORT}/")"
fi
# Not implemented until Stage 4, and it says so rather than degrading (ADR 0002).
check "nlp /annotate refuses"      501 "$(status -X POST -H 'content-type: application/json' \
                                            -d '{"language":"de","sentences":["Hallo"]}' \
                                            "${NLP}/annotate")"
# ADR 0016. The sidecar reports capabilities separately, so a working ASR model does not
# imply a working annotator. Either flag may be false — what must never happen is a
# transcript being returned when the model is absent, which is asserted in the unit tests.
check "nlp reports asr capability" "yes" \
  "$(curl -s "${NLP}/health" | grep -qo '"transcribe_available":' && echo yes || echo no)"

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
# Asked of the API rather than guessed from the environment. Since ADR 0019 the media root
# is runtime-editable and the `settings` table wins over `.env.local`, so this shell's idea
# of it can be stale or — running against an installed service — absent entirely. Writing
# the fixture somewhere the API is not looking fails as "path not found", which points at
# the file rather than at the disagreement.
media_root="$(curl -s "${API}/api/settings" \
  | grep -o '"key":"P80_MEDIA_ROOT","tier":"[a-z]*","value":"[^"]*"' \
  | sed 's/.*"value":"//; s/"$//')"
# Anything this run puts under the media root is registered now rather than removed at the
# point of use, so a ^C between here and the end still takes it out.
if [[ -n "${media_root}" ]]; then
  CLEANUP_TREES+=("${media_root}/smoke")
fi
media_root="${media_root:-${P80_MEDIA_ROOT:-${REPO}/data/media}}"
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

  # ------------------------------------------------------------------ Stage 3
  # ADR 0007's standing test, in full: `curl` alone must be able to create a learning item
  # and complete a review session. If any step here needs a browser, scheduling logic has
  # leaked into a client.
  #
  # `${segment}` is the first segment, whose text is "Guten Tag." — so offsets 0..5 select
  # "Guten". The offsets are what the client sends; the server resolves them to timings.
  if [[ -n "${segment}" ]]; then
    echo
    echo "manual items (ADR 0020)"

    # The sense is stamped with the run, like the media path above. `learning_items`'
    # identity constraint spans every status, so an item archived by a previous run's video
    # deletion still holds its sense key — correct behaviour, and it would make a fixed
    # fixture fail on the second run for a reason that has nothing to do with the code.
    run_tag="$(date +%s | tail -c 7)"
    item_body=$(printf '{"videoId":"%s","selection":{"segmentIds":["%s"],"spanStart":0,"spanEnd":5},"canonicalForm":"Guten","itemType":"word","meaning":"good, as a greeting (run %s)","translation":"good"}' "${video}" "${segment}" "${run_tag}")
    item=$(curl -s -X POST -H 'content-type: application/json' -d "${item_body}" "${API}/api/items" \
             | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    check "POST /api/items"            "an id" "$([[ -n "${item}" ]] && echo 'an id' || echo 'nothing')"

    # §3.1's identity constraint. Not auto-suffixed into a second sense — a silently
    # collapsed distinction is invariant 4's failure mode.
    check "same sense refused"         409 "$(status -X POST -H 'content-type: application/json' \
                                                -d "${item_body}" "${API}/api/items")"
    # Rule 4 reaches here too: a selection is untrusted input.
    check "bad offsets refused"        400 "$(status -X POST -H 'content-type: application/json' \
                                                -d "$(printf '{"videoId":"%s","selection":{"segmentIds":["%s"],"spanStart":0,"spanEnd":9999},"canonicalForm":"x","itemType":"word","meaning":"y %s"}' "${video}" "${segment}" "${run_tag}")" \
                                                "${API}/api/items")"

    check "GET /api/items"             200 "$(status "${API}/api/items")"
    # Hard rule 11: a user-authored gloss carries no dictionary evidence.
    check "gloss is unverified"        false "$(curl -s "${API}/api/items/${item}" \
                                                 | grep -o '"verified":[a-z]*' | head -1 | cut -d: -f2)"
    # ADR 0020 §3: zero here means unscored, not worthless, and the flag says which.
    check "ranking scores unscored"    true  "$(curl -s "${API}/api/items/${item}" \
                                                 | grep -o '"unscored":[a-z]*' | cut -d: -f2)"

    echo
    echo "review session"
    session=$(curl -s -X POST -H 'content-type: application/json' \
                -d '{"desiredMinutes":20,"includeNewItems":true}' \
                "${API}/api/review/session" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
    check "POST /api/review/session"   "an id" "$([[ -n "${session}" ]] && echo 'an id' || echo 'nothing')"

    # §7 counts per day, so a second run on the same day starts from a non-zero count.
    # The assertion has to be a delta, not an absolute — an absolute one would pass exactly
    # once and then look like a regression.
    introduced_before=$(curl -s "${API}/api/review/due" \
                          | grep -o '"newItemsIntroducedToday":[0-9]*' | cut -d: -f2)

    card=$(curl -s "${API}/api/review/session/${session}/next")
    review_id=$(echo "${card}" | grep -o '"reviewId":"[^"]*"' | cut -d'"' -f4)
    check "GET .../next returns a card" "an id" "$([[ -n "${review_id}" ]] && echo 'an id' || echo 'nothing')"
    # §1 rule 2 / §9.9: the back face is not in the front-face payload, or a reveal stops
    # being an event the server can tell apart from a retrieval.
    check "the answer is not in it"    ""  "$(echo "${card}" | grep -o 'as a greeting' | head -1)"
    check "the clip has a window"      "yes" "$(echo "${card}" | grep -qo '"itemStartMs":' && echo yes || echo no)"

    # Rating before the attempt is refused rather than absorbed.
    check "rating before answering"    409 "$(status -X POST -H 'content-type: application/json' \
                                                -d "{\"reviewId\":\"${review_id}\",\"rating\":\"good\"}" \
                                                "${API}/api/review/session/${session}/rate")"

    check "POST .../answer reveals"    200 "$(status -X POST -H 'content-type: application/json' \
                                                -d "{\"reviewId\":\"${review_id}\",\"responseText\":\"good\",\"responseLatencyMs\":3000}" \
                                                "${API}/api/review/session/${session}/answer")"

    rated=$(curl -s -X POST -H 'content-type: application/json' \
              -d "{\"reviewId\":\"${review_id}\",\"rating\":\"good\"}" \
              "${API}/api/review/session/${session}/rate")
    check "POST .../rate schedules"    "yes" "$(echo "${rated}" | grep -qo '"dueAt":[0-9]' && echo yes || echo no)"
    # Exit criterion 3, end to end: the rating moved the card into the future.
    check "the due date moved forward" "yes" \
      "$(dueat=$(echo "${rated}" | grep -o '"dueAt":[0-9]*' | cut -d: -f2); \
         [[ -n "${dueat}" && "${dueat}" -gt "$(date +%s000)" ]] && echo yes || echo no)"
    # `reviews` is append-only, so a second rating cannot overwrite the first.
    check "second rating refused"      409 "$(status -X POST -H 'content-type: application/json' \
                                                -d "{\"reviewId\":\"${review_id}\",\"rating\":\"easy\"}" \
                                                "${API}/api/review/session/${session}/rate")"

    # Exit criterion 6.
    history=$(curl -s "${API}/api/items/${item}/history")
    check "history records the rep"    good "$(echo "${history}" | grep -o '"schedulerRating":"[^"]*"' | head -1 | cut -d'"' -f4)"
    check "and its latency"            3000 "$(echo "${history}" | grep -o '"responseLatencyMs":[0-9]*' | head -1 | cut -d: -f2)"

    check "POST .../complete"          200 "$(status -X POST -H 'content-type: application/json' -d '{}' \
                                                "${API}/api/review/session/${session}/complete")"
    check "a finished session is 409"  409 "$(status "${API}/api/review/session/${session}/next")"

    check "GET /api/review/due"        200 "$(status "${API}/api/review/due")"
    check "GET /api/review/forecast"   200 "$(status "${API}/api/review/forecast")"
    # §7 counts items, not cards: one item producing three cards spends one allowance.
    introduced_after=$(curl -s "${API}/api/review/due" \
                         | grep -o '"newItemsIntroducedToday":[0-9]*' | cut -d: -f2)
    check "one item spent, not three"  1   "$(( introduced_after - introduced_before ))"

    check "POST .../suspend"           200 "$(status -X POST "${API}/api/items/${item}/suspend")"
    check "POST .../unsuspend"         200 "$(status -X POST "${API}/api/items/${item}/unsuspend")"
  fi

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

# The media root is the user's own library, not a scratch directory. Leaving fixtures in it
# would be P80 writing to the one place it is supposed to only ever read from. Removed here
# *and* registered with the trap, so an interrupted run does not leave it behind either.
rm -rf "${media_root:?}/smoke"

echo
echo "media library and uploads (ADR 0024)"
# The `curl`-only constraint (ADR 0007) is a real design constraint for this surface, and
# this section is the proof it holds: a complete upload, end to end, with no browser.
upload_name="smoke-upload-$(date +%s | tail -c 7).mp4"
# Registered before the first byte is sent: an interrupted upload leaves a partial file, and
# `<media root>/uploads/` is the user's library rather than a scratch directory.
CLEANUP_FILES+=("${media_root}/uploads/${upload_name}" "${TMPDIR:-/tmp}/p80-smoke-chunk")
CLEANUP_DIRS+=("${media_root}/uploads/.p80-partial" "${media_root}/uploads")
upload_body="$(printf 'P80 smoke upload payload')"
upload_size="${#upload_body}"

upload_id="$(curl -s -X POST -H 'content-type: application/json' \
              -d "{\"filename\":\"${upload_name}\",\"sizeBytes\":${upload_size},\"transcribe\":false}" \
              "${API}/api/uploads" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
check "POST /api/uploads"            26 "${#upload_id}"
check "nothing received yet"          0 "$(curl -s "${API}/api/uploads/${upload_id}" \
                                            | grep -o '"receivedBytes":[0-9]*' | cut -d: -f2)"

# Split so the protocol is actually exercised rather than a single-shot PUT wearing a
# chunked protocol's clothes.
head_bytes="${upload_body:0:10}"
tail_bytes="${upload_body:10}"

printf '%s' "${head_bytes}" > "${TMPDIR:-/tmp}/p80-smoke-chunk"
check "PUT the first chunk"         200 "$(status -X PUT -H 'content-type: application/octet-stream' \
                                            --data-binary "@${TMPDIR:-/tmp}/p80-smoke-chunk" \
                                            "${API}/api/uploads/${upload_id}/chunk?offset=0")"
# A replayed chunk is a SUCCESS, not a conflict: it is what a retry after a lost response
# looks like, and refusing it would wedge a client that is behaving correctly.
check "a replayed chunk is a no-op" 200 "$(status -X PUT -H 'content-type: application/octet-stream' \
                                            --data-binary "@${TMPDIR:-/tmp}/p80-smoke-chunk" \
                                            "${API}/api/uploads/${upload_id}/chunk?offset=0")"
check "count did not double"         10 "$(curl -s "${API}/api/uploads/${upload_id}" \
                                            | grep -o '"receivedBytes":[0-9]*' | cut -d: -f2)"
check "a wrong offset is refused"   409 "$(status -X PUT -H 'content-type: application/octet-stream' \
                                            --data-binary "@${TMPDIR:-/tmp}/p80-smoke-chunk" \
                                            "${API}/api/uploads/${upload_id}/chunk?offset=99")"
check "completing early is refused" 409 "$(status -X POST "${API}/api/uploads/${upload_id}/complete")"

printf '%s' "${tail_bytes}" > "${TMPDIR:-/tmp}/p80-smoke-chunk"
check "PUT the last chunk"          200 "$(status -X PUT -H 'content-type: application/octet-stream' \
                                            --data-binary "@${TMPDIR:-/tmp}/p80-smoke-chunk" \
                                            "${API}/api/uploads/${upload_id}/chunk?offset=10")"
rm -f "${TMPDIR:-/tmp}/p80-smoke-chunk"

upload_video="$(curl -s -X POST "${API}/api/uploads/${upload_id}/complete" \
                 | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)"
check "completion creates a video"   26 "${#upload_video}"

# The round-trip claim: what comes back out is exactly what went in. Everything else in
# this section is protocol; this is the part that says the protocol moved the right bytes.
check "the bytes survived intact" "${upload_body}" \
      "$(curl -s "${API}/api/videos/${upload_video}/media")"

check "GET /api/library"            200 "$(status "${API}/api/library")"
check "the upload is listed"       true "$(curl -s "${API}/api/library?path=uploads" \
                                            | grep -c "\"name\":\"${upload_name}\"" \
                                            | sed 's/^0$/false/; s/^[1-9][0-9]*$/true/')"
check "and is marked as added"    false "$(curl -s "${API}/api/library?path=uploads" \
                                            | grep -o '"canAdd":[a-z]*' | head -1 | cut -d: -f2)"

# Deletion is bounded to what P80 wrote, and refuses once before it destroys anything.
check "escaping the root refused"   400 "$(status -X DELETE \
                                            "${API}/api/library/file?path=..%2F..%2Fetc%2Fpasswd.mp4")"
check "outside uploads/ refused"    403 "$(status -X DELETE \
                                            "${API}/api/library/file?path=${media_rel}")"
check "a file in use is refused"    409 "$(status -X DELETE \
                                            "${API}/api/library/file?path=uploads%2F${upload_name}")"
check "acknowledged delete works"   200 "$(status -X DELETE \
                                            "${API}/api/library/file?path=uploads%2F${upload_name}&acknowledgeVideos=true")"
# Nothing cascaded: the video is still there and repairable (ADR 0018 3).
check "the video still exists"      200 "$(status "${API}/api/videos/${upload_video}")"
check "and is flagged for repair"  true "$(curl -s "${API}/api/videos/${upload_video}" \
                                            | grep -o '"mediaMissing":[a-z]*' | cut -d: -f2)"

# Rule 1's regression, in one line: an upload body that honoured a URL would turn a push
# into a pull without anything else in the system changing.
check "an upload takes no URL"      400 "$(status -X POST -H 'content-type: application/json' \
                                            -d '{"url":"https://example.invalid/v.mp4","sizeBytes":10}' \
                                            "${API}/api/uploads")"

check "DELETE the uploaded video"   200 "$(status -X DELETE "${API}/api/videos/${upload_video}")"

# The media root is the user's own library. Remove only this run's file, and take the
# uploads directory only if it is empty — the user may have real uploads in there.
rm -f "${media_root}/uploads/${upload_name}"
rmdir "${media_root}/uploads/.p80-partial" 2>/dev/null || true
rmdir "${media_root}/uploads" 2>/dev/null || true

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
#
# Read before writing. This is the live model setting, and the value here is whatever the
# user chose — so the run has to put back exactly what it found, including the difference
# between "there was a row" and "there was not" (ADR 0026).
asr_row="$(curl -s "${API}/api/settings" | grep -o '"key":"P80_ASR_MODEL"[^}]*')"
asr_model_was="$(grep -o '"value":"[^"]*"' <<<"${asr_row}" | head -1 | cut -d'"' -f4)"
asr_source_was="$(grep -o '"source":"[a-z]*"' <<<"${asr_row}" | head -1 | cut -d'"' -f4)"
if [[ "${asr_source_was}" == database ]]; then
  ASR_MODEL_RESTORE="${asr_model_was}"
elif [[ "${asr_source_was}" == environment ]]; then
  ASR_MODEL_RESTORE="-"
fi

check "an ASR option is writable"  200 "$(status -X PUT -H 'content-type: application/json' \
                                            -d '{"settings":{"P80_ASR_MODEL":"medium"}}' \
                                            "${API}/api/settings")"
check "and wins over .env.local" database "$(curl -s "${API}/api/settings" \
                                              | grep -o '"key":"P80_ASR_MODEL"[^}]*"source":"[a-z]*"' \
                                              | grep -o '"source":"[a-z]*"' | cut -d'"' -f4)"

# The suite's own footprint, asserted rather than assumed. Before this check existed, every
# run left `P80_ASR_MODEL: medium` in the database and the effect was read twice as a
# leftover experiment.
restore_asr_model
asr_row_after="$(curl -s "${API}/api/settings" | grep -o '"key":"P80_ASR_MODEL"[^}]*')"
check "the run puts the model back" "${asr_model_was}" \
      "$(grep -o '"value":"[^"]*"' <<<"${asr_row_after}" | head -1 | cut -d'"' -f4)"
check "and leaves no new override" "${asr_source_was}" \
      "$(grep -o '"source":"[a-z]*"' <<<"${asr_row_after}" | head -1 | cut -d'"' -f4)"

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
