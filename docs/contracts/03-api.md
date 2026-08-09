# 03 — API Surface

Source: original spec §29. Fastify + Zod, bound to loopback only (§32.5).

## 1. Conventions

- Base path `/api`. All request and response bodies are JSON.
- Every request body and query string is validated with Zod at the route boundary. A
  route handler never sees unvalidated input.
- **This surface is the only interface any client has.** Two clients exist — a TUI for
  management surfaces and a browser app for media surfaces (ADR 0007) — and neither holds
  domain logic. A response must therefore carry everything needed to render it; a client
  must never have to recompute a score, a schedule, or a session plan.
- MVP has one profile. Endpoints do not take a profile ID; the server resolves the single
  profile. Handlers still pass `profileId` down into the service layer so that adding
  multiple profiles later is a routing change, not a rewrite.

### Error envelope

```jsonc
{
  "error": {
    "code": "TRANSCRIPT_PARSE_FAILED",
    "message": "Human-readable, safe to display.",
    "details": { },          // optional, structured, never contains secrets
    "retryable": false
  }
}
```

Rules: stable `SCREAMING_SNAKE_CASE` codes; API keys and provider credentials are
redacted before an error leaves the service layer (§32.3); provider failures surface as
actionable errors, never as fabricated success (§27.4).

### Long-running work

Any endpoint that starts pipeline work returns `202` with a job reference rather than
blocking:

```jsonc
{ "jobId": "01J...", "status": "pending" }
```

Progress is polled through `/api/jobs/:id`.

---

## 2. Profile and interests

```
GET    /api/profile
PUT    /api/profile
POST   /api/profile/placement          # submit placement responses; initializes P(known) bands
GET    /api/profile/stats

GET    /api/interests
POST   /api/interests
PUT    /api/interests/:id
DELETE /api/interests/:id
```

`POST /api/profile/placement` body:

```ts
{
  mode: "fast" | "calibrated";
  proficiencyLabel?: "beginner" | "lower_intermediate" | "intermediate"
                   | "upper_intermediate" | "advanced";   // fast mode
  responses?: Array<{ lemma: string; band: number;
                      response: "know" | "unsure" | "do_not_know" }>;  // calibrated mode
}
```

Writes `placement_results`, then `known_frequency_bands`. Never overwrites an existing
`known_lexicon` row whose source is `user_marked` or `review_derived` — placement is a
prior, and review data outranks it (§11.2).

## 2a. Settings <!-- ADDED (ADR 0019) -->

```
GET    /api/settings
PUT    /api/settings
POST   /api/settings/media-root/preflight
```

Not in spec §29, which has no settings surface. ADR 0019 adds one because two settings —
the media root and the ASR options — are changed often enough that a dotfile edit plus four
process restarts is the wrong shape for them.

`GET /api/settings` returns **both tiers**. Each row carries `tier` (`live` | `boot`),
`value`, `source` (`environment` | `database`), `environmentValue`, `editable`,
`description`, and `control`. Boot-tier rows are included rather than hidden: a settings
page that omits the port it is served on is one the user will not trust, and the reason each
is read-only is more useful shown than implied.

`PUT /api/settings` takes `{ settings: Record<string, string | number | boolean>,
acknowledgeOrphans?: boolean }`. A batch, because the ASR options are edited together. Every
key is validated before any is written, so a request either fails before touching anything
or applies everything it named. A boot-tier or unknown key is `400 SETTING_NOT_EDITABLE`
with `details.reason` distinguishing the two — a read-only setting and a typo mean different
things to whoever sent it.

**`P80_ALLOW_LAN` and `P80_BIND_HOST` are not writable, and that is a security property
rather than a restart problem.** §32.5 makes LAN exposure an opt-in act with a warning; a
browser-reachable toggle would be a weaker guarantee than the one the spec asks for.

**The media root gets three extra gates** (ADR 0019 §3–4), because it is the containment
root that `04-providers.md` rule 4 assumes is trusted configuration:

- It must be an absolute path to an existing readable directory, and it must not be the
  filesystem root, a system directory, or inside `P80_STORAGE_PATH`. Otherwise
  `400 INVALID_MEDIA_ROOT` with `details.reason`. The refusal list is not a security
  boundary and is not claimed as one — loopback binding and strict CORS are.
