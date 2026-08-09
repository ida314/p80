# Stage 2 — Local media ingestion and transcription

**Milestone:** M1
**Depends on:** Stage 1
**Spec reference:** `docs/original_spec.md` §35, Stage 2 — **substantially superseded**, see below

## Objective

A user points P80 at a video file they already have. P80 hashes it, transcribes it locally,
and shows the transcript synchronized to playback — clicking a line to seek, and correcting
a line without the original ever changing. Supplying a subtitle file is the fallback and
wins over transcription whenever it exists. After this stage there is real content for
Stage 3's items to be cut from.

## Rewritten mid-stage (ADR 0015–0018)

This brief originally described pasting a YouTube URL and attaching a subtitle file, and
that version was code-complete. **ADR 0015 replaced the media source**, and the work below
is what that cost. The record is kept rather than rewritten out, because the size of the
change is the argument for having had `MediaSourceAdapter` in the first place.

| Was | Is | ADR |
|---|---|---|
| Paste a YouTube URL | Point at a file under `P80_MEDIA_ROOT` | 0015 |
| IFrame player, keyframe-bounded seeks | `<video>` element, exact seeks | 0015 |
| Transcript is user-supplied, always | Local ASR primary, upload as fallback | 0016 |
| Timing at cue boundaries | Word array is the source of truth | 0017 |
| Identity is the YouTube id | Identity is the file's content hash | 0018 |

**What survived untouched** is the interesting half: the transcript parsers, the warning
vocabulary, corrections, the job loop, the storage-path rules, and every client component
except the player itself. Removing YouTube was a deletion, not a refactor, because nothing
above the adapter had learned anything about it.

**This stage now carries migration 0002** — three columns on `videos`, six on
`transcript_files`, two on `transcript_segments`, and the new `transcript_words` table.

## Contracts in scope

Read before starting:

- `docs/contracts/03-api.md` §1 (conventions, error envelope, the 202-plus-jobId rule), §3 (videos), §8 (jobs), §10 (security)
- `docs/contracts/04-providers.md` §1 — `MediaSourceAdapter`, `MediaDescriptor`, `TranscriptParseResult`, `ParseWarning`, the rewritten hard media rules, clip playback (§19.1); §1a — `AsrProvider`
- `docs/contracts/02-database.md` — `videos`, `transcript_files`, `transcript_segments`, `transcript_corrections`, `jobs`
- `docs/contracts/01-domain-model.md` §7 invariant 5 — video delete cascades to the transcript, never to approved items
- **ADR 0013 §4** — the boilerplate regex list is Stage 2's, the filter around it is not

Changed by this stage (with an ADR):

- **ADR 0014** — `ParseWarning` gains `subtitle_boilerplate`; the kind list moves to `packages/core/src/domain.ts`
- **ADR 0015** — `local_media` replaces `youtube_embedded`; hard media rules rewritten
- **ADR 0016** — local ASR in `services/nlp`, primary over upload; two more warning kinds
- **ADR 0017** — `transcript_words`, and segments as index ranges over it
- **ADR 0018** — content-hash identity, path as a repairable locator

**Must not be changed by this stage:**

- Migration 0001 — it is applied and forward-only. 0002 adds; it does not edit
- Any formula in `06-scoring.md`; the extraction architecture in `07-extraction.md`
- `transcript_segments` after insertion — corrections are separate rows
- **`transcript_words` after insertion.** Same rule, one level down: the word array is the original ASR evidence and a correction does not rewrite it

## Steps

Spec §35 lists sixteen. Their state:

- [x] 1. Add video form — `/videos/new`, a real route rather than a modal
- [x] 2. ~~Parse YouTube URL~~ → **Validate a media path** — containment under `P80_MEDIA_ROOT`, rejected rather than normalised (ADR 0015)
- [x] 3. ~~Store video ID~~ → **Hash the file** — `INGEST_MEDIA` computes identity; the path is a repairable locator (ADR 0018)
- [x] 4. ~~Embed YouTube player~~ → **`<video>` against a Range-serving route** (ADR 0015)
- [x] 5. VTT parser
- [x] 6. SRT parser
- [x] 7. Pasted timestamp format
- [x] 8. Transcript-preview screen — `POST .../transcript/preview`, persists nothing
- [x] 9. Validate timestamps — §14.1; six hard failures, the rest are warnings
- [x] 10. Store transcript segments — repository done; the worker that calls it is phase 6
- [x] 11. Synchronized transcript view
- [x] 12. Click-transcript-to-seek
- [x] 13. Manual timestamp correction — writes `transcript_corrections`, never mutates
- [x] 14. Video processing status — `transcript_status` and `processing_status`
- [x] 15. Transcript deletion and replacement — `replace: true`, and the cost is named
- [x] 16. Duplicate-video detection — the existing unique constraint, caught as the authority

