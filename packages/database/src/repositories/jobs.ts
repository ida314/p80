import {
  ERROR_CODES,
  P80Error,
  TERMINAL_JOB_STATES,
  newId,
  now,
  retryAvailableAt,
  type JobRecord,
  type JobState,
  type JobType,
} from '@p80/core';
import type { DatabaseHandle } from '../client.js';

/**
 * Job storage.
 *
 * This repository uses raw SQL rather than the query builder, deliberately and only
 * here: the claim in `claimNextJob` has to be a single atomic statement, and
 * `UPDATE ... WHERE id = (SELECT ... LIMIT 1) RETURNING *` is not expressible through
 * Drizzle. Splitting it into a select-then-update would let two workers claim the same
 * job, which is the one bug this loop exists to avoid.
 */

interface JobRow {
  id: string;
  job_type: string;
  entity_type: string | null;
  entity_id: string | null;
  status: string;
  attempt_count: number;
  max_attempts: number;
  priority: number;
  input_json: string | null;
  output_json: string | null;
  error_json: string | null;
  claimed_by: string | null;
  claimed_at: number | null;
  created_at: number;
  started_at: number | null;
  completed_at: number | null;
  available_at: number | null;
}

function toRecord(row: JobRow): JobRecord {
  return {
    id: row.id,
    jobType: row.job_type as JobType,
    entityType: row.entity_type,
    entityId: row.entity_id,
    status: row.status as JobState,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    priority: row.priority,
    inputJson: row.input_json ? JSON.parse(row.input_json) : null,
    outputJson: row.output_json ? JSON.parse(row.output_json) : null,
    errorJson: row.error_json ? JSON.parse(row.error_json) : null,
    claimedBy: row.claimed_by,
    claimedAt: row.claimed_at,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    availableAt: row.available_at,
  };
}

export interface EnqueueOptions {
  entityType?: string;
  entityId?: string;
  priority?: number;
  maxAttempts?: number;
  input?: unknown;
}