- A change that would leave any video unable to resolve its file is
  `409 MEDIA_ROOT_WOULD_ORPHAN` unless the body carries `acknowledgeOrphans: true`.
  `details` carries `videoCount`, `resolved`, `orphaned`, and a bounded `orphanedSample`.
  Same shape as `TRANSCRIPT_ALREADY_EXISTS` requiring `replace: true`: the cost is counted,
  stated, and then paid deliberately. Nothing is destroyed — setting the root back restores
  playback exactly.
- After a successful change, `videos.media_missing` is recomputed for every video, so the
  library list is truthful immediately rather than one click at a time.

`POST /api/settings/media-root/preflight` takes `{ path }` and returns the same counts
without writing anything. Like `POST .../transcript/preview`, it reports a **rejection
inside a `200`** — the field is still being typed, and a 4xx would leave the surface with
nothing to render.

Live-tier values are read at the point of use, per request and per job. No process caches
one, which is what removes the window in which the API validates a path against one media
root while the worker resolves it against another.

## 3. Videos

```
GET    /api/videos
POST   /api/videos                     # path + title + interests; 202 + ingest jobId
GET    /api/videos/:id
PUT    /api/videos/:id
DELETE /api/videos/:id
GET    /api/videos/:id/media           # ADDED: byte-range media stream
POST   /api/videos/:id/media/repair    # ADDED: re-point a moved file
POST   /api/videos/:id/transcript      # upload VTT/SRT or paste timestamped text
GET    /api/videos/:id/transcript
GET    /api/videos/:id/transcript/words # ADDED: word-level timing, when the tier has it
POST   /api/videos/:id/transcript/preview   # ADDED: parse without persisting
PUT    /api/videos/:id/transcript/segments/:segmentId   # ADDED: correction
DELETE /api/videos/:id/transcript      # ADDED: deletion and replacement
POST   /api/videos/:id/process         # 202 + jobId
POST   /api/videos/:id/recalculate     # 202 + jobId
GET    /api/videos/:id/items
GET    /api/videos/:id/recommendations
```

<!-- RESOLVED (ADR 0015): the spec's `POST /api/videos` takes a URL and extracts a video ID.
     There is no URL and no external ID. It takes a path relative to `P80_MEDIA_ROOT`. -->

**`POST /api/videos` takes a path and returns `202 { video, jobId }`.** The body is
`{ path, title?, speakerLabel?, regionLabel?, interests? }`. The path is validated
structurally and for containment under `P80_MEDIA_ROOT`, and the file's existence is checked
— but it is not read. Hashing and duration probing cost seconds on a large file and belong in
the `INGEST_MEDIA` job, which the response's `jobId` refers to. That job computes the content
hash (ADR 0018), fills in the duration, and enqueues `TRANSCRIBE` (ADR 0016).

A path that escapes the root is `400 INVALID_MEDIA_PATH`. A path that does not exist is
`404 MEDIA_FILE_NOT_FOUND`. Both name the offending path back to the caller, which is safe
because the caller supplied it — but the message is the *relative* path, never the resolved
absolute one, which would disclose the root's location to a client that has no business
knowing it.

**`GET /api/videos/:id/media` is the only route that reads media bytes.** It resolves
`videos.media_path` under `P80_MEDIA_ROOT`, refuses anything outside, supports HTTP Range
because `<video>` needs it to seek, and streams rather than buffering. A missing file is a
`404 MEDIA_FILE_NOT_FOUND` and sets `videos.media_missing`; it is never a cached duplicate,
because P80 copies no media (`04-providers.md` §1, rule 3).

This route serves bytes rather than JSON, so it is the one exception to the error envelope
in §1 for its success path. Errors still use the envelope.

**`POST /api/videos/:id/media/repair`** takes `{ path }` and re-points a video whose file
moved. It re-hashes and refuses a mismatch with `409 MEDIA_CONTENT_MISMATCH`, naming both
hashes — accepting a different file would silently rebind a transcript to audio it does not
match (ADR 0018 §3).

**`GET /api/videos/:id/transcript/words`** returns the word array with per-word timing for a
transcript at `timing_granularity = 'word'`, and `409 TRANSCRIPT_TIMING_UNAVAILABLE` for one
at `'cue'`. A separate route rather than an expansion of the transcript response: a one-hour
video is roughly 9,000 words, which no consumer of the segment list wants by default.