Added beyond the spec's list:

- [x] `/api/interests` CRUD (`03-api.md` §2) — four trivial endpoints, without which
      `video_interests` is dead and §12.1 step 5's interest tags have nothing to bind to
- [x] Response Zod schemas shared through `@p80/core/browser` — `apps/web/src/api.ts`
      hand-mirrors them today, and `videoResponse` alone is eighteen fields
- [x] `P80_STORAGE_PATH` — uploaded transcript files are kept (spec §7.2)
- [x] `newId()` is monotonic — see *Notes*
- [x] `test/web-safety.test.ts` — rule 8 made mechanical for the client
- [x] `@p80/core` marked `sideEffects: false` — see *Notes*

Added by the ADR 0015–0018 rewrite:

- [x] `GET /api/videos/:id/media` — Range-serving, streaming, no copy
- [x] `POST /api/videos/:id/media/repair` — re-point a moved file, hash verified in the worker
- [x] `INGEST_MEDIA` — stream-hash, `ffprobe` duration, duplicate resolution, hands off to transcription
- [x] `TRANSCRIBE` — local ASR, word array plus derived segments, upload precedence enforced twice
- [x] `POST /transcribe` on the NLP sidecar — three refusals, none of which returns an empty transcript
- [x] `GET /api/videos/:id/transcript/words` — 409 on a cue-tier transcript, never an empty array
- [x] `packages/core/src/words.ts` — grouping and the single span-timing call site
- [x] Migration 0002

## Exit criteria

| # | Criterion | Verified by | State |
|---|---|---|---|
| 1 | User can add a video and transcript | `apps/api/test/{videos,transcript-upload}.test.ts`; `apps/worker/test/parse-transcript.test.ts`; `smoke.sh` | ☑ |
| 2 | Transcript appears in timestamp order | `apps/api/test/transcript-read.test.ts` | ☑ |
| 3 | Clicking a segment seeks to the expected region | `packages/core/test/transcript-seek.test.ts`; `transcript-read.test.ts`; manual: M1 | ☑ code, ☐ M1 |
| 4 | User can correct a segment | `apps/api/test/transcript-correction.test.ts` | ☑ |
| 5 | P80 never acquires media, and never copies it | `test/media-policy.test.ts`; `apps/api/test/media-policy.test.ts` | ☑ |
| 6 | Refreshing preserves the source | `apps/api/test/videos.test.ts` (restart case); manual: M4 | ☑ code, ☐ M4 |

Contract-derived, added here because the spec's six leave them unchecked:

| # | Criterion | Verified by | State |
|---|---|---|---|
| 7 | The original segment row is byte-identical after a correction | `apps/api/test/transcript-correction.test.ts` | ☑ |
| 8 | A boilerplate cue is warned about and **still stored** | `packages/providers/test/transcript-validation.test.ts` | ☑ |
| 9 | `PARSE_TRANSCRIPT` is idempotent — run twice, one segment set | `apps/worker/test/parse-transcript.test.ts` | ☑ |
| 10 | No filesystem path leaves the API, including via `jobs.*_json` | `apps/api/test/transcript-upload.test.ts`; `smoke.sh` | ☑ |
| 11 | No warning message contains transcript text | `packages/providers/test/parser-hardening.test.ts` | ☑ |
| 12 | A hostile path cannot escape the media root | `packages/core/test/media-path.test.ts`; `test/media-policy.test.ts` | ☑ |
| 13 | Illegal status transitions throw | `packages/database/test/video-repository.test.ts` | ☑ |
| 14 | Preview persists nothing | `apps/api/test/transcript-preview.test.ts` | ☑ |
| 15 | The `curl` path is complete end to end | `scripts/smoke.sh` — 40/40 against a live `pnpm dev` | ☑ |
| 16 | The client cannot render transcript text as markup | `test/web-safety.test.ts` | ☑ |
| 17 | ~~The keyframe caveat is shown~~ — **withdrawn.** ADR 0015 deleted the rule with the player that required it; the test now asserts the claim is *absent* | `test/media-policy.test.ts` | ☑ |

