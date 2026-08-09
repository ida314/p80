/**
 * Preprocessing and block splitting, shared by the VTT and SRT parsers.
 *
 * Both formats are "blocks separated by blank lines", and both arrive from every operating
 * system anyone has ever used, so the line-ending and BOM handling has to happen in exactly
 * one place or the two parsers will disagree about what an empty line is.
 */

export interface RawBlock {
  lines: string[];
  /** 1-based line number of the block's first line, for warning messages. Line numbers are
   *  the only way a user can act on "this block was not parsed" — an index into a list they
   *  cannot see is not actionable. */
  startLine: number;
}

/**
 * A BOM at offset 0 is stripped silently. It is what Windows tooling writes, not evidence
 * of an encoding problem — warning about it would train users to ignore warnings.
 * A BOM anywhere *else* survives to `normalizeTranscriptText`, which removes it.
 */
export function preprocess(content: string): string {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  return withoutBom.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function splitBlocks(content: string): RawBlock[] {
  const lines = content.split('\n');
  const blocks: RawBlock[] = [];
  let current: string[] = [];
  let startLine = 1;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) {
      if (current.length > 0) {
        blocks.push({ lines: current, startLine });
        current = [];
      }
      startLine = index + 2;
      continue;
    }
    if (current.length === 0) startLine = index + 1;
    current.push(line);
  }
  // A final block with no trailing newline is ordinary, not an error.
  if (current.length > 0) blocks.push({ lines: current, startLine });

  return blocks;
}

/**
 * Canonical `-->` first, then the tolerant variants that appear in hand-edited files:
 * `- ->`, and the en/em dash forms a word processor produces by autocorrecting `-->`.
 * A tolerated variant is a warning, not a failure — the timing is unambiguous and refusing
 * the file would refuse the user's only transcript.
 */
export const CANONICAL_ARROW = /\s+-->\s+/;
export const TOLERANT_ARROW = /\s*[-–—]{1,2}\s*>\s*/;

export function splitOnArrow(
  line: string,
): { left: string; right: string; canonical: boolean } | null {
  const canonical = line.split(CANONICAL_ARROW);
  if (canonical.length === 2 && canonical[0] !== undefined && canonical[1] !== undefined) {
    return { left: canonical[0], right: canonical[1], canonical: true };
  }
  const tolerant = line.split(TOLERANT_ARROW);
  if (tolerant.length === 2 && tolerant[0] !== undefined && tolerant[1] !== undefined) {
    return { left: tolerant[0], right: tolerant[1], canonical: false };
  }
  return null;
}

export function hasArrow(line: string): boolean {
  return splitOnArrow(line) !== null;
}
