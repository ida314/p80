import {
  ERROR_CODES,
  P80Error,
  TERMINAL_JOB_STATES,
  newId,
  now,
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
    .prepare(`SELECT * FROM jobs ${clause} ORDER BY created_at DESC LIMIT ?`)
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
             ${typeFilter}
           ORDER BY priority DESC, created_at ASC
           LIMIT 1
        )
      RETURNING *`,
    )
    .get(workerId, ts, ts, ...(eligibleTypes ?? [])) as JobRow | undefined;

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
 * Records a failure. A job with attempts remaining returns to `pending` so the loop
 * retries it; one that has exhausted them stays `failed`, inspectable, with its error
 * preserved (§27.3, §27.4). Completed stages are never rolled back and no fallback
 * result is fabricated.
 */
export function failJob(handle: DatabaseHandle, id: string, error: unknown): JobState {
  const job = getJob(handle, id);
  if (!job) throw P80Error.notFound('Job', { id });

  const exhausted = job.attemptCount >= job.maxAttempts;
  const status: JobState = exhausted ? 'failed' : 'pending';
  const payload = {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : 'Error',
    attempt: job.attemptCount,
  };

  handle.sqlite
    .prepare(
      `UPDATE jobs
          SET status = ?, error_json = ?, claimed_by = NULL, claimed_at = NULL,
              completed_at = ?
        WHERE id = ?`,
    )
    .run(status, JSON.stringify(payload), exhausted ? now() : null, id);

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
      `UPDATE jobs
          SET status = 'pending', attempt_count = 0, error_json = NULL,
              claimed_by = NULL, claimed_at = NULL, started_at = NULL,
              completed_at = NULL
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
