import type { ParseWarningKind } from '@p80/core/browser';
import type { ParseWarningPayload } from '../api.js';

/**
 * How each warning kind reads to someone who did not write the parser.
 *
 * The parser's own messages are deliberately terse and contain **no transcript text**
 * (ADR 0014) — they are kinds, counts, and line numbers, because they are persisted in
 * `parse_warnings_json` and re-served on every read. These headings supply the meaning
 * the messages cannot carry, and say whether the anomaly matters.
 */
const COPY: Record<ParseWarningKind, { label: string; explanation: string }> = {
  overlapping_timestamps: {
    label: 'Overlapping lines',
    explanation:
      'Two lines are on screen at once. Normal for rolling captions; the later line is ' +
      'the one highlighted during playback.',
  },
  out_of_order: {
    label: 'Lines out of order',
    explanation:
      'A line starts before the one above it. Nothing was reordered — the file order is ' +
      'kept as it is, and the transcript is simply shown in time order.',
  },
  missing_punctuation: {
    label: 'No sentence punctuation',
    explanation:
      'Auto-generated captions often have none. Sentence boundaries get rebuilt in a ' +
      'later stage; it costs nothing now.',
  },
  malformed_line: {
    label: 'Lines P80 could not read',
    explanation:
      'Something in the file did not match the format. The surrounding lines were still ' +
      'kept — nothing is ever dropped for being odd.',
  },
  unparsed_region: {
    label: 'Skipped regions',
    explanation:
      'A stretch of the file was not a cue — a header, a note, or a comment. Worth a ' +
      'glance if you expected text there.',
  },
  encoding_fallback: {
    label: 'Character encoding guessed',
    explanation:
      'The file was not clean UTF-8. Check any lines with accents or umlauts before you ' +
      'rely on them.',
  },
  suspicious_duration: {
    label: 'Unusual line lengths',
    explanation:
      'A line is on screen far longer or shorter than the rest. Often a timing error in ' +
      'the source file, and worth correcting if it affects a line you care about.',
  },
  subtitle_boilerplate: {
    label: 'Lines that look like subtitle boilerplate',
    explanation:
      'Things like "Subtitles by …" or "Please subscribe". They are kept, not removed — ' +
      'P80 never discards a line on its own. Delete or correct them if they bother you.',
  },
  low_asr_confidence: {
    label: 'Passages the model was unsure about',
    explanation:
      'Music, silence, or crosstalk. Speech recognition tends to invent fluent, ' +
      'plausible text over these rather than producing nothing, so read them before ' +
      'trusting them. They are kept and flagged, never dropped.',
  },
  unaligned_words: {
    label: 'Words with no timestamp',
    explanation:
      'The aligner could not place these in time, so they have text but no clip. They ' +
      'still appear in the transcript; only playback of those exact words is affected.',
  },
};

interface Props {
  warnings: readonly ParseWarningPayload[];
  byKind?: Partial<Record<ParseWarningKind, number>>;
}

/**
 * Parse warnings, grouped and counted.
 *
 * §14.2's rule is that a parser never silently discards a cue, which only means anything
 * if the anomalies it recorded instead are actually shown. Grouping is what makes that
 * survivable: a three-thousand-cue auto-caption file produces a lot of warnings, and an
 * ungrouped list of them is indistinguishable from an error page.
 */
export function ParseWarnings({ warnings, byKind }: Props) {
  if (warnings.length === 0) {
    return <p className="hint">No parse warnings. Every line was read cleanly.</p>;
  }

  const counts: Partial<Record<ParseWarningKind, number>> = byKind ?? countByKind(warnings);
  const kinds = (Object.keys(counts) as ParseWarningKind[]).filter(
    (kind) => (counts[kind] ?? 0) > 0,
  );

  return (
    <div className="warnings">
      <h2>What P80 noticed</h2>
      <p className="hint">
        Nothing here was removed. A warning records something unusual so you can decide
        about it — P80 never drops a line on its own.
      </p>
      <ul className="warnings__list">
        {kinds.map((kind) => {
          const examples = warnings
            .filter((warning) => warning.kind === kind)
            .slice(0, 3);
          return (
            <li key={kind}>
              <strong>{COPY[kind].label}</strong> <span className="badge">{counts[kind]}</span>
              <p className="hint">{COPY[kind].explanation}</p>
              <ul className="warnings__examples">
                {examples.map((warning, index) => (
                  <li key={index} className="hint">
                    {warning.segmentIndex === null
                      ? warning.message
                      : `line ${warning.segmentIndex + 1}: ${warning.message}`}
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function countByKind(
  warnings: readonly ParseWarningPayload[],
): Partial<Record<ParseWarningKind, number>> {
  const counts: Partial<Record<ParseWarningKind, number>> = {};
  for (const warning of warnings) {
    counts[warning.kind] = (counts[warning.kind] ?? 0) + 1;
  }
  return counts;
}