Added by the ADR 0015–0018 rewrite:

| # | Criterion | Verified by | State |
|---|---|---|---|
| 18 | A moved file is a repairable link, and nothing cascades | `apps/worker/test/ingest-media.test.ts`; `apps/api/test/media-policy.test.ts`; `smoke.sh` | ☑ |
| 19 | Repair refuses a different file, naming both hashes | `apps/worker/test/ingest-media.test.ts` | ☑ |
| 20 | The same file under two names is one video | `apps/worker/test/ingest-media.test.ts` | ☑ |
| 21 | An uploaded transcript wins over ASR, before the model runs | `apps/worker/test/transcribe.test.ts` | ☑ |
| 22 | ASR never degrades into an empty transcript | `apps/worker/test/transcribe.test.ts`; `services/nlp/tests/test_transcribe.py` | ☑ |
| 23 | A missing GPU is a refusal, not a job that runs 20× slower | `services/nlp/tests/test_transcribe.py` | ☑ |
| 24 | A confident language mismatch fails the job | `services/nlp/tests/test_transcribe.py` | ☑ |
| 25 | Segment word-ranges tile the word array exactly | `apps/worker/test/transcribe.test.ts`; `packages/core/test/words.test.ts` | ☑ |
| 26 | A corrected segment falls back to cue timing | `packages/core/test/words.test.ts` | ☑ |
| 27 | Range requests are honoured, and a range past the end is 416 | `apps/api/test/media-policy.test.ts`; `smoke.sh` | ☑ |
| 28 | No media file is ever written under `P80_STORAGE_PATH` | `test/media-policy.test.ts`; `apps/api/test/media-policy.test.ts`; `smoke.sh` | ☑ |

**380 TypeScript tests, 15 Python tests, nine packages typechecking clean,
`scripts/smoke.sh` 40/40 against a live `pnpm dev`, and `pnpm --filter @p80/web build`
clean.** Criteria 3 and 6 are code-complete; what remains of them is M1 and M4, which need
a person at a browser.

**Manual checks.** Browser behaviour is verified as pure-function unit tests plus these
five, recorded because no browser runner ships this stage (revisit at Stage 3, where the
review UI makes one pay for itself). **None has been run yet.** Each needs a real video
file; none needs a network any more, which is one thing the rewrite made cheaper.

Put a German video under `P80_MEDIA_ROOT`, run `pnpm dev`, open
`http://127.0.0.1:5173/videos/new`, and:

- **M1** *(criterion 3)* — Add the video, wait for transcription, open it, and click the
  timecode on a line starting around 01:12. Playback begins **at** 01:12 — not before it,
  not after it — that line is highlighted, and the highlight advances on its own.
  **Fails if:** playback is audibly off the line's first word, or the highlight sticks
  during a gap. The old two-second keyframe allowance is gone; this is now an exact check.
- **M2** *(criterion 4)* — Press **Correct** on a line, change the text, set the start
  500 ms earlier, save. The row shows the new text with a `corrected` badge and an
  *"Originally: …"* line underneath. Reload — both survive.
  **Fails if:** the original text is gone, which would mean a segment row was mutated.
- **M3** *(new — criteria 18 and 27)* — With the video open and playing, move or rename the
  file on disk, then reload. The player is replaced by a message saying the media is
  missing and offering repair; the transcript is still fully there and still correctable.
  Move the file back, repair, and playback resumes.
  **Fails if:** the transcript disappears, or the page offers no way back.
- **M4** *(criterion 6)* — Add a video and reload the page while transcription is still
  running. The page says so and resolves on its own; reload again once it is ready and the
  video, transcript, and corrections are all still there.
  **Fails if:** a blank page, or a spinner that never resolves.
