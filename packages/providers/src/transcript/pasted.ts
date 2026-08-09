/**
 * Pasted timestamped text — spec §35 Stage 2 step 7, §14.2's third format.
 *
 * This is what someone gets when they copy a transcript panel out of a web page: one line
 * per cue, a timestamp at the front, usually no fractional seconds and usually no end time.
 * That last point is what distinguishes it from VTT and SRT and drives the two rules below.
 *
 * **A line that does not start with a timestamp continues the previous cue.** That is how
 * wrapped text behaves when pasted into a textarea, and treating each wrapped line as its
 * own untimed cue would shred every long sentence in the file.
 *
 * **A missing end time is the next cue's start.** Without this, every cue would need an
 * invented duration, ordering and overlap validation would have nothing to check, and
 * click-to-seek would have no region to stop at. Deriving from the next start is the only
 * choice that uses information actually present in the file.
 */

import { parseTimecode } from './timecode.js';
import type { RawCue } from './vtt.js';
import type { WarningCollector } from './warnings.js';
import { cueTextFromLines } from './cue-text.js';
import { extractVoiceSpan } from './speakers.js';
import { preprocess } from './blocks.js';

/**
 * `[00:12] Text` · `00:12 Text` · `0:12 - 0:15 Text` · `1:02:03 Text` ·
 * `[00:00:12,500 --> 00:00:15,000] Text`
 *
 * Anchored, with every quantifier bounded, because this runs over pasted text of arbitrary
 * shape. The fraction is optional here and required nowhere else — that optionality is the
 * format's signature.
 */
const LINE =
  /^\s*[[(]?\s*(\d{1,3}:)?(\d{1,2}):(\d{1,2})([.,]\d{1,3})?\s*(?:(?:-->|→|--|[-–—])\s*((?:\d{1,3}:)?\d{1,2}:\d{1,2}(?:[.,]\d{1,3})?))?\s*[\])]?\s*[-–—:]?\s*(.*)$/;

/** The last cue has no next start to borrow. Estimating from text length is a guess, and
 *  it is bounded on both sides so the guess can never be absurd. */
const MS_PER_CHAR = 60;
const MIN_TAIL_MS = 1_000;
const MAX_TAIL_MS = 10_000;

export function parsePasted(content: string, warn: WarningCollector): RawCue[] {
  const lines = preprocess(content).split('\n');
  const cues: RawCue[] = [];
  const pendingText: string[][] = [];
  let preambleLines = 0;

  for (const line of lines) {
    if (line.trim().length === 0) continue;

    const match = LINE.exec(line);
    const startText =
      match === null
        ? null
        : `${match[1] ?? ''}${match[2] ?? ''}:${match[3] ?? ''}${match[4] ?? ''}`;
    const start = startText === null ? null : parseTimecode(startText);

    if (start === null) {
      if (cues.length === 0) {
        // Before the first timestamp this is a title or a heading. Discarded, but counted
        // — §14.2 forbids doing that silently.
        preambleLines += 1;
      } else {
        pendingText[cues.length - 1]?.push(line.trim());
      }
      continue;
    }

    const explicitEnd = match?.[5] === undefined ? null : parseTimecode(match[5]);
    cues.push({
      startMs: start.ms,
      // Placeholder; resolved below once the next start is known.
      endMs: explicitEnd?.ms ?? -1,
      text: match?.[6]?.trim() ?? '',
      voiceLabel: null,
    });
    pendingText.push([]);
  }

  if (preambleLines > 0) {
    warn.add('unparsed_region', 'preamble_discarded', { args: { n: preambleLines } });
  }

  return cues.map((cue, index) => {
    const continuation = pendingText[index] ?? [];
    const joined = [cue.text, ...continuation].filter((part) => part.length > 0);
    const voice = extractVoiceSpan(joined[0] ?? '');
    const text = cueTextFromLines([voice.rest, ...joined.slice(1)]);

    let endMs = cue.endMs;
    if (endMs < 0) {
      const next = cues[index + 1];
      endMs =
        next === undefined
          ? cue.startMs +
            Math.min(MAX_TAIL_MS, Math.max(MIN_TAIL_MS, text.length * MS_PER_CHAR))
          : next.startMs;
    }

    return { startMs: cue.startMs, endMs, text, voiceLabel: voice.label };
  });
}

/**
 * Used by the format sniffer: what share of the transcript *body* looks like a timed line.
 *
 * The ratio is measured from the first timestamped line onward, not over the whole file.
 * A pasted transcript very often opens with a title and a byline — "Folge 3 — Im
 * Restaurant" — and counting those against the file would push a perfectly good four-line
 * paste below any sensible threshold and reject it. The preamble is discarded by the
 * parser anyway, with a warning, so it is not part of what is being classified.
 *
 * Two timestamps are required, so an essay that happens to contain one time-shaped line at
 * the end cannot masquerade as a transcript of one cue. The exception is a file that is
 * *entirely* timestamped lines, which is a legitimate one-cue paste.
 */
export function pastedLineRatio(content: string): number {
  const lines = preprocess(content)
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return 0;

  const firstTimed = lines.findIndex((line) => LINE.test(line));
  if (firstTimed === -1) return 0;

  const body = lines.slice(firstTimed);
  const matched = body.filter((line) => LINE.test(line)).length;
  if (matched < 2 && matched !== lines.length) return 0;

  return matched / body.length;
}
