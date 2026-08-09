/**
 * WebVTT.
 *
 * The parts of the format that matter here, and the ones that do not:
 *
 * - `NOTE`, `STYLE`, and `REGION` blocks are **valid structure**, so they are skipped
 *   silently. Warning about them would be warning about a well-formed file.
 * - A block with neither an arrow nor one of those keywords is an `unparsed_region`. §14.2
 *   forbids discarding transcript content silently, and this is the branch that rule
 *   exists for.
 * - Cue settings on the timing line (`align:start position:0% line:90%`) are consumed and
 *   discarded. They are presentation, and P80 renders its own transcript view.
 * - The optional metadata header (`Kind: captions`, `Language: de`) is skipped. Capturing
 *   `Language` would want a new field on `TranscriptParseResult` — an interface change
 *   needing an ADR — and §14.1's target-language consistency check belongs to Stage 4,
 *   where a `LanguageAdapter` exists to make it.
 */

import type { ParsedTranscriptSegment } from '../index.js';
import { preprocess, splitBlocks, splitOnArrow } from './blocks.js';
import { cueTextFromLines } from './cue-text.js';
import { extractVoiceSpan } from './speakers.js';
import { parseTimecode } from './timecode.js';
import type { WarningCollector } from './warnings.js';

const HEADER = /^WEBVTT(\s|$)/;
const STRUCTURAL = /^(NOTE|STYLE|REGION)(\s|$)/;

export interface RawCue {
  startMs: number;
  endMs: number;
  text: string;
  voiceLabel: string | null;
}

export function parseVtt(content: string, warn: WarningCollector): RawCue[] {
  const normalized = preprocess(content);
  const blocks = splitBlocks(normalized);
  const cues: RawCue[] = [];

  let commaDecimals = 0;
  let unparsedBlocks = 0;
  let firstUnparsedLine = 0;
  let badTimingLines = 0;
  let firstBadTimingLine = 0;
  let emptyCues = 0;
  let sawHeader = false;

  for (const block of blocks) {
    const first = block.lines[0] ?? '';

    if (HEADER.test(first)) {
      sawHeader = true;
      // The header block may carry metadata lines; they end at the blank line that already
      // closed this block.
      continue;
    }
    if (STRUCTURAL.test(first)) continue;

    // Line 0 may be a cue identifier rather than the timing line.
    const timingIndex = block.lines.findIndex((line) => splitOnArrow(line) !== null);
    if (timingIndex === -1) {
      unparsedBlocks += 1;
      if (firstUnparsedLine === 0) firstUnparsedLine = block.startLine;
      continue;
    }

    const timingLine = block.lines[timingIndex] ?? '';
    const arrow = splitOnArrow(timingLine);
    if (arrow === null) continue;
    if (!arrow.canonical) {
      warn.add('malformed_line', 'arrow_variant', { segmentIndex: cues.length });
    }

    // Cue settings trail the end timecode, space-separated. Taking the first token is
    // enough because a timecode contains no spaces.
    const start = parseTimecode(arrow.left.trim());
    const end = parseTimecode(arrow.right.trim().split(/\s+/)[0] ?? '');

    if (start === null || end === null) {
      badTimingLines += 1;
      if (firstBadTimingLine === 0) firstBadTimingLine = block.startLine + timingIndex;
      continue;
    }

    for (const anomaly of [...start.anomalies, ...end.anomalies]) {
      if (anomaly === 'comma_decimal') commaDecimals += 1;
      if (anomaly === 'short_fraction') {
        warn.add('malformed_line', 'short_fraction', { segmentIndex: cues.length });
      }
    }

    const payload = block.lines.slice(timingIndex + 1);
    const firstPayload = payload[0] ?? '';
    // The voice span has to be read before markup stripping deletes it.
    const voice = extractVoiceSpan(firstPayload);
    const text = cueTextFromLines([voice.rest, ...payload.slice(1)]);

    if (text.length === 0) emptyCues += 1;

    cues.push({ startMs: start.ms, endMs: end.ms, text, voiceLabel: voice.label });
  }

  if (!sawHeader) warn.add('malformed_line', 'vtt_header_missing');
  if (commaDecimals > 0) {
    warn.add('malformed_line', 'wrong_decimal_separator', { args: { n: commaDecimals } });
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
  // Kept, never dropped — an empty cue is still a timed row, and Stage 4 needs the gap.
  if (emptyCues > 0) {
    warn.add('malformed_line', 'cue_empty_after_stripping', { args: { n: emptyCues } });
  }

  return cues;
}

export function toSegments(
  cues: readonly RawCue[],
  labels: ReadonlyArray<string | null>,
  texts: readonly string[],
): ParsedTranscriptSegment[] {
  return cues.map((cue, index) => ({
    startMs: cue.startMs,
    endMs: cue.endMs,
    speakerLabel: labels[index] ?? null,
    rawText: texts[index] ?? cue.text,
    // File order, always. Reordering belongs to the user through `transcript_corrections`,
    // not to the parser — see the stage brief.
    sequenceIndex: index,
  }));
}
