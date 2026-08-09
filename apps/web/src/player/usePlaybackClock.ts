import { useEffect, useState } from 'react';
import { PLAYER_STATE, type PlayerControls } from './MediaPlayer.js';

/**
 * How often to ask the player where it is.
 *
 * <!-- REVISED: ADR 0015 -->
 * A `<video>` element fires `timeupdate`, which the IFrame API did not, so sampling is no
 * longer the only option. It is still what happens here: `timeupdate` fires at the
 * browser's discretion — typically every 250 ms but explicitly unspecified — and a
 * highlight that follows an unspecified cadence is harder to reason about than one that
 * follows a stated one. 200 ms is under the threshold where the lag is visible, and it is
 * four synchronous property reads a second against an element already in memory.
 */
const SAMPLE_MS = 200;

/**
 * The current playback position, or `null` when there is no player.
 *
 * Sampling stops whenever the video is not playing, so a paused tab left open overnight
 * runs no timer. The position is *not* cleared on pause: the last known value is still
 * where the video is, and blanking the highlight the moment someone pauses to read a line
 * would defeat the point of the transcript view.
 */
export function usePlaybackClock(
  controls: PlayerControls | null,
  playerState: number,
): number | null {
  const [positionMs, setPositionMs] = useState<number | null>(null);

  useEffect(() => {
    if (controls === null) {
      setPositionMs(null);
      return;
    }

    // One immediate sample, so a seek while paused still moves the highlight.
    setPositionMs(controls.positionMs());

    if (playerState !== PLAYER_STATE.playing) return;

    const timer = window.setInterval(() => {
      setPositionMs(controls.positionMs());
    }, SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [controls, playerState]);

  return positionMs;
}
