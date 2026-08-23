import type { JobProgress } from '../hooks/useJob.js';
import { RetryJob, failureIsRetryable } from './RetryJob.js';

interface Props {
  progress: JobProgress;
  /** What the job is doing, in the user's terms — "Reading your transcript", not
   *  "PARSE_TRANSCRIPT". */
  label: string;
  /** Called once a failed job has been queued again. Omitting it hides the retry: a caller
   *  that cannot follow the new job should not offer to start one, or the page goes quiet
   *  at exactly the moment something is happening. */
  onRetried?: () => void;
}

/**
 * A job in flight, said out loud.
 *
 * The two states worth designing for are the ones a spinner hides. **Stalled** means the
 * job is still `pending` long past when a running worker would have claimed it, which in a
 * local-first application almost always means the worker is not running — there is no
 * operations team to notice, so the app has to say it. **Failed** means the job's own error
 * envelope, shown rather than swallowed, because every job is inspectable
 * (`03-api.md` §8).
 */
export function JobStatus({ progress, label, onRetried }: Props) {
  const { job, stalled, error } = progress;

  if (error !== null) {
    return (
      <p role="alert" className="editor__problem">
        {error}
      </p>
    );
  }

  if (job === null) return <p className="hint">{label}…</p>;

  if (stalled) {
    return (
      <div role="alert" className="panel panel--error">
        <strong>Nothing has picked this up.</strong>
        <p>
          The job is queued but no worker has claimed it. That usually means the worker
          process is not running — <code>pnpm dev</code> starts it alongside everything
          else. Your upload is stored; it will be parsed as soon as a worker appears.
        </p>
      </div>
    );
  }

  if (job.status === 'failed') {
    return (
      <div role="alert" className="panel panel--error">
        <strong>{label} failed.</strong>
        <p>{describeFailure(job.errorJson)}</p>
        {onRetried !== undefined && (
          <RetryJob
            jobId={job.id}
            label="Try again"
            retryable={failureIsRetryable(job.errorJson)}
            onRetried={onRetried}
          />
        )}
        <p className="hint">
          The file you uploaded is still stored. Nothing was written to the transcript.
        </p>
      </div>
    );
  }

  if (job.status === 'cancelled') {
    return <p className="hint">{label} was cancelled.</p>;
  }

  if (job.status === 'succeeded') return null;

  return (
    <p className="hint">
      {label}… ({job.status})
    </p>
  );
}

/** `errorJson` is whatever the handler recorded. Rendered as text, and never assumed to
 *  have a shape — a job that failed in an unexpected way is exactly when a confident
 *  field access would throw and replace the message with a blank page.
 *
 *  Exported because the video page needs the same reading of `errorJson` but not the
 *  surrounding copy: `<JobStatus>` speaks in the upload flow's terms ("the file you
 *  uploaded"), which is wrong on a video that was added by path and never uploaded. */
export function describeFailure(errorJson: unknown): string {
  if (errorJson !== null && typeof errorJson === 'object' && 'message' in errorJson) {
    const message = (errorJson as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'The worker did not say why. Check the job in the TUI: `pnpm --filter @p80/tui dev jobs`.';
}
