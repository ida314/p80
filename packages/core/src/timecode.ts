/**
 * Timecode formatting, shared by every surface that shows a timestamp.
 *
 * Parsing lives in `packages/providers/src/transcript/timecode.ts` alongside the parsers
 * that need its anomaly reporting; this is the display half, which the web client and the
 * TUI both need and neither may reimplement.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

/**
 * `M:SS` under an hour, `H:MM:SS` at or over one. Subtitle timings are read at a glance
 * against a running player, and a leading `00:` on a four-minute clip is noise.
 *
 * Truncates rather than rounds: a segment starting at 71.9 s is displayed `1:11`, and
 * clicking it must not appear to seek backwards.
 */
export function formatTimecode(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const hours = Math.floor(clamped / MS_PER_HOUR);
  const minutes = Math.floor((clamped % MS_PER_HOUR) / MS_PER_MINUTE);
  const seconds = Math.floor((clamped % MS_PER_MINUTE) / MS_PER_SECOND);
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

/** `1:11.900` — used only where the exact boundary is being edited, because a correction
 *  editor that hides the milliseconds cannot express the correction being made. */
export function formatTimecodePrecise(ms: number): string {
  const clamped = Math.max(0, Math.floor(ms));
  const fraction = String(clamped % MS_PER_SECOND).padStart(3, '0');
  return `${formatTimecode(clamped)}.${fraction}`;
}
