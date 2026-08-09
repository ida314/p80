/**
 * Timestamp and size validation — spec §14.1.
 *
 * The line between a warning and a hard failure is: **can the transcript still do its job?**
 *
 * A cue that overlaps the one before it, or lacks punctuation, or runs for forty seconds,
 * is a *quality* signal. `06-scoring.md` §4.2 consumes exactly these as the transcript
 * quality dimension, displayed separately from difficulty so a bad transcript is never
 * mistaken for a hard video. Refusing such a file would refuse most auto-captions.
 *
 * A cue whose end precedes its start cannot be sought to, cannot be clipped, and has no
 * non-arbitrary repair — it breaks this stage's own exit criterion. That is a failure, and
 * the preview screen surfaces it before the user commits, which is why a hard failure here
 * is not a dead end for them.
 */

import { ERROR_CODES, type ErrorCode } from '@p80/core';
import type { ParsedTranscriptSegment } from '../index.js';
import { detectBoilerplate } from './boilerplate.js';
import type { WarningCollector } from './warnings.js';

/** Each bound exists to stop a specific shape, not to be tidy. */
export const LIMITS = {
  /** 20k cues is roughly a ten-hour auto-caption file. */
  maxSegments: 20_000,
  /** The one-cue-two-megabytes shape: a single "segment" that is really a whole document. */
  maxSegmentChars: 5_000,
  /** Checked at the route before any parsing happens. */
  maxContentChars: 2_000_000,
} as const;

/** A cue this short is a timing artifact; this long is usually a missing end timestamp. */
const VERY_SHORT_MS = 40;
const VERY_LONG_MS = 30_000;
const LARGE_GAP_MS = 300_000;
/** Above this share, overlap is the file's design (rolling captions) rather than an error,
 *  so it collapses to one file-level warning instead of one per cue. */
const OVERLAP_COLLAPSE_RATE = 0.1;
/** Below this share of cues ending in punctuation, the transcript is unpunctuated — which
 *  matters a great deal to Stage 4's sentence reconstruction. */
const PUNCTUATION_FLOOR = 0.2;

const TERMINAL_PUNCTUATION = /[.!?…:;]["'»)\]]*$/;

export interface FatalValidation {
  code: ErrorCode;
  message: string;
  details: Record<string, unknown>;
}

export function validateTranscript(
  segments: readonly ParsedTranscriptSegment[],
  warn: WarningCollector,
): FatalValidation | null {
  if (segments.length === 0) {
    return {
      code: ERROR_CODES.TRANSCRIPT_NO_SEGMENTS,
      message: 'This file parsed without producing a single timed line.',
      details: {},
    };
  }

  if (segments.length > LIMITS.maxSegments) {
    return {
      code: ERROR_CODES.TRANSCRIPT_TOO_LARGE,
      message: `This transcript has more lines than P80 accepts.`,
      details: { segments: segments.length, limit: LIMITS.maxSegments },
    };
  }

  for (const [index, segment] of segments.entries()) {
    if (segment.rawText.length > LIMITS.maxSegmentChars) {
      return {
        code: ERROR_CODES.TRANSCRIPT_TOO_LARGE,
        message: 'One line of this transcript is longer than P80 accepts.',
        details: {
          segmentIndex: index,
          chars: segment.rawText.length,
          limit: LIMITS.maxSegmentChars,
        },
      };
    }
    if (segment.endMs < segment.startMs) {
      return {
        code: ERROR_CODES.TRANSCRIPT_INVALID_TIMESTAMPS,
        message: 'A line in this transcript ends before it starts.',
        details: {
          segmentIndex: index,
          sequenceIndex: segment.sequenceIndex,
          startMs: segment.startMs,
          endMs: segment.endMs,
        },
      };
    }
    // Unreachable through the grammar, which has no sign. Asserted because a future
    // parser, or a correction path, could reach it.
    if (segment.startMs < 0) {
      return {
        code: ERROR_CODES.TRANSCRIPT_INVALID_TIMESTAMPS,
        message: 'A line in this transcript starts before the video does.',
        details: { segmentIndex: index, startMs: segment.startMs },
      };
    }
  }

  collectQualityWarnings(segments, warn);
  return null;
}

function collectQualityWarnings(
  segments: readonly ParsedTranscriptSegment[],
  warn: WarningCollector,
): void {
  let overlaps = 0;
  const overlapIndices: number[] = [];

  for (const [index, segment] of segments.entries()) {
    const previous = index > 0 ? segments[index - 1] : undefined;

    if (previous !== undefined) {
      if (segment.startMs < previous.startMs) {
        warn.add('out_of_order', 'out_of_order', { segmentIndex: index });
      }
      if (segment.startMs < previous.endMs) {
        overlaps += 1;
        overlapIndices.push(index);
      }
      const gap = segment.startMs - previous.endMs;
      if (gap > LARGE_GAP_MS) {
        warn.add('suspicious_duration', 'large_gap', {
          segmentIndex: index,
          args: { n: Math.round(gap / 1000) },
        });
      }
    }

    const duration = segment.endMs - segment.startMs;
    if (duration === 0) {
      warn.add('suspicious_duration', 'zero_duration', { segmentIndex: index });
    } else if (duration < VERY_SHORT_MS) {
      warn.add('suspicious_duration', 'very_short', {
        segmentIndex: index,
        args: { n: duration },
      });
    } else if (duration > VERY_LONG_MS) {
      warn.add('suspicious_duration', 'very_long', {
        segmentIndex: index,
        args: { n: Math.round(duration / 1000) },
      });
    }

    // ADR 0013 §4: the cue is already in `segments` and stays there. Only the warning is
    // added — the filter the pattern list came wrapped in is deliberately not taken.
    const pattern = detectBoilerplate(segment.rawText);
    if (pattern !== null) {
      warn.add('subtitle_boilerplate', 'subtitle_boilerplate', {
        segmentIndex: index,
        args: { pattern },
      });
    }
  }

  const overlapRate = overlaps / segments.length;
  if (overlapRate > OVERLAP_COLLAPSE_RATE) {
    // YouTube's rolling captions overlap by design. One warning naming the rate is useful;
    // three thousand identical ones are noise that would bury everything else.
    warn.add('overlapping_timestamps', 'overlap_rate', {
      args: { n: Math.round(overlapRate * 100) },
    });
  } else {
    for (const index of overlapIndices) {
      warn.add('overlapping_timestamps', 'overlap', { segmentIndex: index });
    }
  }

  const withText = segments.filter((segment) => segment.rawText.trim().length > 0);
  if (withText.length > 0) {
    const punctuated = withText.filter((segment) =>
      TERMINAL_PUNCTUATION.test(segment.rawText.trim()),
    ).length;
    const rate = punctuated / withText.length;
    if (rate < PUNCTUATION_FLOOR) {
      warn.add('missing_punctuation', 'missing_punctuation', {
        args: { n: Math.round(rate * 100) },
      });
    }
  }
}
