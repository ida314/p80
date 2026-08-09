import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ApiError,
  deleteTranscript,
  getTranscript,
  getVideo,
  previewTranscript,
  uploadTranscript,
  type TranscriptPreviewPayload,
} from '../api.js';
import { useJob } from '../hooks/useJob.js';
import { useResource } from '../hooks/useResource.js';
import { ConfirmReplace } from '../components/ConfirmReplace.js';
import { JobStatus } from '../components/JobStatus.js';
import { ParseWarnings } from '../transcript/ParseWarnings.js';
import { TranscriptPreview } from '../transcript/TranscriptPreview.js';
import { TranscriptSource, type TranscriptDraft } from '../transcript/TranscriptSource.js';

const EMPTY: TranscriptDraft = { content: '', filename: null };

/**
 * Attach, preview, and replace a transcript (spec §12.1 steps 6–9, §35 steps 6–10).
 *
 * A real route, not a modal: `/videos/:id/transcript` is linkable, the back button works,
 * and a refresh mid-parse lands somewhere that can say what is happening rather than on a
 * blank page.
 *
 * Upload returns `202` with a job id — the worker does the parsing (`03-api.md` §1). That
 * is why this screen polls rather than waiting on a response: a pathological file cannot
 * hold a request open, and the job is inspectable afterwards either way.
 */
export function VideoTranscript() {
  const { id = '' } = useParams();
  const navigate = useNavigate();

  const video = useResource(() => getVideo(id), [id]);
  const transcript = useResource(() => getTranscript(id), [id]);

  const [draft, setDraft] = useState<TranscriptDraft>(EMPTY);
  const [preview, setPreview] = useState<TranscriptPreviewPayload | null>(null);
  const [problem, setProblem] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmingReplace, setConfirmingReplace] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);

  const progress = useJob(jobId);

  // The parse finished. Reload rather than assume: the worker is the authority on whether
  // the transcript is `ready` or `failed`, and the job succeeding only means the handler
  // ran.
  useEffect(() => {
    if (progress.job?.status === 'succeeded') {
      video.reload();
      transcript.reload();
    }
    // `video`/`transcript` are fresh objects each render; depending on them would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress.job?.status]);

  const existingSegments = transcript.data?.segments ?? [];
  const correctionCount = existingSegments.filter((segment) => segment.corrected).length;
  const hasTranscript = (video.data?.transcriptStatus ?? 'none') !== 'none';

  const runPreview = async () => {
    setProblem(null);
    setBusy(true);
    try {
      setPreview(await previewTranscript(id, { content: draft.content, filename: draft.filename }));
    } catch (caught: unknown) {
      setPreview(null);
      if (caught instanceof ApiError) setProblem(caught);
    } finally {
      setBusy(false);
    }
  };

  const runUpload = async (replace: boolean) => {
    setProblem(null);
    setBusy(true);
    try {
      const accepted = await uploadTranscript(id, {
        content: draft.content,
        filename: draft.filename,
        replace,
      });
      setConfirmingReplace(false);
      setJobId(accepted.jobId);
      setDraft(EMPTY);
      setPreview(null);
    } catch (caught: unknown) {
      if (caught instanceof ApiError) {
        // The API refuses rather than overwriting, and names what would be lost. The
        // client's job is to show that and ask — never to retry with `replace: true` on
        // its own.
        if (caught.code === 'TRANSCRIPT_ALREADY_EXISTS') setConfirmingReplace(true);
        else setProblem(caught);
      }
    } finally {
      setBusy(false);
    }
  };

  const runDelete = async () => {
    setProblem(null);
    setBusy(true);
    try {
      const counts = await deleteTranscript(id);
      setJobId(null);
      video.reload();
      transcript.reload();
      setProblem(
        new ApiError(
          {
            code: 'DELETED',
            message: `Removed ${counts.deletedSegments} lines and ${counts.deletedCorrections} corrections. The uploaded file is still on disk.`,
            retryable: false,
          },
          200,
        ),
      );
    } catch (caught: unknown) {
      if (caught instanceof ApiError) setProblem(caught);
    } finally {
      setBusy(false);
    }
  };

  if (video.error !== null) {
    return (
      <section className="panel panel--error" role="alert">
        <h1>{video.error.code}</h1>
        <p>{video.error.message}</p>
        <Link to="/videos">Back to videos</Link>
      </section>
    );
  }

  if (video.data === null) {
    return (
      <section className="panel">
        <p className="hint">Loading…</p>
      </section>
    );
  }

  const status = video.data.transcriptStatus;

  return (
    <section className="panel">
      <h1>Transcript</h1>
      <p className="hint">
        {video.data.title ?? video.data.url} · transcript {status}
        {status === 'ready' && ` · ${transcript.data?.segmentCount ?? 0} lines`}
      </p>

      {jobId !== null && <JobStatus progress={progress} label="Reading your transcript" />}

      {status === 'failed' && (
        <div role="alert" className="panel panel--error">
          <strong>The last transcript could not be parsed.</strong>
          <p>
            Nothing was stored. Preview a file below to see what P80 makes of it before
            committing.
          </p>
        </div>
      )}

      {confirmingReplace && (
        <ConfirmReplace
          correctionCount={correctionCount}
          segmentCount={existingSegments.length}
          busy={busy}
          onConfirm={() => void runUpload(true)}
          onCancel={() => setConfirmingReplace(false)}
        />
      )}

      {problem !== null && (
        <div role="alert" className="panel panel--error">
          <strong>{problem.code}</strong>
          <p>{problem.message}</p>
        </div>
      )}

      <TranscriptSource value={draft} onChange={setDraft} disabled={busy} />

      <div className="editor__actions">
        <button
          type="button"
          onClick={() => void runPreview()}
          disabled={busy || draft.content.trim() === ''}
        >
          Preview
        </button>
        <button
          type="button"
          onClick={() => void runUpload(false)}
          disabled={
            busy ||
            draft.content.trim() === '' ||
            // A fatal validation result means nothing can be stored. Letting someone
            // upload it anyway would just produce a failed job.
            preview?.validation.fatal != null
          }
        >
          {hasTranscript ? 'Replace transcript' : 'Save transcript'}
        </button>
      </div>

      {preview !== null && <TranscriptPreview preview={preview} />}

      {status === 'ready' && (
        <section className="stored">
          <h2>Stored transcript</h2>
          {transcript.data?.file != null && (
            <dl className="kv">
              <dt>Format</dt>
              <dd>{transcript.data.file.format}</dd>
              <dt>From</dt>
              {/* Display only. The storage path never leaves the API, and there is no
                  endpoint that would serve this file back. */}
              <dd>{transcript.data.file.originalFilename ?? 'pasted text'}</dd>
              <dt>Parser</dt>
              <dd>{transcript.data.file.parserVersion}</dd>
            </dl>
          )}
          <ParseWarnings warnings={transcript.data?.file?.warnings ?? []} />
          <div className="editor__actions">
            <button type="button" onClick={() => navigate(`/videos/${id}`)}>
              Open the video
            </button>
            <button type="button" onClick={() => void runDelete()} disabled={busy}>
              Delete transcript
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
