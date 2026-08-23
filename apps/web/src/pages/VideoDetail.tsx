import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatTimecode } from '@p80/core/browser';
import { correctSegment, getTranscript, getVideo, updateVideo } from '../api.js';
import { useResource } from '../hooks/useResource.js';
import { useLatestJob } from '../hooks/useLatestJob.js';
import { describeFailure } from '../components/JobStatus.js';
import { RetryJob, failureIsRetryable } from '../components/RetryJob.js';
import {
  MediaPlayer,
  PLAYER_STATE,
  type PlayerControls,
  type PlayerFailure,
} from '../player/MediaPlayer.js';
import { usePlaybackClock } from '../player/usePlaybackClock.js';
import { TranscriptList } from '../transcript/TranscriptList.js';
import { ParseWarnings } from '../transcript/ParseWarnings.js';
import {
  readTranscriptSelection,
  type TranscriptSelection,
} from '../transcript/selection.js';
import { CreateItemForm } from '../items/CreateItemForm.js';
import { ItemCreated } from '../items/ItemCreated.js';
import type { ItemPayload } from '../api.js';

/** How often to re-check a transcript that is still being parsed. Slower than the job
 *  poll because this screen is not where the upload happened — someone who navigated here
 *  mid-parse is waiting for a result, not watching progress. */
const PARSING_RECHECK_MS = 1500;

/**
 * The video surface (spec §10.4): local media player, synchronized transcript,
 * click-to-seek, and corrections.
 *
 * Everything on this page that could be computed is computed in `packages/core` —
 * which line is active, where a click should seek, how a correction merges. What is left
 * here is genuinely browser-only state: the player handle, its state, and its failures.
 *
 * Stage 3 adds the manual item path: highlight transcript text, and the page offers to
 * turn it into a learning item. The selection is read out of the DOM here because a
 * `Selection` is not something the server has — but what is sent is segment ids and
 * character offsets, never a timing, so the clip window stays the API's to compute
 * (ADR 0007, ADR 0020).
 *
 * Candidate highlights, timeline markers, difficulty, and coverage are the rest of §10.4
 * and arrive with Stages 5–12.
 */