`POST /api/videos/:id/transcript/preview` exists because §12.1 step 7 requires the user to
preview parsed segments *before* confirming — which the spec's endpoint list has no way
to do. It returns parsed segments plus parse warnings and persists nothing.

`PUT .../segments/:segmentId` writes a `transcript_corrections` row and updates the
derived view; it never mutates the original `transcript_segments` row
(see `02-database.md`).

<!-- ADDED: not in original spec -->
`DELETE /api/videos/:id/transcript` exists because spec §35 Stage 2 step 15 requires
transcript deletion and replacement, which the endpoint list above has no other way to
express. It returns `{ deletedSegments, deletedCorrections, deletedFiles, cancelledJobs }`.

**Ingestion is asynchronous, and replacement is explicit.** Both resolve readings the spec
left open:

- `POST /api/videos/:id/transcript` writes the uploaded file to `P80_STORAGE_PATH`, records
  it in `transcript_files`, sets `transcript_status = 'parsing'`, and returns
  **`202 { jobId, status, transcriptFileId }`**. A `PARSE_TRANSCRIPT` job does the parsing.
  This follows §1's rule that work starting a pipeline returns a job reference, §12.1 step 9
  (*"ingestion job begins"*), and §7.2 (*"store uploaded transcript files locally"*). The
  request body is JSON — `{ content, filename?, format?, replace }` — not multipart, which
  removes a dependency and keeps an untrusted filename away from any code path that could
  make it a file path. `format` is a hint; the content decides.
- A second upload for a video that already has a transcript is **`409
  TRANSCRIPT_ALREADY_EXISTS`** unless the body carries `replace: true`. Replacing discards
  corrections, so the cost is stated before it is paid; the uploaded files themselves stay
  on disk, which keeps the source recoverable. An identical checksum is
  `409 TRANSCRIPT_DUPLICATE_UPLOAD` even under `replace` (§14.1, *duplicate upload*).
- `POST .../transcript/preview` returns a **validation** failure inside a `200`, in
  `validation.fatal`. Showing the user what is wrong before they commit is the endpoint's
  entire purpose, and a 4xx would leave the preview screen with nothing to render. Only an
  unrecognized *format* is a `400`, because then there is nothing to preview.
- **No filesystem path appears in any response**, including `jobs.input_json` and
  `jobs.output_json`, which `GET /api/jobs/:id` returns verbatim. Job payloads carry
  `transcriptFileId`; the worker resolves the path itself.

