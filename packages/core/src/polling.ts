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
