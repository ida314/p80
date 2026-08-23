import { useEffect, useRef, useState } from 'react';
import { TERMINAL_JOB_STATES, isJobStalled, jobPollDelayMs } from '@p80/core/browser';
import type { JobRecord } from '@p80/core/browser';
import { getJob } from '../api.js';

export interface JobProgress {
  job: JobRecord | null;
  /** True once the job reached a terminal state — succeeded, failed, or cancelled. */
  settled: boolean;
  /** Still `pending` well past the point where a running worker would have claimed it.
   *  Almost always means no worker is running, which is worth saying rather than
   *  spinning about. */
  stalled: boolean;
  error: string | null;
}

/**
 * Follows a job to its conclusion (`03-api.md` §1: work that starts a pipeline returns a
 * job reference, and the client polls).
 *
 * The pacing schedule and the stall ceiling both live in `packages/core/src/polling.ts`
 * rather than here — they are decisions about how P80 behaves, they are unit-tested, and
 * the TUI needs the same numbers. This hook is the part that cannot be a pure function:
 * a timer and a cancellation flag.
 *
 * Polling stops at a terminal state, which is right until something restarts the job.
 * `nonce` is how a caller says that happened: a manual retry moves a settled job back to
 * `pending`, and without being told, this hook would sit on the old failure forever.
 */
export function useJob(jobId: string | null, nonce = 0): JobProgress {
  const [job, setJob] = useState<JobRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const startedAt = useRef(0);

  useEffect(() => {
    setJob(null);
    setError(null);
    setStalled(false);
    if (jobId === null) return;

    let cancelled = false;
    let timer = 0;
    let attempt = 0;
    startedAt.current = Date.now();

    const poll = async () => {
      try {
        const next = await getJob(jobId);
        if (cancelled) return;
        setJob(next);

        if ((TERMINAL_JOB_STATES as readonly string[]).includes(next.status)) return;

        const elapsedMs = Date.now() - startedAt.current;
        if (isJobStalled({ status: next.status, elapsedMs })) {
          setStalled(true);
          return;
        }

        attempt += 1;
        timer = window.setTimeout(() => void poll(), jobPollDelayMs(attempt));
      } catch (caught: unknown) {
        if (cancelled) return;
        // A failed poll is not a failed job. Say what happened and stop — retrying a
        // dead API in a loop produces a wall of identical console errors and no
        // information.
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    };

    void poll();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [jobId, nonce]);

  return {
    job,
    settled:
      job !== null && (TERMINAL_JOB_STATES as readonly string[]).includes(job.status),
    stalled,
    error,
  };
}
