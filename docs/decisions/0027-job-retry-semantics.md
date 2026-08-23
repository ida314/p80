# ADR 0027 — When a failed job runs again

**Status:** Accepted
**Date:** 2026-08-23
**Amends:** `02-database.md` (`jobs.available_at`), `03-api.md` §8 (what a failed job means)

## Context

`CLAUDE.md` names every job "idempotent, retryable, inspectable, and versioned", and spec
§27.3–4 require a failure to be preserved rather than papered over. Nothing anywhere says
*when* a retry runs, or what makes something worth retrying at all. The implementation
answered both questions the same way and got both wrong.

`failJob` decided purely on `attempt_count >= max_attempts`. The error it was handed was
stringified into the row and never inspected, so `P80Error.retryable` — a field the sidecar
adapter, the transcript parser, and the upload service all set deliberately — reached the
scheduler and was discarded.

The loop then sleeps only when it claimed *nothing*, and a failing tick still returns a job
id. So a returned-to-pending job was re-claimed on the next iteration with no delay.

Both halves showed up in one incident. A sidecar with no ASR extra installed answered
`501 ASR_UNAVAILABLE` — a setup problem, flagged `retryable: false` at source. The job
failed three times in **25 milliseconds** and surfaced as three identical errors on a video
whose file was fine. A user reading that sees a broken file; the truth was a missing Python
package. Meanwhile the genuinely transient case — a sidecar container still starting — gets
the same three attempts inside the same 25 ms, which outlasts nothing.

## Decision

### 1. A `P80Error` is believed; anything else is an unknown

`retryable: false` ends the job at the current attempt. The flag exists because the thrower
knows something the scheduler does not: whether waiting can change the answer. A 501 naming
a device this build cannot reach is not going to start working.

An error that is **not** a `P80Error` is retried as before. This asymmetry is deliberate and
is the whole reason the field could not simply be read off every error: `retryable` defaults
to `false`, so a naive `error.retryable` would silently make one attempt the rule for every
ordinary bug — a much larger change than the one intended, arriving disguised as a fix.

### 2. The wait belongs to the job, not to the worker

A failed job records `available_at`, and the claim query will not take it before then.

The obvious alternative is to sleep the worker after a failure. It is one line, and it makes
one job's backoff everybody's problem: a failing transcription would stall an unrelated
ingest for the same interval. A backoff is a property of the thing that failed. Putting it in
the row also means the wait survives a worker restart, and that the loop needs no change at
all — `claimNextJob` skips the row and the existing poll interval does the waiting.

`available_at` is nullable and null means *now*, so nothing that enqueues a job has to know
this exists.

### 3. Two waits, written down rather than computed

`RETRY_BACKOFF_MS = [5s, 30s]`, indexed by the attempt that just failed, last value
repeating. With `max_attempts` of 3 there are only ever two waits, and an explicit pair is
something an operator can predict from the source without evaluating a formula.

The interval is sized against what a retry here actually outlasts: a container coming back
up, or a model being loaded for the first time. Long enough to be worth waiting for, short
enough that a transient failure does not read as a hang.

### 4. A manual retry skips the wait

`POST /api/jobs/:id/retry` already resets the attempt counter. It clears `available_at` too.
The user is asking for it now, and a button that appeared to do nothing for thirty seconds
would be read as a broken button.

### 5. The stored error keeps its shape

`error_json` records `code`, `retryable`, and `details` alongside the message, and states
`willRetry: false` when the job is finished. A client that can only read prose cannot tell a
refusal from a fault, and the difference decides whether the user fixes their setup or
reports a bug.

## Consequences

- **Migration 0004** adds one nullable column and rebuilds `idx_jobs_claim` to include it.
  `ALTER TABLE ... ADD COLUMN` rewrites no rows and drops no table, so it stays clear of the
  cascade hazard that keeps the two deferred CHECK constraints deferred.
- **A non-retryable failure now fails on attempt 1**, so `attempt_count` on a failed job
  becomes evidence about the error's kind rather than always reading `max_attempts`.
- **An unregistered handler is non-retryable**, which it always was in fact.
- The sidecar's own classifications become load-bearing rather than decorative. They were
  already written with care — `assert_device` is retryable because a GPU is usually back
  after a driver reload, and a model that will not load is not — and nothing consumed them.
- **Nothing in the worker loop changed.** That is the argument for §2 rather than a summary
  of it: a backoff that needed the loop to cooperate would be a backoff the loop could
  forget.
