/**
 * SubRip.
 *
 * Two decisions worth stating, both about the cue number:
 *
 * **A cue number is only a cue number if a timing line follows it.** Without that guard, a
 * cue whose text is a bare year — `1995` — gets eaten as a cue number whenever the real
 * number line is missing, which silently deletes a line of transcript.
 *
 * **Cue numbers never determine order.** File order is authoritative. Numbers are
 * duplicated or non-monotonic often enough in files stitched together from two sources that
 * trusting them is a bug; the irregularity is recorded as a warning instead, because it is
 * real evidence about where the file came from.
 */

import { preprocess, splitBlocks, splitOnArrow } from './blocks.js';
import { cueTextFromLines } from './cue-text.js';
import { extractVoiceSpan } from './speakers.js';
import { parseTimecode } from './timecode.js';
import type { RawCue } from './vtt.js';
import type { WarningCollector } from './warnings.js';

const CUE_NUMBER = /^\d{1,7}$/;
/** VobSub screen coordinates trailing the end timecode: `X1:0 X2:0 Y1:0 Y2:0`. */
const TIMECODE_TOKEN = /^[\d:.,]+/;

export function parseSrt(content: string, warn: WarningCollector): RawCue[] {
  const blocks = splitBlocks(preprocess(content));
  const cues: RawCue[] = [];

  let dotDecimals = 0;
  let irregularNumbers = 0;
  let unparsedBlocks = 0;
  let firstUnparsedLine = 0;
  let badTimingLines = 0;
  let firstBadTimingLine = 0;
  let emptyCues = 0;
  let previousNumber = 0;

  for (const block of blocks) {
    const first = block.lines[0] ?? '';
    const second = block.lines[1] ?? '';

    // The guard: a bare number is a cue number only when line 1 carries the timing.
    const hasNumberLine = CUE_NUMBER.test(first.trim()) && splitOnArrow(second) !== null;
    if (hasNumberLine) {
      const number = Number(first.trim());
      if (number <= previousNumber) irregularNumbers += 1;
      previousNumber = number;
    }

    const searchFrom = hasNumberLine ? 1 : 0;
    const timingOffset = block.lines
      .slice(searchFrom)
      .findIndex((line) => splitOnArrow(line) !== null);
    if (timingOffset === -1) {
      unparsedBlocks += 1;
      if (firstUnparsedLine === 0) firstUnparsedLine = block.startLine;
      continue;
    }

    const timingIndex = searchFrom + timingOffset;
    const arrow = splitOnArrow(block.lines[timingIndex] ?? '');
    if (arrow === null) continue;
    if (!arrow.canonical) {
      warn.add('malformed_line', 'arrow_variant', { segmentIndex: cues.length });
    }

    const start = parseTimecode(arrow.left.trim());
    const rightToken = TIMECODE_TOKEN.exec(arrow.right.trim())?.[0] ?? '';
    const end = parseTimecode(rightToken);

    if (start === null || end === null) {
      badTimingLines += 1;
      if (firstBadTimingLine === 0) firstBadTimingLine = block.startLine + timingIndex;
      continue;
    }

    for (const anomaly of [...start.anomalies, ...end.anomalies]) {
      if (anomaly === 'dot_decimal') dotDecimals += 1;
      if (anomaly === 'short_fraction') {
        warn.add('malformed_line', 'short_fraction', { segmentIndex: cues.length });
      }
    }

    const payload = block.lines.slice(timingIndex + 1);
    const voice = extractVoiceSpan(payload[0] ?? '');
    const text = cueTextFromLines([voice.rest, ...payload.slice(1)]);
    if (text.length === 0) emptyCues += 1;

    cues.push({ startMs: start.ms, endMs: end.ms, text, voiceLabel: voice.label });
  }

  if (dotDecimals > 0) {
    warn.add('malformed_line', 'wrong_decimal_separator', { args: { n: dotDecimals } });
  }
  if (irregularNumbers > 0) {
    warn.add('malformed_line', 'cue_numbers_irregular', { args: { n: irregularNumbers } });
  }
  if (unparsedBlocks > 0) {
    warn.add('unparsed_region', 'block_without_arrow', {
      args: { n: unparsedBlocks, l: firstUnparsedLine },
    });
  }
  if (badTimingLines > 0) {
    warn.add('malformed_line', 'timestamp_unparseable', {
      args: { n: badTimingLines, l: firstBadTimingLine },
    });
  }
  if (emptyCues > 0) {
    warn.add('malformed_line', 'cue_empty_after_stripping', { args: { n: emptyCues } });
  }

  return cues;
}
