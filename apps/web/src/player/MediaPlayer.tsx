import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * The media surface: a `<video>` element pointed at `GET /api/videos/:id/media`.
 *
 * ADR 0015 replaced the embedded player with this. The interface it exposes —
 * `PlayerControls` — is deliberately the same shape the old one had, which is why
 * `usePlaybackClock`, `useFollowPlayback`, and the transcript list did not change: the
 * client never knew what was behind the handle, and that is `MediaSourceAdapter`'s
 * guarantee reaching all the way to the UI.
 *
 * Two things are genuinely different, and both are improvements the transcript view can
 * see:
 *
 * - **Seeks are exact.** A local file is decoded, so `currentTime = x` lands at `x`. The
 *   old copy warning users that a click could land two seconds early is gone, not
 *   softened.
 * - **`timeupdate` exists.** The IFrame API had no time event, so following playback meant
 *   polling four times a second. The element fires its own, and this component keeps
 *   `usePlaybackClock`'s polling contract only because the clock is shared with surfaces
 *   that have no element yet.
 */

/** State values, matching the shape the transcript view already branches on. `-1` for
 *  unstarted keeps the vocabulary identical to what the pages were written against. */
export const PLAYER_STATE = {
  unstarted: -1,
  ended: 0,
  playing: 1,
  paused: 2,
  buffering: 3,
} as const;

export type PlayerStateValue = (typeof PLAYER_STATE)[keyof typeof PLAYER_STATE];

/**
 * What the rest of the app is allowed to do to the player.
 *
 * Narrow on purpose, and narrower than `HTMLVideoElement`. Handing the element out would
 * let a page set `src`, which is the one thing that must stay the descriptor's business —
 * `04-providers.md` §1 says a client never builds a player from anything but
 * `MediaDescriptor.mediaUrl`.
 */
export interface PlayerControls {
  play(): void;
  pause(): void;
  seekTo(ms: number): void;
  positionMs(): number;
  durationMs(): number | null;
}

export interface PlayerFailure {
  code: number;
  message: string;
}

/**
 * `MediaError` codes, from the HTML spec.
 *
 * Worth mapping by hand rather than showing the browser's own message: `MEDIA_ERR_DECODE`
 * on a Matroska file means "this browser cannot play this codec", which is actionable, and
 * "Failed to load because no supported source was found" is not.
 */
const MEDIA_ERROR_MESSAGES: Readonly<Record<number, string>> = {
  1: 'Playback was aborted.',
  2: 'The media could not be read. If the file is on a network drive, check it is still mounted.',
  3: 'This browser cannot decode this file. The transcript still works; try a different container or codec for playback.',
  4: 'The media file is missing or unreadable. Point this video at its current location to restore playback.',
};

export interface MediaPlayerProps {
  /** From `video.media.mediaUrl`. Never assembled from a path by the client. */
  src: string;
  /** From `video.media.missing`. Rendering the element at all would produce a console
   *  error and an empty box; saying what is wrong is better than showing nothing. */
  missing: boolean;
  onControls(controls: PlayerControls | null): void;
  onStateChange(state: PlayerStateValue): void;
  onFailure(failure: PlayerFailure | null): void;
  /** Reported once metadata loads. The only source of a video's true duration — the
   *  transcript's last cue is where the *speech* ends, which is not the same thing. */
  onDuration?(ms: number): void;
}

export function MediaPlayer(props: MediaPlayerProps) {
  const { src, missing, onControls, onStateChange, onFailure, onDuration } = props;
  const ref = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);

  const emitState = useCallback(
    (state: PlayerStateValue) => onStateChange(state),
    [onStateChange],
  );

  useEffect(() => {
    const element = ref.current;
    if (element === null || missing) {
      onControls(null);
      return;
    }

    const controls: PlayerControls = {
      play: () => void element.play().catch(() => undefined),
      pause: () => element.pause(),
      // Seconds in, milliseconds out. The conversion lives here rather than at every call
      // site so the rest of the app speaks one unit — `packages/core` is all milliseconds.
      seekTo: (ms) => {
        element.currentTime = Math.max(0, ms) / 1000;
      },
      positionMs: () => Math.round(element.currentTime * 1000),
      durationMs: () =>
        Number.isFinite(element.duration) ? Math.round(element.duration * 1000) : null,
    };

    onControls(controls);
    setReady(true);
    return () => onControls(null);
  }, [src, missing, onControls]);

  if (missing) {
    return (
      <div className="player player--missing" role="status">
        <p>
          The media file for this video is missing — it was moved, renamed, or deleted.
        </p>
        <p>
          Everything built from it is intact: the transcript, its corrections, and any
          learning items. Point the video at the file's current location to restore
          playback.
        </p>
      </div>
    );
  }

  return (
    <video
      ref={ref}
      className="player"
      src={src}
      controls
      // The file is local and the API is on loopback. Preloading metadata is what makes
      // `duration` available before the user presses play, and it costs one range request.
      preload="metadata"
      onLoadedMetadata={(event) => {
        const ms = Math.round(event.currentTarget.duration * 1000);
        if (Number.isFinite(ms)) onDuration?.(ms);
        onFailure(null);
      }}
      onPlaying={() => emitState(PLAYER_STATE.playing)}
      onPause={() => emitState(PLAYER_STATE.paused)}
      onWaiting={() => emitState(PLAYER_STATE.buffering)}
      onEnded={() => emitState(PLAYER_STATE.ended)}
      onError={(event) => {
        const code = event.currentTarget.error?.code ?? 0;
        onFailure({
          code,
          message: MEDIA_ERROR_MESSAGES[code] ?? 'This video could not be played.',
        });
      }}
      data-ready={ready}
    />
  );
}
