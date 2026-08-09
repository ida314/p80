/**
 * Warning collection with the two properties that keep `parse_warnings_json` safe to
 * persist and safe to serve.
 *
 * **Messages carry no transcript content.** `add()` takes a template identifier and
 * numeric arguments, not a free string, so a message like `cue "${text}" is empty` is not
 * expressible. That matters because the column is persisted forever and re-served on every
 * transcript read — it is a render surface, and `CLAUDE.md` rule 8 applies to it even
 * though nothing about it looks like a render.
 *
 * **Per-kind caps.** A three-thousand-cue auto-caption file with no punctuation would
 * otherwise produce thousands of warnings, turning an unbounded TEXT column into a stored
 * amplification vector. Each kind caps at 50 and then collapses into one summary entry
 * naming how many were suppressed, so the count survives even when the detail does not.
 */

import type { ParseWarningKind } from '@p80/core';
import type { ParseWarning } from '../index.js';

export const MAX_WARNINGS_PER_KIND = 50;
export const MAX_WARNING_MESSAGE_CHARS = 500;

/**
 * Every message the parser can emit. Adding one here is the only way to add a message,
 * which is what makes the no-transcript-text rule a property of the interface rather than
 * of anyone's discipline. `n` is a count, `i` an index, `l` a line number.
 */
const TEMPLATES = {
  vtt_header_missing: () => 'The file has no WEBVTT header, but parses as WebVTT.',
  block_without_arrow: (a) =>
    `${a.n} block(s) had no timing line and were not comments, starting at line ${a.l}.`,
  trailing_content: (a) => `${a.n} line(s) after the last cue could not be parsed.`,
  preamble_discarded: (a) => `${a.n} line(s) before the first timestamp were not cues.`,
  arrow_variant: () => 'The timing line used a non-standard arrow.',
  wrong_decimal_separator: (a) =>
    `${a.n} timestamp(s) used the other format's decimal separator.`,
  short_fraction: () => 'The timestamp fraction was not three digits.',
  timestamp_unparseable: (a) =>
    `${a.n} timing line(s) could not be read and their cues were skipped, from line ${a.l}.`,
  cue_empty_after_stripping: (a) => `${a.n} cue(s) contained only formatting and no text.`,
  cue_numbers_irregular: (a) =>
    `${a.n} cue number(s) were duplicated or out of sequence; file order was used instead.`,
  format_hint_mismatch: () =>
    'The file extension or supplied format disagreed with the content; the content won.',
  encoding_damage: (a) =>
    `${a.n} cue(s) show characters typical of a file decoded with the wrong encoding.`,
  out_of_order: () => 'This cue starts before the one preceding it.',
  overlap: () => 'This cue starts before the previous one ends.',
  overlap_rate: (a) => `${a.n}% of cues overlap the one before them.`,
  zero_duration: () => 'This cue has no duration.',
  very_short: (a) => `This cue lasts ${a.n} ms.`,
  very_long: (a) => `This cue lasts ${a.n} seconds.`,
  large_gap: (a) => `There is a ${a.n}-second gap before this cue.`,
  missing_punctuation: (a) => `Only ${a.n}% of cues end with punctuation.`,
  subtitle_boilerplate: (a) =>
    `This cue matches a known subtitle-distribution pattern (${a.pattern}).`,
  suppressed: (a) => `${a.n} further ${a.kind} warning(s) were not listed individually.`,
} satisfies Record<string, (args: TemplateArgs) => string>;

export type WarningTemplate = keyof typeof TEMPLATES;

interface TemplateArgs {
  /** A count, a percentage, or a duration — always a number. */
  n?: number;
  /** A line number. */
  l?: number;
  /** A warning kind, for the suppression summary. */
  kind?: ParseWarningKind;
  /**
   * The *name* of a boilerplate pattern, never the cue text that matched it. Constrained
   * to the pattern registry's own identifiers, which are ours and not the user's.
   */
  pattern?: string;
}

export class WarningCollector {
  readonly #warnings: ParseWarning[] = [];
  readonly #counts = new Map<ParseWarningKind, number>();

  add(
    kind: ParseWarningKind,
    template: WarningTemplate,
    options: { segmentIndex?: number | null; args?: TemplateArgs } = {},
  ): void {
    const seen = (this.#counts.get(kind) ?? 0) + 1;
    this.#counts.set(kind, seen);
    if (seen > MAX_WARNINGS_PER_KIND) return;

    this.#warnings.push({
      kind,
      segmentIndex: options.segmentIndex ?? null,
      message: TEMPLATES[template](options.args ?? {}).slice(0, MAX_WARNING_MESSAGE_CHARS),
    });
  }

  /** Total occurrences per kind, including the ones the cap suppressed. This is what the
   *  preview screen counts — "3 cues look like subtitle boilerplate" must be the real
   *  number, not the number that fitted. */
  counts(): Record<string, number> {
    return Object.fromEntries(this.#counts);
  }

  finish(): ParseWarning[] {
    const out = [...this.#warnings];
    for (const [kind, total] of this.#counts) {
      if (total > MAX_WARNINGS_PER_KIND) {
        out.push({
          kind,
          segmentIndex: null,
          message: TEMPLATES.suppressed({ n: total - MAX_WARNINGS_PER_KIND, kind }),
        });
      }
    }
    return out;
  }
}