- **M5** *(new — criterion 21)* — While transcription is running, upload a subtitle file
  for the same video. The upload wins, and the ASR job finishes as *succeeded* with
  `skipped: upload_won` rather than overwriting it.
  **Fails if:** the ASR transcript replaces the upload, or the job reports failure — the
  user got what they asked for, and reporting their own choice back as an error is wrong.

Two failure paths are worth a look while you are there. With the API stopped, every screen
should show `API_UNREACHABLE` rather than a blank panel. With the **NLP sidecar** stopped,
adding a video should still work, fail transcription visibly, and offer the upload path —
that is ADR 0016's degraded mode, and it is the common case until the ASR model is
installed.

## Explicitly out of scope

- Text selection, item creation, cards, FSRS — **Stage 3**. Do not stop after this stage and start extraction.
- Sentence reconstruction, annotation, the NLP sidecar — **Stage 4**. ADR 0013's boundary fusion is Stage 4; only its regex list reaches here.
- Candidate highlights, timeline markers, difficulty, coverage, review performance on video detail (§10.3, §10.4) — Stages 5–12
- `internal_json` import — in the enum, but no §35 step asks for a parser. Rejected with a message naming Stage 13
- Pruning stored transcript files; a `PRUNE_TRANSCRIPT_FILES` job
- Playwright or any browser runner
- ADR 0006 Pass A. Still the standing Stage 0 gap; blocks nothing here

## Risks

- **§38.4 Transcript errors** — the stage's own subject. Contained by preview-before-commit,
  warnings surfaced rather than swallowed, corrections as append-only rows, and the original
  file kept on disk with its checksum.
- **§38.8 YouTube dependency** — the IFrame player is the only external dependency and the
  only outbound request. `embed` comes from the server, so the client never builds a player
  from a URL.
- **Untrusted input reaching a path or a persisted render surface.** Rule 8's live
  prohibitions this stage are the path and the render; the prompt one arrives in Stage 7.
  `storage_path` is server-generated from ULIDs so traversal is structurally impossible
  rather than filtered, and warning messages carry no cue text.
- **`P80_STORAGE_PATH` is a new relative path read by two processes** — precisely ADR 0012's
  first silent bug. Anchored to the repository root like `P80_DB_PATH`, and tested.
- **Scope: sixteen steps, roughly sixty files.** The phase boundaries are the checkpoints,
  and phases 1–6 are `curl`-verifiable before any React exists.

## Notes

**Divergence from spec §12.1 step 5: `targetLanguage` is not accepted on `POST /api/videos`.**
The spec has the user enter or confirm it on the add-video form. ADR 0001 ships exactly one
pair, and the value comes from the profile. A form field offering a choice that has one legal
answer is a promise the rest of the system does not keep; the registry hook is the forward
compatibility, not a dropdown.

**Divergence from `03-api.md` §3: `DELETE /api/videos/:id/transcript` is added.** Spec §35
step 15 requires deletion and replacement, and the contract's endpoint list has no way to
express either. Amended with an `ADDED` marker.

**Storage order is file order; display order is time order.** The parser never reorders.
`sequence_index` is the file's own order and `transcript_segments` is stored that way; reads
are `ORDER BY start_ms, sequence_index`, which is what exit criterion 2 tests, and an
`out_of_order` warning records the discrepancy. Re-sorting during the parse would break
correspondence to the on-disk file and to cue numbers, and reordering a transcript is a
data-mutation decision that belongs to the user through `transcript_corrections`.

**The status vocabularies are enforced in code, not by a CHECK constraint.** Both columns
are `TEXT NOT NULL DEFAULT 'none'` with no constraint, so `'none'` is a member of both sets
and no DDL is needed. Four layers instead: const arrays in `domain.ts`; one write path
(`setTranscriptStatus`) asserting an explicit transition table; `z.enum(...)` in response
schemas so a rogue stored value fails serialization loudly rather than reaching a client;
and a repository test. This constrains *transitions*, which a CHECK cannot — `none → ready`
is illegal and that is the guard test. It also keeps three Stage 1 tests untouched. When a
migration is next needed for some other reason, add the two CHECKs then.