export function VideoDetail() {
  const { id = '' } = useParams();

  const video = useResource(() => getVideo(id), [id]);
  const transcript = useResource(() => getTranscript(id), [id]);

  const [controls, setControls] = useState<PlayerControls | null>(null);
  const [playerState, setPlayerState] = useState<number>(PLAYER_STATE.unstarted);
  const [failure, setFailure] = useState<PlayerFailure | null>(null);

  const transcriptRef = useRef<HTMLDivElement>(null);
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);
  const [pendingSelection, setPendingSelection] = useState<TranscriptSelection | null>(null);
  const [created, setCreated] = useState<ItemPayload | null>(null);
  // A manual retry leaves the page between two truths for a moment — see the poll below.
  const [retrying, setRetrying] = useState(false);
  // Bumped on retry so the single-shot job lookup asks again; it settles its question once
  // per key, and a retry makes it a new question.
  const [retryNonce, setRetryNonce] = useState(0);

  const positionMs = usePlaybackClock(controls, playerState);

  const readSelection = useCallback(() => {
    const container = transcriptRef.current;
    if (container === null) return;
    setSelection(readTranscriptSelection(container));
  }, []);

  const transcriptStatus = video.data?.transcriptStatus;
  const durationMs = video.data?.durationMs ?? null;

  // Why the transcript failed, rather than a guess at it. `transcript_status` is a
  // four-value column (`02-database.md`) and `failed` is all it can say — ASR being absent,
  // ASR returning nothing, and a subtitle file that would not parse are one value between
  // them. The job that failed still carries the reason, and unlike the upload panel's copy
  // this is reachable on every later visit, which is when someone actually asks.
  const failedJob = useLatestJob(
    transcriptStatus === 'failed' ? id : null,
    'TRANSCRIBE',
    retryNonce,
  );

  // A transcript still parsing resolves on its own. Polling here rather than asking the
  // user to refresh is the difference between "still working" and a page that looks broken.
  useEffect(() => {
    // `retrying` extends the same poll across the gap a manual retry opens: the job is
    // queued but `transcript_status` still reads `failed` until the worker claims it and
    // writes `parsing`, so without this the page would sit on the old error and look as
    // though the button did nothing.
    if (transcriptStatus !== 'parsing' && !retrying) return;
    const timer = window.setInterval(() => {
      video.reload();
      transcript.reload();
    }, PARSING_RECHECK_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reload` is stable; the
    // resource objects are not.
  }, [transcriptStatus, retrying]);

  // The retry has been picked up; the ordinary `parsing` poll owns it from here.
  useEffect(() => {
    if (retrying && transcriptStatus !== 'failed') setRetrying(false);
  }, [retrying, transcriptStatus]);

  /**
   * A backstop source of a video's duration.
   *
   * `INGEST_MEDIA` reads it with `ffprobe` and normally gets there first, so this fires
   * only when ffprobe was unavailable. It is still worth keeping: the element has the true
   * duration once metadata loads, and the alternative is a field that stays empty forever
   * on a machine without ffmpeg. Written once, and never over a value the job already set.
   *
   * What neither source is allowed to be is the transcript's last timestamp — that is
   * where the *speech* ends, and a wrong duration in a displayed field is worse than a
   * blank one.
   */
  const onDuration = useCallback(
    (ms: number) => {
      if (durationMs !== null) return;
      void updateVideo(id, { durationMs: ms }).then(() => video.reload());
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [id, durationMs],
  );

  const onCorrect = useCallback(
    async (segmentId: string, patch: { text?: string; startMs?: number; endMs?: number }) => {
      await correctSegment(id, segmentId, patch);
      // Re-read rather than patch in place: the projection of "latest correction wins" is
      // the server's, and reproducing it here would be a second implementation of a rule
      // that already has one.
      transcript.reload();
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [id],
  );

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

  const { media, title, url } = video.data;
  const wordTiming = transcript.data?.file?.timingGranularity === 'word';
  const segments = transcript.data?.segments ?? [];

  return (
    <>
      <section className="panel">
        <h1>{title ?? url}</h1>
        <p className="hint">
          transcript {video.data.transcriptStatus}
          {durationMs !== null && ` · ${formatTimecode(durationMs)}`} ·{' '}
          <Link to={`/videos/${id}/transcript`}>manage transcript</Link>
        </p>

        <MediaPlayer
          src={media.mediaUrl}
          missing={media.missing}
          onControls={setControls}
          onStateChange={setPlayerState}
          onDuration={onDuration}
          onFailure={setFailure}
        />

        {failure !== null && (
          <div role="alert" className="panel panel--error">
            <p>{failure.message}</p>
            {/*
              No link out. ADR 0015 removed the external player, and a failed local file
              has nowhere else to be — offering one would be a dead end dressed as a
              recovery. The transcript below still works, which is the actual recovery.
            */}
          </div>
        )}
      </section>

      <section className="panel">
        {video.data.transcriptStatus === 'none' && (
          <p className="hint">
            No transcript yet. P80 transcribes a video when it is added; if that has not
            happened, transcription is unavailable and you can{' '}
            <Link to={`/videos/${id}/transcript`}>upload one instead</Link>.
          </p>
        )}

        {video.data.transcriptStatus === 'parsing' && (
          <p className="hint">Reading the transcript… this page will update on its own.</p>
        )}

        {video.data.transcriptStatus === 'failed' && (
          <div role="alert" className="panel panel--error">
            <strong>No transcript was produced for this video.</strong>
            {failedJob.job?.status === 'failed' ? (
              <p>{describeFailure(failedJob.job.errorJson)}</p>
            ) : (
              // No failed transcribe job to point at — the failure came from a subtitle
              // file that would not parse, or the job rows have since been pruned. Say
              // only what is certain rather than borrowing the other case's explanation.
              <p>Nothing was stored.</p>
            )}
            {failedJob.job?.status === 'failed' && !retrying && (
              <RetryJob
                jobId={failedJob.job.id}
                label="Transcribe again"
                retryable={failureIsRetryable(failedJob.job.errorJson)}
                onRetried={() => {
                  setRetrying(true);
                  setRetryNonce((n) => n + 1);
                  video.reload();
                }}
              />
            )}
            {retrying && <p className="hint">Queued again. This page will update on its own.</p>}
            <p className="hint">
              The media file is untouched.{' '}
              <Link to={`/videos/${id}/transcript`}>Upload a transcript instead</Link>, which
              is faster and more accurate than transcribing.
            </p>
          </div>
        )}

        {video.data.transcriptStatus === 'ready' && (
          <>
            {created !== null && (
              <ItemCreated item={created} onDone={() => setCreated(null)} />
            )}

            {pendingSelection !== null && (
              <CreateItemForm
                videoId={id}
                selection={pendingSelection}
                onCreated={(item) => {
                  setPendingSelection(null);
                  setSelection(null);
                  setCreated(item);
                }}
                onCancel={() => setPendingSelection(null)}
              />
            )}

            {/*
              `onMouseUp` and `onKeyUp` rather than a `selectionchange` listener: the former
              fire when the user has finished choosing, and the latter fires on every
              intermediate range, which would rebuild the offer on each keystroke of a
              shift-arrow selection. Keyboard selection still works — §11 makes keyboard-only
              operation a requirement, not an enhancement.
            */}
            <div
              ref={transcriptRef}
              onMouseUp={readSelection}
              onKeyUp={readSelection}
              onBlur={() => setSelection(null)}
            >
              <TranscriptList
                segments={segments}
                wordTiming={wordTiming}
                positionMs={positionMs}
                onSeek={controls === null ? null : (ms) => controls.seekTo(ms)}
                onCorrect={onCorrect}
              />
            </div>

            {selection !== null && pendingSelection === null && (
              <div className="selection-offer" role="status">
                <span>
                  Selected: <mark>{selection.text}</mark>
                </span>
                <button type="button" onClick={() => setPendingSelection(selection)}>
                  Create a learning item
                </button>
              </div>
            )}

            <ParseWarnings warnings={transcript.data?.file?.warnings ?? []} />
          </>
        )}
      </section>
    </>
  );
}
