import { useRef, useState } from 'react';
import { activeSegmentIndexAt, seekTargetMs } from '@p80/core/browser';
import type { SegmentPayload } from '../api.js';
import { useFollowPlayback } from '../hooks/useFollowPlayback.js';
import { TranscriptRow } from './TranscriptRow.js';

interface Props {
  segments: readonly SegmentPayload[];
  /** True when the transcript carries per-word timing (ADR 0017). Shown to the user
   *  because a `cue`-tier transcript cannot produce a single-word clip, and saying so is
   *  the alternative to silently giving them a coarser one. */
  wordTiming: boolean;
  positionMs: number | null;
  /** `null` when there is no usable player. Rows fall back to timestamped links. */
  onSeek: ((ms: number) => void) | null;
  onCorrect: (
    segmentId: string,
    patch: { text?: string; startMs?: number; endMs?: number },
  ) => Promise<void>;
}

/**
 * How much of the previous line to include when seeking, in milliseconds.
 *
 * §19.1 makes pre-roll a user setting, and the settings surface is the TUI's (ADR 0007) —
 * neither exists in Stage 2. This constant is the default until the setting arrives, and it
 * is passed through `seekTargetMs` rather than subtracted here so the setting has exactly
 * one place to land.
 */
const DEFAULT_PRE_ROLL_MS = 500;

/**
 * The synchronized transcript (spec §10.4, exit criteria 2 and 3).
 *
 * Segments arrive from the API already in `start_ms` order with corrections projected —
 * both are the server's job, and re-deriving either here would be a client holding domain
 * logic. What this component owns is the parts that only exist in a browser: which line is
 * lit up, whether the view follows playback, and which row is being edited.
 */
export function TranscriptList({
  segments,
  wordTiming,
  positionMs,
  onSeek,
  onCorrect,
}: Props) {
  const container = useRef<HTMLOListElement>(null);
  const [following, setFollowing] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);

  const activeIndex =
    positionMs === null ? -1 : activeSegmentIndexAt(segments, positionMs);

  useFollowPlayback(activeIndex, following && onSeek !== null, container);

  if (segments.length === 0) {
    return <p className="hint">This transcript has no lines yet.</p>;
  }

  return (
    <div className="transcript">
      <div className="transcript__toolbar">
        <label className="transcript__follow">
          <input
            type="checkbox"
            checked={following}
            onChange={(event) => setFollowing(event.target.checked)}
            disabled={onSeek === null}
          />
          Follow playback
        </label>
        <span className="hint">{segments.length} lines</span>
      </div>

      {/*
        ADR 0015 deleted the "never claim frame-accurate playback" rule along with the
        imprecise player that made it necessary, so the warning that used to sit here is
        gone rather than reworded. What replaces it is the one imprecision that is still
        real: a cue-level transcript can only seek to the start of a line.
      */}
      {!wordTiming && (
        <p className="hint">
          This transcript has timing at line boundaries only, so clicking seeks to the start
          of a line rather than to a word. Transcripts P80 produces itself carry per-word
          timing.
        </p>
      )}

      <ol className="transcript__list" ref={container}>
        {segments.map((segment, index) => (
          <TranscriptRow
            key={segment.id}
            segment={segment}
            index={index}
            active={index === activeIndex}
            editing={editingId === segment.id}
            onSeek={
              onSeek === null
                ? null
                : () => onSeek(seekTargetMs(segment, DEFAULT_PRE_ROLL_MS))
            }
            onEdit={() => setEditingId(editingId === segment.id ? null : segment.id)}
            onCancelEdit={() => setEditingId(null)}
            onSave={async (patch) => {
              await onCorrect(segment.id, patch);
              setEditingId(null);
            }}
          />
        ))}
      </ol>
    </div>
  );
}