/** The single write path into `jobs`. */
export function enqueueJob(
  handle: DatabaseHandle,
  jobType: JobType,
  options: EnqueueOptions = {},
): JobRecord {
  const id = newId();
  handle.sqlite
    .prepare(
      `INSERT INTO jobs
         (id, job_type, entity_type, entity_id, status, attempt_count, max_attempts,
          priority, input_json, created_at)
       VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      jobType,
      options.entityType ?? null,
      options.entityId ?? null,
      options.maxAttempts ?? 3,
      options.priority ?? 0,
      options.input === undefined ? null : JSON.stringify(options.input),
      now(),
    );
  return getJob(handle, id)!;
}

export function getJob(handle: DatabaseHandle, id: string): JobRecord | null {
  const row = handle.sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as
    | JobRow
    | undefined;
  return row ? toRecord(row) : null;
}

export interface ListJobsFilter {
  status?: JobState;
  jobType?: JobType;
  entityId?: string;
  limit?: number;
}

export function listJobs(
  handle: DatabaseHandle,
  filter: ListJobsFilter = {},
): JobRecord[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.status) {
    where.push('status = ?');
    params.push(filter.status);
  }
  if (filter.jobType) {
    where.push('job_type = ?');
    params.push(filter.jobType);
  }
  if (filter.entityId) {
    where.push('entity_id = ?');
    params.push(filter.entityId);
  }
  const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const rows = handle.sqlite
    // `id DESC` breaks the tie rather than leaving it to the query planner. `created_at`
    // is milliseconds, and callers use `limit=1` on this route to mean "the current
    // attempt" — with two rows in one millisecond that answer would otherwise be
    // arbitrary. Ids are ULIDs, so they are monotonic within a millisecond and sort
    // lexicographically: newest really is last.
    .prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, filter.limit ?? 50) as JobRow[];
  return rows.map(toRecord);
}

/**
 * Claims the highest-priority pending job, atomically.
 *
 * The `UPDATE ... WHERE id = (SELECT ...)` shape means the read and the write happen in
 * one statement under one write lock, so two workers racing produce exactly one winner
 * and one `null` — verified in `test/claim.test.ts` rather than assumed.
 */
export function claimNextJob(
  handle: DatabaseHandle,
  workerId: string,
  eligibleTypes?: readonly JobType[],
): JobRecord | null {
  const ts = now();
  const typeFilter =
    eligibleTypes && eligibleTypes.length > 0
      ? `AND job_type IN (${eligibleTypes.map(() => '?').join(',')})`
      : '';

  const row = handle.sqlite
    .prepare(
      `UPDATE jobs
          SET status = 'running',
              claimed_by = ?,
              claimed_at = ?,
              started_at = COALESCE(started_at, ?),
              attempt_count = attempt_count + 1
        WHERE id = (
          SELECT id FROM jobs
           WHERE status = 'pending'
             AND attempt_count < max_attempts
             -- A retry serving its backoff is not claimable yet (ADR 0027). Null is the
             -- ordinary case and means now, so nothing enqueued has to set it.
             AND (available_at IS NULL OR available_at <= ?)
             ${typeFilter}
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
        )
      RETURNING *`,
    )
    .get(workerId, ts, ts, ts, ...(eligibleTypes ?? [])) as JobRow | undefined;

  return row ? toRecord(row) : null;
}

export function completeJob(
  handle: DatabaseHandle,
  id: string,
  output?: unknown,
): void {
  handle.sqlite
    .prepare(
      `UPDATE jobs
          SET status = 'succeeded', output_json = ?, error_json = NULL, completed_at = ?
        WHERE id = ?`,
    )
    .run(output === undefined ? null : JSON.stringify(output), now(), id);
}

/**
 * Records a failure (ADR 0027).
 *
 * Three questions, answered separately because they used to be answered as one:
 *
 * - **Is it worth retrying?** A `P80Error` says so itself, and the answer is believed. A
 *   501 `ASR_UNAVAILABLE` is a setup problem; waiting changes nothing about which libraries
 *   were compiled in, and running it twice more only buries the real message under two
 *   duplicates. Anything that is *not* a `P80Error` is an unknown, and an unknown is
 *   retried — `retryable` defaults to `false`, so reading the field off every error would
 *   silently make one attempt the rule for ordinary bugs.
 * - **Are there attempts left?** Unchanged: `attempt_count` against `max_attempts`.
 * - **When may it run again?** Not immediately. See `retryAvailableAt`.
 *
 * Completed stages are never rolled back and no fallback result is fabricated (§27.3,
 * §27.4). The stored error keeps its `code`, `retryable`, and `details` as well as its
 * message, because a client that can only read prose cannot tell a refusal from a fault.
 */
export function failJob(handle: DatabaseHandle, id: string, error: unknown): JobState {
  const job = getJob(handle, id);
  if (!job) throw P80Error.notFound('Job', { id });

  const retryable = error instanceof P80Error ? error.retryable : true;
  const exhausted = job.attemptCount >= job.maxAttempts;
  const status: JobState = retryable && !exhausted ? 'pending' : 'failed';
  const ts = now();

  const payload = {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
    attempt: job.attemptCount,
    ...(error instanceof P80Error
      ? { code: error.code, retryable: error.retryable, details: error.details }
      : {}),
    // Recorded even when it is null, so "this one is not coming back" is a fact in the row
    // rather than something inferred from the absence of a field.
    ...(status === 'pending' ? {} : { willRetry: false as const }),
  };

  handle.sqlite
    .prepare(
      `UPDATE jobs
          SET status = ?, error_json = ?, claimed_by = NULL, claimed_at = NULL,
              completed_at = ?, available_at = ?
        WHERE id = ?`,
    )
    .run(
      status,
      JSON.stringify(payload),
      status === 'pending' ? null : ts,
      status === 'pending' ? retryAvailableAt(job.attemptCount, ts) : null,
      id,
    );

  return status;
}

export function cancelJob(handle: DatabaseHandle, id: string): JobRecord {
  const job = getJob(handle, id);
  if (!job) throw P80Error.notFound('Job', { id });
  if (TERMINAL_JOB_STATES.includes(job.status)) {
    throw P80Error.conflict(
      ERROR_CODES.JOB_NOT_CANCELLABLE,
      `Job is already ${job.status} and cannot be cancelled.`,
      { id, status: job.status },
    );
  }
  handle.sqlite
    .prepare(
      `UPDATE jobs SET status = 'cancelled', completed_at = ?, claimed_by = NULL,
              claimed_at = NULL WHERE id = ?`,
    )
    .run(now(), id);
  return getJob(handle, id)!;
}

/** Retry resets the attempt counter — the user is asking for a fresh run, usually after
 *  fixing whatever caused the failure. */
export function retryJob(handle: DatabaseHandle, id: string): JobRecord {
  const job = getJob(handle, id);
  if (!job) throw P80Error.notFound('Job', { id });
  if (!TERMINAL_JOB_STATES.includes(job.status)) {
    throw P80Error.conflict(
      ERROR_CODES.JOB_NOT_RETRYABLE,
      `Job is ${job.status}; only a finished job can be retried.`,
      { id, status: job.status },
    );
  }
  handle.sqlite
    .prepare(
      // `available_at` is cleared too: the user is asking for it *now*, and leaving a
      // backoff in place would make the button look broken for half a minute.
      `UPDATE jobs
          SET status = 'pending', attempt_count = 0, error_json = NULL,
              claimed_by = NULL, claimed_at = NULL, started_at = NULL,
              completed_at = NULL, available_at = NULL
        WHERE id = ?`,
    )
    .run(id);
  return getJob(handle, id)!;
}

/**
 * Returns jobs whose worker died mid-run to the pending pool.
 *
 * `attempt_count` is not reset: a job that reliably kills its worker should exhaust its
 * attempts and stop rather than crash-loop forever.
 */
export function reclaimStaleJobs(handle: DatabaseHandle, staleAfterMs: number): number {
  const cutoff = now() - staleAfterMs;
  const result = handle.sqlite
    .prepare(
      `UPDATE jobs
          SET status = 'pending', claimed_by = NULL, claimed_at = NULL
        WHERE status = 'running' AND claimed_at IS NOT NULL AND claimed_at < ?`,
    )
    .run(cutoff);
  return result.changes;
}
