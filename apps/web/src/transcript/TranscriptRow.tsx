import { formatTimecode } from '@p80/core/browser';
import type { SegmentPayload } from '../api.js';
import { SegmentEditor } from './SegmentEditor.js';

interface Props {
  segment: SegmentPayload;
  index: number;
  active: boolean;
  editing: boolean;
  /** `null` when there is no working player — the media file is missing, or the browser
   *  cannot decode it. The row then shows the timecode without offering a seek that would
   *  do nothing. */
  onSeek: ((ms: number) => void) | null;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSave: (patch: { text?: string; startMs?: number; endMs?: number }) => Promise<void>;
}

/**
 * One transcript line.
 *
 * Clicking the timecode seeks; clicking the text does not, because the text is also what
 * you select and read. Exit criterion 3's "seeks to the expected region" is computed by
 * `seekTargetMs` in `packages/core` and unit-tested there — this row only reports which
 * segment was clicked.
 */
export function TranscriptRow({
  segment,
  index,
  active,
  editing,
  onSeek,
  onEdit,
  onCancelEdit,
  onSave,
}: Props) {
  return (
    <li
      className={`segment${active ? ' segment--active' : ''}`}
      data-segment-index={index}
      aria-current={active ? 'true' : undefined}
    >
      <div className="segment__head">
        {onSeek === null ? (
          // ADR 0015 removed the external player, so there is no second playback path to
          // fall back to and nowhere honest to link. A plain timecode says "this line is
          // here" without offering a control that would do nothing — the media is missing
          // and the repair affordance is on the player itself, where the user is looking.
          <span className="segment__time segment__time--inert">
            {formatTimecode(segment.startMs)}
          </span>
        ) : (
          <button
            type="button"
            className="segment__time"
            onClick={() => onSeek(segment.startMs)}
          >
            {formatTimecode(segment.startMs)}
          </button>
        )}

        {segment.speakerLabel !== null && (
          <span className="segment__speaker">{segment.speakerLabel}</span>
        )}

        {segment.corrected && <span className="badge badge--corrected">corrected</span>}

        <button type="button" className="segment__edit" onClick={onEdit}>
          {editing ? 'Editing' : 'Correct'}
        </button>
      </div>

      {/* Interpolated as a child, so React escapes it. Transcript text is untrusted input
          (`CLAUDE.md` rule 8) and this is the surface where it is rendered most. */}
      <p className="segment__text">{segment.text}</p>

      {segment.corrected && (
        <p className="segment__original hint">
          Originally: {segment.rawText}
        </p>
      )}

      {editing && (
        <SegmentEditor segment={segment} onCancel={onCancelEdit} onSave={onSave} />
      )}
    </li>
  );
}
