import { formatTimecode } from '@p80/core/browser';
import type { TranscriptPreviewPayload } from '../api.js';
import { ParseWarnings } from './ParseWarnings.js';

const FORMAT_LABELS: Record<string, string> = {
  vtt: 'WebVTT',
  srt: 'SubRip',
  pasted_timestamped: 'pasted text with timestamps',
  internal_json: 'P80 export',
};

interface Props {
  preview: TranscriptPreviewPayload;
}

/**
 * What the parse produced, before anything is stored (spec §12.1 step 7).
 *
 * The preview endpoint persists nothing, and a **validation failure arrives inside a 200**
 * with `validation.fatal` populated — showing someone what is wrong before they commit is
 * the whole reason the endpoint exists, and a 4xx would leave this screen with nothing to
 * render.
 */
export function TranscriptPreview({ preview }: Props) {
  const fatal = preview.validation.fatal;

  return (
    <section className="preview">
      <h2>Preview</h2>

      {fatal !== null ? (
        <div role="alert" className="panel panel--error">
          <strong>This transcript cannot be stored as it is.</strong>
          <p>{fatal.message}</p>
          <p className="hint">
            Nothing was saved. Fix the file and try again — the preview never writes
            anything.
          </p>
        </div>
      ) : (
        <dl className="kv">
          <dt>Format</dt>
          <dd>{FORMAT_LABELS[preview.format] ?? preview.format}</dd>
          <dt>Lines</dt>
          <dd>{preview.segmentCount.toLocaleString()}</dd>
          <dt>Ends at</dt>
          <dd>{preview.lastEndMs === null ? '—' : formatTimecode(preview.lastEndMs)}</dd>
        </dl>
      )}

      <ParseWarnings warnings={preview.warnings} byKind={preview.warningsByKind} />

      {preview.segments.length > 0 && (
        <>
          <h2>First lines</h2>
          <ol className="preview__lines">
            {preview.segments.slice(0, 12).map((segment) => (
              <li key={segment.sequenceIndex}>
                <span className="segment__time">{formatTimecode(segment.startMs)}</span>
                {segment.speakerLabel !== null && (
                  <span className="segment__speaker">{segment.speakerLabel}</span>
                )}
                {/* Escaped by React, like every other rendering of transcript text. */}
                <span>{segment.rawText}</span>
              </li>
            ))}
          </ol>
          {preview.truncated && (
            <p className="hint">
              Showing the first {preview.segments.length} of{' '}
              {preview.segmentCount.toLocaleString()} lines. All of them will be stored.
            </p>
          )}
        </>
      )}
    </section>
  );
}
