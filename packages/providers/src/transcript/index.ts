/**
 * The transcript parser.
 *
 * `MediaSourceAdapter.parseTranscript` delegates here rather than implementing it, because
 * parsing a subtitle file has nothing to do with where the media came from. An adapter that
 * owned the VTT parser would make the next adapter either duplicate it or depend on the
 * first one — and ADR 0015 is the demonstration: the YouTube adapter was deleted outright
 * and this file did not move.
 */

import type { TranscriptFormat } from '@p80/core';
import type { ParsedTranscriptSegment, ParseWarning } from '../index.js';
import { detectEncodingDamage, detectTranscriptFormat } from './detect.js';
import { parsePasted } from './pasted.js';
import { scanSpeakers } from './speakers.js';
import { parseSrt } from './srt.js';
import { parseVtt, toSegments, type RawCue } from './vtt.js';
import { validateTranscript, type FatalValidation } from './validate.js';
import { WarningCollector } from './warnings.js';

export { LIMITS, type FatalValidation } from './validate.js';
export { detectTranscriptFormat, type DetectionResult } from './detect.js';
export { BOILERPLATE_PATTERNS, detectBoilerplate } from './boilerplate.js';
export { MAX_WARNINGS_PER_KIND } from './warnings.js';

/**
 * Bumped whenever the output changes for the same input. Stored on `transcript_files`, so
 * a segment set can always be traced to the rules that produced it — and so a future
 * reparse can tell whether it would produce something different.
 */
export const TRANSCRIPT_PARSER_VERSION = '1';

export interface FullParseResult {
  segments: ParsedTranscriptSegment[];
  warnings: ParseWarning[];
  warningsByKind: Record<string, number>;
  format: TranscriptFormat;
  parserVersion: string;
  /** Non-null when the file cannot be used. The caller still receives the warnings, so the
   *  preview screen can explain *why* rather than only that something failed. */
  fatal: FatalValidation | null;
}

export function parseTranscriptContent(
  content: string,
  options: { formatHint?: TranscriptFormat | null; filename?: string | null } = {},
): FullParseResult {
  const warn = new WarningCollector();
  const detection = detectTranscriptFormat(content);

  if (!detection.ok) {
    return {
      segments: [],
      warnings: warn.finish(),
      warningsByKind: warn.counts(),
      format: 'pasted_timestamped',
      parserVersion: TRANSCRIPT_PARSER_VERSION,
      fatal: {
        code: 'TRANSCRIPT_FORMAT_UNRECOGNIZED',
        message:
          detection.reason === 'internal_json_unsupported'
            ? 'This looks like a JSON transcript. P80 reads WebVTT, SubRip, and pasted timestamped text; JSON import arrives with data export in Stage 13.'
            : 'P80 could not tell what format this file is. It reads WebVTT, SubRip, and pasted text with a timestamp at the start of each line.',
        details: { reason: detection.reason },
      },
    };
  }

  const { format } = detection;

  // The hint loses, always — but a disagreement is worth telling the user about, since it
  // usually means their file is not what they think it is.
  const extension = options.filename?.toLowerCase().split('.').pop();
  const hintedFormat =
    options.formatHint ??
    (extension === 'vtt' ? 'vtt' : extension === 'srt' ? 'srt' : null);
  if (hintedFormat !== null && hintedFormat !== format) {
    warn.add('malformed_line', 'format_hint_mismatch');
  }

  const damaged = detectEncodingDamage(content);
  if (damaged > 0) {
    warn.add('encoding_fallback', 'encoding_damage', { args: { n: damaged } });
  }

  const cues: RawCue[] =
    format === 'vtt'
      ? parseVtt(content, warn)
      : format === 'srt'
        ? parseSrt(content, warn)
        : parsePasted(content, warn);

  const scan = scanSpeakers(
    cues.map((cue) => cue.text),
    cues.map((cue) => cue.voiceLabel),
  );
  const segments = toSegments(cues, scan.labels, scan.texts);

  const fatal = validateTranscript(segments, warn);

  return {
    // A fatal result stores nothing, so returning the segments would invite a caller to
    // persist them anyway. The preview screen needs the warnings, not the rows.
    segments: fatal === null ? segments : [],
    warnings: warn.finish(),
    warningsByKind: warn.counts(),
    format,
    parserVersion: TRANSCRIPT_PARSER_VERSION,
    fatal,
  };
}
