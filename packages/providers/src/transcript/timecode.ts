/**
 * The one timestamp grammar all three parsers share.
 *
 * ```
 * TIMECODE := (HOURS ':')? MINUTES ':' SECONDS FRACTION?
 * HOURS    := \d{1,3}     MINUTES := \d{1,2}     SECONDS := \d{1,2}
 * FRACTION := [.,] \d{1,3}
 * ```
 *
 * The optional leading hours group is what disambiguates `MM:SS.mmm` from `HH:MM:SS.mmm`
 * correctly. Both separators are accepted by both formats — the *wrong* one for the format
 * is an anomaly worth recording, not a parse failure, because real files mix them
 * constantly and refusing the file would be refusing the user's only transcript.
 */

const TIMECODE = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:([.,])(\d{1,3}))?$/;

/** 24 hours. Past this the input is not a timestamp — `99:99:99,999` lands here rather
 *  than becoming a silently enormous number that breaks every downstream duration check. */
const MAX_MS = 24 * 60 * 60 * 1000;

export type TimecodeAnomaly =
  | 'comma_decimal'
  | 'dot_decimal'
  | 'short_fraction'
  | 'missing_fraction';

export interface TimecodeResult {
  ms: number;
  anomalies: TimecodeAnomaly[];
}

export function parseTimecode(input: string): TimecodeResult | null {
  const match = TIMECODE.exec(input.trim());
  if (match === null) return null;

  const [, hours, minutes, seconds, separator, fraction] = match;
  if (minutes === undefined || seconds === undefined) return null;

  const anomalies: TimecodeAnomaly[] = [];

  let ms =
    Number(hours ?? 0) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000;

  if (fraction === undefined) {
    anomalies.push('missing_fraction');
  } else {
    anomalies.push(separator === ',' ? 'comma_decimal' : 'dot_decimal');
    // A *decimal fraction*, not a millisecond count: `.5` is 500 ms, `.05` is 50 ms. The
    // intuitive-but-wrong reading (`.5` -> 5 ms) is common enough that this needs a test,
    // and getting it backwards would silently shift every timestamp in the file.
    if (fraction.length < 3) anomalies.push('short_fraction');
    ms += Number(fraction.padEnd(3, '0'));
  }

  // No range check on minutes or seconds — `00:60:00` normalizes arithmetically, which is
  // what a hand-edited file that counted past 59 meant.
  if (ms >= MAX_MS) return null;

  return { ms, anomalies };
}
