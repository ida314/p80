/**
 * Job-poll pacing, as data rather than as a magic number in a hook.
 *
 * A transcript parse is usually well under a second, so the first few polls should be
 * quick — the user is watching. But a job can also be stuck behind a worker that is not
 * running (`pnpm dev` starts one, but the worker can crash), and a 250 ms poll that never
 * gives up is a busy loop against the API for as long as the tab is open.
 */

const SCHEDULE_MS = [250, 250, 500, 500, 1000, 1000, 2000, 3000, 5000] as const;

/** Past the schedule, hold at the last value rather than growing without bound — the user
 *  is entitled to notice within a few seconds whenever the job does finish. */
export function jobPollDelayMs(attempt: number): number {
  const index = Math.min(Math.max(0, Math.floor(attempt)), SCHEDULE_MS.length - 1);
  return SCHEDULE_MS[index] ?? 5000;
}

/**
 * When to stop polling and say so.
 *
 * A job still `pending` after two minutes is not slow, it is unclaimed — almost always
 * because no worker is running. Telling the user that is far more useful than a spinner,
 * and it is the failure mode a local-first application should expect to explain, since
 * there is no operations team to notice.
 */
export const JOB_STALL_CEILING_MS = 120_000;

export function isJobStalled(args: {
  status: string;
  elapsedMs: number;
}): boolean {
  return args.status === 'pending' && args.elapsedMs > JOB_STALL_CEILING_MS;
}

/**
 * How long to wait before re-sending a chunk that failed (ADR 0024).
 *
 * Pacing lives here for the same reason job polling does: it is a decision about how P80
 * behaves, it is pure, and a number buried in a hook is a number nobody tests.
 *
 * The shape is different from `jobPollDelayMs` because the failure is different. A poll is
 * asking "are you done yet" and the answer costs nothing; a chunk retry is re-sending eight
 * megabytes over the link that just dropped, so the first retry is deliberately slow enough
 * that a transient blip has ended, and growth is geometric rather than a fixed schedule —
 * a laptop that closed its lid is not going to be back in 250 ms.
 */
const UPLOAD_RETRY_BASE_MS = 1000;
const UPLOAD_RETRY_CEILING_MS = 30_000;

export function uploadRetryDelayMs(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt));
  return Math.min(UPLOAD_RETRY_BASE_MS * 2 ** n, UPLOAD_RETRY_CEILING_MS);
}

/**
 * Attempts against a single chunk before the upload stops and shows the error.
 *
 * Bounded rather than infinite: an upload that cannot make progress should say so, because
 * the session survives on the server and the user can resume it later. Retrying forever
 * would hide a real refusal behind a progress bar that never moves.
 */
export const UPLOAD_MAX_CHUNK_ATTEMPTS = 6;
