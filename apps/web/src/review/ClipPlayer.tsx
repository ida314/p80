import { useEffect, useRef, useState } from 'react';

/**
 * §19.1's miniature player: play a bounded window of a local file and stop at its end.
 *
 * Not `MediaPlayer`. That component is the video *surface* — full controls, a duration, a
 * transcript following it. This one plays an interval and stops, which is a different
 * thing wearing the same element: exposing a scrubber here would let a learner wander out
 * of the clip and into the answer.
 *
 * **Stopping is done on `timeupdate`, not with a timer.** A `setTimeout` for the clip's
 * duration drifts whenever decoding stalls, and the failure is silent: the clip plays a
 * second too long and reveals the next line. Watching the element's own clock cannot
 * drift, because it is the clock the audio is coming from.
 */
export interface ClipPlayerHandle {
  replay(): void;
  toggle(): void;
}

interface Props {
  src: string;
  startMs: number;
  endMs: number;
  /** Hidden by default on an audio-recognition card. §19.1 makes showing the image a user
   *  preference now that P80 plays a file the user holds (ADR 0015 resolved the old
   *  prohibition), so this is a preference and not a policy. */
  showImage: boolean;
  disabled: boolean;
  onHandle(handle: ClipPlayerHandle | null): void;
}

export function ClipPlayer({ src, startMs, endMs, showImage, disabled, onHandle }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (element === null || disabled) {
      onHandle(null);
      return;
    }

    const play = () => {
      element.currentTime = startMs / 1000;
      void element.play().catch(() => setError('This clip could not be played.'));
    };

    onHandle({
      replay: play,
      toggle: () => {
        if (element.paused) play();
        else element.pause();
      },
    });
    return () => onHandle(null);
  }, [src, startMs, disabled, onHandle]);

  // A new card is a new clip. Without this the element keeps the previous card's position
  // and the first `R` plays from wherever the last one stopped.
  useEffect(() => {
    const element = ref.current;
    if (element) element.currentTime = startMs / 1000;
    setError(null);
  }, [src, startMs]);

  if (disabled) {
    return (
      <p className="hint" role="status">
        The media file for this clip is missing, so there is nothing to play. The card still
        works — everything else about it is intact.
      </p>
    );
  }

  return (
    <div className={`clip${showImage ? '' : ' clip--audio-only'}`}>
      <video
        ref={ref}
        src={src}
        preload="metadata"
        // No `controls`. A scrubber is a way out of the clip and into the answer.
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(event) => {
          if (event.currentTarget.currentTime * 1000 >= endMs) event.currentTarget.pause();
        }}
        onError={() => setError('This clip could not be played.')}
        aria-label="Source clip"
      />
      {error !== null && (
        <p role="alert" className="hint">
          {error}
        </p>
      )}
      <p className="hint">{playing ? 'Playing…' : 'Press R to replay, Space to pause.'}</p>
    </div>
  );
}
