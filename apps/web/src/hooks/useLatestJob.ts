import { useEffect, useState } from 'react';
import type { JobRecord } from '@p80/core/browser';
import { listJobs } from '../api.js';

/**
 * The most recent job of one type for one entity, or `null` if there is none.
 *
 * Exists because a chained job has no id anywhere the client can reach. `INGEST_MEDIA`
 * enqueues `TRANSCRIBE` inside the worker (`apps/worker/src/handlers/ingest-media.ts`),
 * so the `202 { video, jobId }` that started everything names the *ingest* job and cannot
 * name the transcribe one — it did not exist when that response was written. Before this
 * hook, a transcription that failed had no surface in the browser at all: the upload panel
 * saw its ingest job succeed and fell silent, and the video page rendered a fixed sentence
 * guessing at a cause.
 *
 * `null` is a real answer, not a not-yet. A succeeded ingest legitimately produces no
 * transcribe job — `transcribe: false` on the repair path, a deleted video, missing media,
 * or a duplicate re-point. Callers must render nothing in that case rather than waiting for
 * a job that is never coming.
 *
 * Single-shot per key, deliberately. Following the job's *progress* is `useJob`'s
 * responsibility; this only answers "which job", and re-polling that would be asking a
 * settled question over and over.
 */
export function useLatestJob(
  entityId: string | null,
  jobType: string,
): { job: JobRecord | null; settled: boolean } {
  const [job, setJob] = useState<JobRecord | null>(null);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    setJob(null);
    setSettled(false);
    if (entityId === null) return;

    let cancelled = false;
    listJobs({ entityId, jobType, limit: 1 })
      .then((jobs) => {
        if (cancelled) return;
        setJob(jobs[0] ?? null);
        setSettled(true);
      })
      .catch(() => {
        // A lookup that fails is not a job that failed. Report "nothing found" and let the
        // caller's existing copy stand, rather than inventing an error about an error.
        if (!cancelled) setSettled(true);
      });

    return () => {
      cancelled = true;
    };
  }, [entityId, jobType]);

  return { job, settled };
}
