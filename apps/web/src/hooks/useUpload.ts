import { useCallback, useRef, useState } from 'react';
import { UPLOAD_MAX_CHUNK_ATTEMPTS, nextChunkPlan, uploadRetryDelayMs } from '@p80/core/browser';
import {
  ApiError,
  abortUpload,
  completeUpload,
  createUpload,
  getUpload,
  uploadChunk,
  type UploadSessionPayload,
  type VideoAcceptedPayload,
} from '../api.js';

/**
 * The chunk loop (ADR 0024 §3).
 *
 * One rule runs through all of it: **`receivedBytes` always comes from the server's
 * response, never from a count of what this client sent.** Every chunk request returns the
 * whole session for that reason. A client that tracked its own progress would have a second
 * source of truth, and the two would diverge the first time a response was lost — which is
 * precisely the case the protocol exists to survive. Because the server's number is the
 * only one, an offset mismatch is self-healing: read the expected offset out of the
 * refusal and carry on from there.
 *
 * **No validation happens here** (ADR 0007). The filename and the size are posted and
 * whatever the API refuses with is what gets rendered. `accept="video/*"` on the file input
 * is a *file-picker filter*, not a check — it changes what the operating system's dialog
 * shows and refuses nothing.
 *
 * The one number this holds is the chunk size, and it holds it because the **server sent
 * it**. A constant here would be a copy that drifts, and the right value depends on the
 * proxy in front of P80 rather than on anything the browser knows.
 */

export type UploadPhase =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'sending'; session: UploadSessionPayload }
  | { kind: 'finishing'; session: UploadSessionPayload }
  | { kind: 'done'; accepted: VideoAcceptedPayload }
  | { kind: 'failed'; problem: ApiError; session: UploadSessionPayload | null };

export interface UploadController {
  phase: UploadPhase;
  /** 0–1, or null before the session exists. */
  progress: number | null;
  start(file: File, options?: { title?: string; transcribe?: boolean }): Promise<void>;
  /** Continue an existing session after a reload, once the user has re-picked the file. */
  resume(session: UploadSessionPayload, file: File): Promise<void>;
  cancel(): void;
  reset(): void;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export function useUpload(): UploadController {
  const [phase, setPhase] = useState<UploadPhase>({ kind: 'idle' });
  // A ref rather than state: the loop below reads it between chunks, and a state value
  // captured in the closure would be the one from when the loop started.
  const abort = useRef<AbortController | null>(null);
  const cancelled = useRef(false);

  const run = useCallback(async (session: UploadSessionPayload, file: File) => {
    abort.current = new AbortController();
    cancelled.current = false;

    let current = session;
    setPhase({ kind: 'sending', session: current });

    try {
      for (;;) {
        if (cancelled.current) return;

        const plan = nextChunkPlan({
          receivedBytes: current.receivedBytes,
          sizeBytes: current.sizeBytes,
          chunkBytes: current.chunkBytes,
        });
        if (plan.done) break;

        current = await sendWithRetry(current, file, plan.start, plan.end, abort.current.signal);
        setPhase({ kind: 'sending', session: current });
      }

      if (cancelled.current) return;

      setPhase({ kind: 'finishing', session: current });
      const accepted = await completeUpload(current.id);
      setPhase({ kind: 'done', accepted });
    } catch (caught: unknown) {
      if (cancelled.current) return;
      setPhase({ kind: 'failed', problem: asApiError(caught), session: current });
    } finally {
      abort.current = null;
    }
  }, []);

  const start = useCallback(
    async (file: File, options: { title?: string; transcribe?: boolean } = {}) => {
      setPhase({ kind: 'starting' });
      try {
        const session = await createUpload({
          filename: file.name,
          sizeBytes: file.size,
          ...(options.title ? { title: options.title } : {}),
          ...(options.transcribe === undefined ? {} : { transcribe: options.transcribe }),
        });
        await run(session, file);
      } catch (caught: unknown) {
        setPhase({ kind: 'failed', problem: asApiError(caught), session: null });
      }
    },
    [run],
  );

  const resume = useCallback(
    async (session: UploadSessionPayload, file: File) => {
      // Re-read rather than trusting the listing, which may be seconds stale.
      const fresh = await getUpload(session.id);
      await run(fresh, file);
    },
    [run],
  );

  const cancel = useCallback(() => {
    cancelled.current = true;
    abort.current?.abort();
    const session = phase.kind === 'sending' || phase.kind === 'finishing' ? phase.session : null;
    if (session) void abortUpload(session.id).catch(() => undefined);
    setPhase({ kind: 'idle' });
  }, [phase]);

  const reset = useCallback(() => setPhase({ kind: 'idle' }), []);

  const progress =
    phase.kind === 'sending' || phase.kind === 'finishing'
      ? phase.session.sizeBytes === 0
        ? 1
        : phase.session.receivedBytes / phase.session.sizeBytes
      : phase.kind === 'done'
        ? 1
        : null;

  return { phase, progress, start, resume, cancel, reset };
}

/**
 * Send one chunk, surviving the things a laptop link does.
 *
 * Three distinct outcomes, and conflating any two of them breaks resume:
 *
 * - **An offset mismatch is not a failure.** The server has told us where the file really
 *   ends. Adopt that number and try again without spending a retry — this is the normal
 *   way a client recovers after a response went missing, not an error condition.
 * - **A retryable failure** (a dropped connection, a 5xx, a full disk) waits and re-sends
 *   *the same offset*. Nothing already received is lost, because the server appends
 *   strictly.
 * - **Anything else** is a refusal the user needs to see, and retrying it would only hide
 *   it behind a progress bar that never moves.
 */
async function sendWithRetry(
  session: UploadSessionPayload,
  file: File,
  start: number,
  end: number,
  signal: AbortSignal,
): Promise<UploadSessionPayload> {
  let current = session;
  let offset = start;
  let sliceEnd = end;

  for (let attempt = 0; attempt < UPLOAD_MAX_CHUNK_ATTEMPTS; attempt += 1) {
    try {
      return await uploadChunk(current.id, offset, file.slice(offset, sliceEnd), signal);
    } catch (caught: unknown) {
      const problem = asApiError(caught);

      if (problem.code === 'UPLOAD_OFFSET_MISMATCH') {
        const expected = problem.details?.expectedOffset;
        if (typeof expected === 'number') {
          // Adopt the server's answer. Not a retry — this attempt did not cost anything,
          // so it must not consume one.
          offset = expected;
          sliceEnd = Math.min(expected + current.chunkBytes, current.sizeBytes);
          attempt -= 1;
          continue;
        }
      }

      if (!problem.retryable || signal.aborted) throw problem;
      await sleep(uploadRetryDelayMs(attempt));
    }
  }

  throw new ApiError(
    {
      code: 'UPLOAD_STALLED',
      message:
        'That chunk could not be sent after several attempts. The upload is saved on the server — try again and it will pick up where it stopped.',
      retryable: true,
    },
    0,
  );
}

function asApiError(caught: unknown): ApiError {
  if (caught instanceof ApiError) return caught;
  if (caught instanceof DOMException && caught.name === 'AbortError') {
    return new ApiError({ code: 'CANCELLED', message: 'Upload cancelled.', retryable: false }, 0);
  }
  return new ApiError({ code: 'UNEXPECTED', message: String(caught), retryable: false }, 0);
}
