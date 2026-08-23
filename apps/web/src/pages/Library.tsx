import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { SUPPORTED_MEDIA_EXTENSIONS } from '@p80/core/browser';
import {
  ApiError,
  browseLibrary,
  createVideo,
  deleteLibraryFile,
  listUploads,
  type LibraryEntryPayload,
  type UploadSessionPayload,
} from '../api.js';
import { useResource } from '../hooks/useResource.js';
import { useJob } from '../hooks/useJob.js';
import { useLatestJob } from '../hooks/useLatestJob.js';
import { useUpload } from '../hooks/useUpload.js';
import { JobStatus } from '../components/JobStatus.js';

/**
 * The media library: what is on the server, and how to put something there (ADR 0024).
 *
 * Two surfaces that answer different questions and are deliberately kept together. *What
 * is already here* was previously unanswerable — the add-video form is a free-text path
 * field, which is fine when the browser and the library are on one machine and is guesswork
 * when they are not. *Get this file from my laptop onto the server* had no answer at all.
 *
 * The directory location lives in the query string rather than a route parameter, so a
 * folder is deep-linkable and the back button walks back up without slashes having to be
 * encoded into a path segment.
 */
export function Library() {
  const [params, setParams] = useSearchParams();
  const path = params.get('path') ?? '';
  const navigate = useNavigate();

  const listing = useResource(() => browseLibrary({ path }), [path]);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{ entry: LibraryEntryPayload; problem: ApiError } | null>(
    null,
  );

  const go = (next: string) => {
    setProblem(null);
    setConfirming(null);
    setParams(next === '' ? {} : { path: next });
  };

  const addToLibrary = async (entry: LibraryEntryPayload) => {
    setProblem(null);
    setBusy(entry.path);
    try {
      const accepted = await createVideo({ path: entry.path });
      navigate(`/videos/${accepted.video.id}`);
    } catch (caught: unknown) {
      setProblem(asApiError(caught));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Deletion is server-driven, in two steps.
   *
   * The first call carries no acknowledgement. If a video still uses the file the API
   * refuses with `MEDIA_FILE_IN_USE` and names them, and *that message* is what the
   * confirmation shows — the client never decides on its own what the consequences are,
   * which is the same shape the settings page uses for `MEDIA_ROOT_WOULD_ORPHAN`.
   */
  const remove = async (entry: LibraryEntryPayload, acknowledge: boolean) => {
    setProblem(null);
    setBusy(entry.path);
    try {
      await deleteLibraryFile(entry.path, acknowledge);
      setConfirming(null);
      listing.reload();
    } catch (caught: unknown) {
      const failure = asApiError(caught);
      if (failure.code === 'MEDIA_FILE_IN_USE' && !acknowledge) {
        setConfirming({ entry, problem: failure });
      } else {
        setConfirming(null);
        setProblem(failure);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="panel">
      <div className="videos__head">
        <h1>Media library</h1>
        <Link className="button-link" to="/videos/new">
          Add by path
        </Link>
      </div>

      <UploadPanel onFinished={() => listing.reload()} />

      <nav className="library__crumbs" aria-label="Folder">
        <button type="button" onClick={() => go('')} disabled={path === ''}>
          Library root
        </button>
        {path !== '' &&
          path.split('/').map((segment, index, all) => (
            <button
              key={all.slice(0, index + 1).join('/')}
              type="button"
              onClick={() => go(all.slice(0, index + 1).join('/'))}
              disabled={index === all.length - 1}
            >
              {segment}
            </button>
          ))}
      </nav>

      {(listing.error ?? problem) !== null && (
        <div role="alert" className="panel panel--error">
          <strong>{(listing.error ?? problem)!.code}</strong>
          <p>{(listing.error ?? problem)!.message}</p>
        </div>
      )}

      {confirming !== null && (
        <div role="alert" className="panel panel--error">
          <strong>Delete {confirming.entry.name}?</strong>
          {/* The API's own message, which names what is affected. */}
          <p>{confirming.problem.message}</p>
          <div className="editor__actions">
            <button type="button" onClick={() => void remove(confirming.entry, true)}>
              Delete it anyway
            </button>
            <button type="button" onClick={() => setConfirming(null)}>
              Keep it
            </button>
          </div>
        </div>
      )}

      {listing.data !== null && listing.data.entries.length === 0 && (
        <p className="hint">This folder is empty.</p>
      )}

      <ul className="library__list">
        {(listing.data?.entries ?? []).map((entry) => (
          <li key={entry.path} className={`library__entry library__entry--${entry.kind}`}>
            {entry.kind === 'directory' ? (
              <button type="button" className="library__name" onClick={() => go(entry.path)}>
                {entry.name}/
              </button>
            ) : (
              <span className="library__name">{entry.name}</span>
            )}

            <span className="hint">{describe(entry)}</span>

            <span className="library__actions">
              {entry.video !== null && (
                <Link to={`/videos/${entry.video.id}`}>Open video</Link>
              )}
              {entry.canAdd && (
                <button
                  type="button"
                  disabled={busy === entry.path}
                  onClick={() => void addToLibrary(entry)}
                >
                  {busy === entry.path ? 'Adding…' : 'Add as video'}
                </button>
              )}
              {entry.deletable && (
                <button
                  type="button"
                  disabled={busy === entry.path}
                  onClick={() => void remove(entry, false)}
                >
                  Delete
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {listing.data?.truncated === true && (
        <p className="hint">
          Showing the first {listing.data.entries.length} entries in this folder.
        </p>
      )}

      <p className="hint">
        P80 reads files where they are and never copies them. Files you upload here are the
        one exception — they are written into the library’s <code>uploads</code> folder, and
        they are the only files P80 will delete.
      </p>
    </section>
  );
}

/**
 * The upload surface.
 *
 * `accept` is a **file-picker filter, not validation** — it changes what the operating
 * system's dialog offers and refuses nothing, which is why an unsupported file still
 * reaches the API and comes back with the API's own refusal. ADR 0007 keeps that decision
 * on the server.
 */
function UploadPanel({ onFinished }: { onFinished: () => void }) {
  const upload = useUpload();
  const [transcribe, setTranscribe] = useState(true);
  const input = useRef<HTMLInputElement>(null);
  // Sessions left in flight by a previous visit. The browser cannot re-open a `File` it no
  // longer holds, so these can be listed but not silently continued.
  const [orphans, setOrphans] = useState<UploadSessionPayload[]>([]);

  const refreshOrphans = useCallback(async () => {
    try {
      const { uploads } = await listUploads();
      setOrphans(uploads.filter((session) => session.status === 'in_progress'));
    } catch {
      // A failure here costs a convenience, not the feature.
    }
  }, []);

  useEffect(() => {
    void refreshOrphans();
  }, [refreshOrphans]);

  useEffect(() => {
    if (upload.phase.kind === 'done') {
      onFinished();
      void refreshOrphans();
    }
  }, [upload.phase.kind, onFinished, refreshOrphans]);

  const pick = (file: File | undefined) => {
    if (file) void upload.start(file, { transcribe });
  };

  return (
    <div className="panel upload">
      <h2>Upload from this device</h2>

      <label className="field">
        <span>Video file</span>
        <input
          ref={input}
          type="file"
          accept={SUPPORTED_MEDIA_EXTENSIONS.join(',')}
          disabled={upload.phase.kind === 'sending' || upload.phase.kind === 'starting'}
          onChange={(event) => pick(event.target.files?.[0])}
        />
        <span className="hint">
          {SUPPORTED_MEDIA_EXTENSIONS.join(', ')}. Sent in pieces, so a dropped connection
          resumes instead of starting over.
        </span>
      </label>

      <label className="field field--check">
        <input
          type="checkbox"
          checked={transcribe}
          onChange={(event) => setTranscribe(event.target.checked)}
        />
        <span>Transcribe after uploading</span>
        <span className="hint">
          Transcription is local and can take a while on this machine. Turning it off still
          adds the video — you can transcribe it later.
        </span>
      </label>

      {upload.progress !== null && upload.phase.kind !== 'done' && (
        <div className="upload__progress">
          <progress value={upload.progress} max={1} />
          <span className="hint">
            {upload.phase.kind === 'finishing'
              ? 'Finishing…'
              : `${Math.floor(upload.progress * 100)}%`}
          </span>
          <button type="button" onClick={() => upload.cancel()}>
            Cancel
          </button>
        </div>
      )}

      {upload.phase.kind === 'done' && (
        <UploadDone
          videoId={upload.phase.accepted.video.id}
          jobId={upload.phase.accepted.jobId}
          onReset={() => upload.reset()}
        />
      )}

      {upload.phase.kind === 'failed' && (
        <div role="alert" className="panel panel--error">
          <strong>{upload.phase.problem.code}</strong>
          <p>{upload.phase.problem.message}</p>
          <button type="button" onClick={() => upload.reset()}>
            Start again
          </button>
        </div>
      )}

      {orphans.length > 0 && upload.phase.kind === 'idle' && (
        <div className="upload__orphans">
          <h3>Unfinished uploads</h3>
          <p className="hint">
            These are still on the server. A browser cannot re-open a file by itself, so
            choose the same file again to carry on from where it stopped.
          </p>
          <ul>
            {orphans.map((session) => (
              <li key={session.id}>
                {session.originalFilename} —{' '}
                {session.sizeBytes === 0
                  ? '0%'
                  : `${Math.floor((session.receivedBytes / session.sizeBytes) * 100)}%`}
                <ResumeButton session={session} upload={upload} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * What happens after the last byte lands — both jobs, not just the first.
 *
 * Completion returns the identical `202 { video, jobId }` that `POST /api/videos` returns,
 * which is why the response was shared rather than given its own schema. That `jobId` is
 * `INGEST_MEDIA`: hash the file, probe its duration, and enqueue `TRANSCRIBE`. The second
 * job is where the minutes and nearly all of the failure modes are, and its id cannot be in
 * the `202` because the worker had not created it yet.
 *
 * Following only the first job is what made a failed transcription look like a stuck
 * upload: ingest succeeded, `<JobStatus>` renders nothing for a success, and the panel went
 * quiet while the actual work had already failed. So the ingest job is followed to its end,
 * and on success we ask which transcribe job it produced and follow that one too.
 */
function UploadDone({
  videoId,
  jobId,
  onReset,
}: {
  videoId: string;
  jobId: string;
  onReset: () => void;
}) {
  // Bumped when a failed job is queued again, so both hooks re-ask: polling stops at a
  // terminal state and the lookup settles once, which is correct until a retry undoes both.
  const [retryNonce, setRetryNonce] = useState(0);
  const onRetried = useCallback(() => setRetryNonce((n) => n + 1), []);

  const ingest = useJob(jobId, retryNonce);

  // Only once ingest has actually succeeded. Asking earlier races the worker, and asking
  // after a *failed* ingest would be looking for a job that was never enqueued.
  const succeeded = ingest.job?.status === 'succeeded';
  const transcribe = useLatestJob(succeeded ? videoId : null, 'TRANSCRIBE', retryNonce);
  const transcribeProgress = useJob(transcribe.job?.id ?? null, retryNonce);

  return (
    <div className="upload__done">
      <p>
        Uploaded. <Link to={`/videos/${videoId}`}>Open the video</Link>
      </p>
      <JobStatus
        progress={ingest}
        label="Reading the file you uploaded"
        onRetried={onRetried}
      />

      {/*
        `transcribe.job === null` after a settled lookup is a legitimate end state, not a
        pending one — the repair path passes `transcribe: false`, and a duplicate, a deleted
        video, or missing media all end ingest without enqueueing anything. Rendering a
        spinner for it would promise work that is never coming, which is the same class of
        bug this component was changed to fix.
      */}
      {transcribe.job !== null && (
        <JobStatus
          progress={transcribeProgress}
          label="Transcribing this video"
          onRetried={onRetried}
        />
      )}

      <button type="button" onClick={onReset}>
        Upload another
      </button>
    </div>
  );
}

/**
 * Resuming needs the file back, and the check that it is the *same* file.
 *
 * Matching on name and size is not domain validation — it is asking "is this the thing you
 * were sending", and getting it wrong writes one file's bytes into another file's tail.
 */
function ResumeButton({
  session,
  upload,
}: {
  session: UploadSessionPayload;
  upload: ReturnType<typeof useUpload>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [mismatch, setMismatch] = useState(false);

  return (
    <>
      <button type="button" onClick={() => input.current?.click()}>
        Choose the file to resume
      </button>
      <input
        ref={input}
        type="file"
        hidden
        accept={SUPPORTED_MEDIA_EXTENSIONS.join(',')}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (!file) return;
          if (file.name !== session.originalFilename || file.size !== session.sizeBytes) {
            setMismatch(true);
            return;
          }
          setMismatch(false);
          void upload.resume(session, file);
        }}
      />
      {mismatch && (
        <span className="hint">
          That is a different file — the name or the size does not match. Cancel this upload
          and start a new one instead.
        </span>
      )}
    </>
  );
}

function describe(entry: LibraryEntryPayload): string {
  if (entry.kind === 'directory') return 'folder';
  if (entry.kind === 'symlink') return 'shortcut — P80 does not follow these';

  const parts: string[] = [];
  if (entry.sizeBytes !== null) parts.push(formatBytes(entry.sizeBytes));
  if (!entry.supported) parts.push('not a format P80 plays');
  else if (entry.video !== null) {
    parts.push(entry.video.mediaMissing ? 'added — file missing' : 'already added');
  } else parts.push('not added yet');
  return parts.join(' · ');
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function asApiError(caught: unknown): ApiError {
  return caught instanceof ApiError
    ? caught
    : new ApiError({ code: 'UNEXPECTED', message: String(caught), retryable: false }, 0);
}
