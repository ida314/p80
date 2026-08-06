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

## 3. Videos

```
GET    /api/videos
POST   /api/videos                     # url + title + interests; extracts video ID
GET    /api/videos/:id
PUT    /api/videos/:id
DELETE /api/videos/:id
POST   /api/videos/:id/transcript      # upload VTT/SRT or paste timestamped text
GET    /api/videos/:id/transcript
POST   /api/videos/:id/transcript/preview   # ADDED: parse without persisting
PUT    /api/videos/:id/transcript/segments/:segmentId   # ADDED: correction
POST   /api/videos/:id/process         # 202 + jobId
POST   /api/videos/:id/recalculate     # 202 + jobId
GET    /api/videos/:id/items
GET    /api/videos/:id/recommendations
```

`POST /api/videos/:id/transcript/preview` exists because §12.1 step 7 requires the user to
preview parsed segments *before* confirming — which the spec's endpoint list has no way
to do. It returns parsed segments plus parse warnings and persists nothing.

`PUT .../segments/:segmentId` writes a `transcript_corrections` row and updates the
derived view; it never mutates the original `transcript_segments` row
(see `02-database.md`).

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
score breakdown that admitted the item (§36.3).

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