**`rawText` is the cue's plain text, not the original bytes.** Tag stripping, entity
decoding, line joining, and speaker-prefix removal all happen before storage. The original
bytes are preserved by the file on disk plus its checksum, which is the real immutability
guarantee; storing markup in `raw_text` would only push tag stripping into every downstream
consumer. `normalized_text` is then `normalizeTranscriptText(rawText)` — transport
normalization only. **It does not lowercase**, because German capitalization is grammatical
and case folding is `LanguageAdapter.normalizeOrthography`'s business in Stage 4.

**Upload enqueues rather than parses inline**, which `03-api.md` left open. The route writes
the file and returns `202 {jobId}`; the worker parses. This follows §12.1 step 9's *"ingestion
job begins"* and §7.2's *"store uploaded transcript files locally"*, gives `PARSE_TRANSCRIPT`
its handler, and makes step 14's status load-bearing rather than decorative. The cost is that
the web client polls, which step 14 required anyway.

**Replacement names its cost.** A second upload is `409 TRANSCRIPT_ALREADY_EXISTS` unless the
body carries `replace: true`; `DELETE` returns `{deletedSegments, deletedCorrections,
deletedFiles}` and the UI states those counts before confirming. Uploaded files stay on disk,
so the source is recoverable — corrections are not, which is why they are counted out loud.

**A fourth silent bug, and the same family as Stage 1's three.** `newId()` returned a plain
ULID, whose entropy is re-randomised on every call — so two ids minted in the same
millisecond sort arbitrarily. `transcript_corrections` resolves *which correction wins* by
`(created_at, id)`, and a user nudging a timestamp with the keyboard produces two
corrections inside one millisecond routinely, so the older edit won roughly half the time.
It surfaced only under full-suite load, where the two inserts landed in one millisecond;
alone, the test passed. Fixed twice over: `newId()` now uses `monotonicFactory()`, and the
SQL breaks the tie on `rowid`, which is the database's own insertion order and needs no
cooperation between processes. The regression test forces the tie rather than racing for
it.

**`videos.duration_ms` is written by the browser, from the player.** The parse job
deliberately leaves it null: the transcript's last cue is where the *transcript* ends, not
the video, and a wrong duration in a displayed field is worse than an empty one. The Data
API would need a key, which rule 14 forbids. So `VideoDetail` writes it once from
`player.getDuration()` on `onReady`. That is a measurement taken from a player the user is
already watching, not a client computing a domain value — the distinction ADR 0007 draws.
`getDuration()` returns 0 until metadata arrives, and 0 is never stored.

**`@p80/core` is marked `sideEffects: false`.** Without it, the web client importing one
pure function from `@p80/core/browser` pulls the whole barrel, and therefore `api-types.ts`,
and therefore Zod — 57 kB of a schema library the browser never executes, since the client
consumes those schemas as types only. Nothing in `@p80/core` runs at import time, so the
flag is true as well as useful; if that ever changes it is the thing to revisit. Measured:
257 kB → 200 kB.

**Four IFrame-API failure modes, handled up front in `player/youtubeApi.ts`.** Each is a bug
the obvious implementation has. The load promise is module-scope, because StrictMode mounts
every effect twice and a per-component loader injects the script twice on first render.
`onYouTubeIframeAPIReady` is *chained*, never assigned — it is one global that YouTube calls
once, so assigning over it breaks whoever set it first and assigning after it has fired
waits forever. The script tag is never removed, because removing it does not unload
`window.YT` and re-adding it will not make the global fire again. And there is a hard 15 s
timeout, because media rule 1 leaves no fallback path, so the UI has to say so rather than
spin. Separately, `new YT.Player(el)` *replaces* the element it is given, so the mount point
is a plain `div` created imperatively inside a host `div` React owns — otherwise React's own
unmount throws `NotFoundError: removeChild`.

**For Stage 3.** `transcript_segments` will be the selection surface: text selection over the
synchronized view becomes an item's canonical form, and `item_occurrences` binds it back to
`(video_id, start_ms, end_ms)`. The correction projection built here — latest correction wins,
originals preserved — is the read model Stage 3 selects against, so an item cut from a
corrected line must reference the segment, never the projected text.
