import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { formatTimecode } from '@p80/core/browser';
import { correctSegment, getTranscript, getVideo, updateVideo } from '../api.js';
import { useResource } from '../hooks/useResource.js';
import {
  MediaPlayer,
  PLAYER_STATE,
  type PlayerControls,
  type PlayerFailure,
} from '../player/MediaPlayer.js';
import { usePlaybackClock } from '../player/usePlaybackClock.js';
import { TranscriptList } from '../transcript/TranscriptList.js';
import { ParseWarnings } from '../transcript/ParseWarnings.js';

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

  const positionMs = usePlaybackClock(controls, playerState);

  const transcriptStatus = video.data?.transcriptStatus;
  const durationMs = video.data?.durationMs ?? null;

  // A transcript still parsing resolves on its own. Polling here rather than asking the
  // user to refresh is the difference between "still working" and a page that looks broken.
  useEffect(() => {
    if (transcriptStatus !== 'parsing') return;
    const timer = window.setInterval(() => {
      video.reload();
      transcript.reload();
    }, PARSING_RECHECK_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `reload` is stable; the
    // resource objects are not.
  }, [transcriptStatus]);

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
          <p className="hint">
            The transcript could not be parsed and nothing was stored.{' '}
            <Link to={`/videos/${id}/transcript`}>Try another file</Link>.
          </p>
        )}

        {video.data.transcriptStatus === 'ready' && (
          <>
            <TranscriptList
              segments={segments}
              wordTiming={wordTiming}
              positionMs={positionMs}
              onSeek={controls === null ? null : (ms) => controls.seekTo(ms)}
              onCorrect={onCorrect}
            />
            <ParseWarnings warnings={transcript.data?.file?.warnings ?? []} />
          </>
        )}
      </section>
    </>
  );
}