<!-- ADDED: not in original spec -->
Stage 2 error codes, beyond the envelope example: `INVALID_MEDIA_PATH` (400, with
`details.reason`), `MEDIA_FILE_NOT_FOUND` (404), `MEDIA_CONTENT_MISMATCH` (409, with both
hashes), `UNSUPPORTED_MEDIA_SOURCE` (400), `DUPLICATE_VIDEO` (409, with the
existing `videoId` so a client can navigate to it), `TRANSCRIPT_ALREADY_EXISTS` (409),
`TRANSCRIPT_TIMING_UNAVAILABLE` (409), `ASR_UNAVAILABLE` (503, with the sidecar's reason),
`TRANSCRIPT_DUPLICATE_UPLOAD` (409), `TRANSCRIPT_NOT_READY` (409),
`TRANSCRIPT_HAS_CORRECTIONS` (409), `TRANSCRIPT_FORMAT_UNRECOGNIZED` (400),
`TRANSCRIPT_TOO_LARGE` (413), `TRANSCRIPT_NO_SEGMENTS` (422),
`TRANSCRIPT_INVALID_TIMESTAMPS` (422), `TRANSCRIPT_PARSE_FAILED` (422),
`TRANSCRIPT_FILE_CORRUPT` (500, not retryable).

Stage 2b error codes (ADR 0019): `SETTING_NOT_EDITABLE` (400, with `details.reason` of
`boot_tier` or `unknown_key`), `INVALID_MEDIA_ROOT` (400, with a `MediaRootRejection` in
`details.reason`), `MEDIA_ROOT_WOULD_ORPHAN` (409, with the counts).

Response shapes for this surface are defined once, as Zod schemas in
`packages/core/src/api-types.ts`, and are imported by both the API's route schemas and the
web client. The spec gives paths but no bodies; hand-mirroring them in the client drifts
silently.

## 4. Candidates

A candidate is a **promoted** observed unit (ADR 0008), so this surface is a *queue*, not
the full set of everything extraction found. The unsurfaced pool is reachable through §4.1.

```
GET    /api/candidates                 # THE QUEUE: global, ranked by importance DESC,
                                       # across all videos. Filters: status, type,
                                       # videoId, minScore, minConfidence, cursor, limit
GET    /api/candidates/:id
PUT    /api/candidates/:id             # edit canonical form, type, meaning, translation,
                                       # register, region, occurrence boundaries
POST   /api/candidates/:id/approve     # body: { prioritize?: boolean }
POST   /api/candidates/:id/reject      # body: { reason: RejectionReason, note?: string }
POST   /api/candidates/:id/mark-known
POST   /api/candidates/:id/defer
POST   /api/candidates/:id/merge       # body: { targetItemId } | { targetCandidateId }
POST   /api/candidates/:id/split       # body: { splits: [...] }
POST   /api/candidates/batch           # body: { ids: string[], action, reason? }
```

`approve` with `prioritize: true` is §25.2's "Approve and prioritize": it applies a
source-salience boost (`06-scoring.md` §2.7).

`mark-known` writes `known_lexicon` (source `user_marked`) and closes the candidate. It
does **not** create a learning item or any card.

`merge` must reject with `409 SENSE_CONFLICT` when the two sides carry different
`senseKey` values (`01-domain-model.md` §7, invariant 4).

`POST /api/candidates/batch` requires an explicit `ids` array. There is no
"apply to all matching the current filter" form — §25.3 requires batch approval to stay a
deliberate act, and an implicit filter-wide apply is not one.

### 4.0 Queue semantics

`GET /api/candidates` returns **one global ranked queue across all videos**, not a per-video
list. It is a cursor, not a list to empty: the user works down it until they have enough new
items and stops. Defaulting the client to "unread count" framing would fight the product's
own thesis of the *smallest* high-value curriculum (§1).

Every response carries `surfaceReason` so the client can render probe rows distinctly and
so probe outcomes stay separable in analysis (`06-scoring.md` §8.2).

A candidate with `enrichedAt: null` is valid and must render — promoted but not yet
enriched, marked as such. Provider failure during enrichment leaves it in this state
permanently until retried; it is never dropped and never given a fabricated definition
(§27.4).

### 4.1 The observed pool <!-- ADDED: required by ADR 0008 -->

```
GET    /api/observed                   # browse/search the full pool; same filters as
                                       # /api/items, plus: language, minScore, videoId,
                                       # unitType, surfaced (bool)
GET    /api/observed/:id               # includes occurrences and score breakdown
POST   /api/observed/:id/promote       # force into the inbox; enriches on demand
GET    /api/observed/saturation        # new units per minute, by unit type and language
```

**Without these endpoints the architecture reduces to filtering that also pays for
storage.** If nothing below the surfacing threshold can be found, "soft filtering" is a
distinction without a difference. This is the surface that makes recall-first real, and it
is a requirement rather than a convenience.

`POST /api/observed/:id/promote` triggers `ENRICH_CANDIDATE` synchronously enough that
inspecting a tail unit is never blocked by the absence of a definition.

`GET /api/observed/saturation` backs a diagnostic, not a success metric — §31.5's ban on
optimizing for extracted-token counts still holds. Nothing should try to raise it.

## 5. Items

```
POST   /api/items                      # ADDED (ADR 0020): create one from a selection
GET    /api/items                      # filters per §10.6
GET    /api/items/:id
PUT    /api/items/:id
POST   /api/items/:id/suspend
POST   /api/items/:id/unsuspend
POST   /api/items/:id/star
GET    /api/items/:id/occurrences
GET    /api/items/:id/history          # reviews + definition edits + provenance
```

`GET /api/items/:id` includes the projected `SkillState` for each card type and the
score breakdown that admitted the item (§36.3). Every card type appears in `skills`,
including types with no card — that is what `not_started` is for, and omitting the key
would leave a client to guess.

### 5.1 `POST /api/items` <!-- ADDED: ADR 0020 -->

In the finished system an item arrives through `POST /api/candidates/:id/approve`. This is
the other way in: a person selects transcript text and describes it by hand.

**The body carries a selection, never a timing.**

```ts
{
  videoId: string;
  selection: {
    segmentIds: string[];   // the touched segments, in reading order
    spanStart: number;      // character offsets into those segments joined by one space
    spanEnd: number;
  };
  canonicalForm: string;
  itemType: LearningItemType;
  meaning: string;          // the user's own gloss
  translation?: string;     // optional — a forced translation is a confident wrong answer
  register?: Register;
  lemma?: string; partOfSpeech?: string; dialectRegion?: string;
  offensiveOrSensitive?: boolean;
  includeAudioCard?: boolean;   // overrides for §2's two judgement calls
  includeClozeCard?: boolean;
}
```

The server resolves the offsets against `transcript_words` and derives the clip window; a
client-supplied `startMs` would be unverifiable and would put a decision about what a clip
is into a browser. Offsets that do not resolve are `400 INVALID_SELECTION` — never clamped,
because a clamped selection anchors the item to text nobody highlighted.

This is not an exception to §7.3. That rule keeps the *pipeline* from admitting its own
output; every field here was typed by a person.

Three further consequences, all argued in ADR 0020:

- `senseKey` is slugified from `meaning`. A collision on the identity constraint is
  `409 ITEM_SENSE_EXISTS`, naming the existing item — never auto-suffixed.
- The occurrence anchors to a `sentences` row derived from the touched segments.
  **Stage 4's reconstruction must relink rather than delete and rebuild.**
- The three ranking scores are `0` as a placeholder. The response carries `unscored: true`
  so a client cannot read them as a judgement.

## 6. Review

```
POST   /api/review/session             # body: SessionRequest → session id + plan
GET    /api/review/session/:id/next
POST   /api/review/session/:id/answer  # response text/latency; no schedule change yet
POST   /api/review/session/:id/rate    # scheduler rating; advances FSRS
POST   /api/review/session/:id/hint
POST   /api/review/session/:id/complete
GET    /api/review/due
GET    /api/review/forecast            # burden over the next 7 days
```

`answer` and `rate` are separate calls on purpose. `answer` records the retrieval attempt
and its latency before the answer is revealed; `rate` records the user's judgement after.
Collapsing them would make it impossible to distinguish a rep from a restudy (§9.9) or to
measure response latency honestly (§23.1).

### Video loop <!-- ADDED -->

```
POST   /api/review/video-loop                    # start; body: { videoId, startMs, endMs }
POST   /api/review/video-loop/:id/comprehension  # before/after rating
POST   /api/review/video-loop/:id/summary        # typed or recorded summary
POST   /api/review/video-loop/:id/complete
```

§21 and Stage 11 define the video loop as a first-class activity with stored results, but
§29 gives it no endpoints.

## 7. Recommendations

```
GET    /api/recommendations
POST   /api/recommendations/:id/accept
POST   /api/recommendations/:id/dismiss
POST   /api/recommendations/:id/feedback   # body: { feedback: RecommendationFeedback }
```

Every recommendation response carries `reason_json` in a displayable form. §36.6 requires
recommendations to be explainable, so an unexplained recommendation is a bug.

## 8. Jobs and diagnostics

```
GET    /api/jobs                       # filters: status, type, entityId
GET    /api/jobs/:id
POST   /api/jobs/:id/retry
POST   /api/jobs/:id/cancel
GET    /api/diagnostics/providers      # configured providers, reachability, usage, cost
GET    /api/diagnostics/pipeline       # per-stage counts and timings for a video
GET    /api/diagnostics/provider-calls # ADDED: prompt/output inspection (§10.7, §16.4)
GET    /api/health                     # ADDED: Stage 1 exit criterion
```

## 9. Data portability

```
POST   /api/export                     # 202 + jobId; JSON full export
POST   /api/import
DELETE /api/data                       # requires explicit confirmation token in body
GET    /api/export/:jobId/download
```

`DELETE /api/data` requires a confirmation token obtained from a prior `GET` so that a
stray request cannot destroy a learner's history.

## 10. Security posture

- Bind to `127.0.0.1`. LAN exposure is opt-in and shows a warning first (§32.5).
- Strict CORS: reject non-loopback origins by default.
- Transcript text is untrusted (§32.6). It is escaped on render, never interpolated into
  system prompts, and never used to build a URL or command.
- No endpoint returns an API key, and no endpoint accepts one.
