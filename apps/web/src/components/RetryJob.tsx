import { useState } from 'react';
import { ApiError, retryJob } from '../api.js';

interface Props {
  jobId: string;
  /** What the job does, in the user's terms — "Transcribe again", not "Retry TRANSCRIBE". */
  label: string;
  /** Whether the failure said retrying could help. `false` does not hide the button: the
   *  user may have just fixed the cause, which is the whole reason a manual retry exists. */
  retryable: boolean;
  /** Called once the job is queued again, so the page can start following it. */
  onRetried: () => void;
}

/**
 * `POST /api/jobs/:id/retry`, given a surface at last.
 *
 * The route has existed since Stage 1 and nothing called it. That was invisible until a
 * sidecar lost its ASR package: the transcription failed, the sidecar was fixed, and the
 * browser's only offer was "upload a transcript instead" — the one path that throws away
 * the thing the user was trying to do. Recovery meant `curl`.
 *
 * A non-retryable failure still gets the button, and says why it stopped early. `retryable:
 * false` means *waiting* will not help (ADR 0027); it says nothing about whether the person
 * reading it has since installed the missing model. Hiding the button there would be
 * treating the scheduler's rule as a rule about the user.
 */
export function RetryJob({ jobId, label, retryable, onRetried }: Props) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const run = async () => {
    setProblem(null);
    setBusy(true);
    try {
      await retryJob(jobId);
      onRetried();
    } catch (caught: unknown) {
      // A 409 here means something else already restarted it, which is not a failure the
      // user needs to act on — but it is not a success either, so it is said rather than
      // swallowed.
      setProblem(
        caught instanceof ApiError ? caught.message : 'Could not queue it again.',
      );
      setBusy(false);
    }
  };

  return (
    <>
      <p>
        <button type="button" disabled={busy} onClick={() => void run()}>
          {busy ? 'Queueing…' : label}
        </button>
      </p>
      {!retryable && (
        <p className="hint">
          This stopped after one attempt: the error said trying again on its own would not
          help. Fix the cause first — running it again unchanged will fail the same way.
        </p>
      )}
      {problem !== null && <p className="hint hint--warning">{problem}</p>}
    </>
  );
}

/** Whether a recorded failure said retrying could help. Defaults to `true` for anything
 *  that does not say — an unknown is not a refusal, which is the same reading `failJob`
 *  takes on the server (ADR 0027). */
export function failureIsRetryable(errorJson: unknown): boolean {
  if (errorJson !== null && typeof errorJson === 'object' && 'retryable' in errorJson) {
    return (errorJson as { retryable: unknown }).retryable !== false;
  }
  return true;
}
