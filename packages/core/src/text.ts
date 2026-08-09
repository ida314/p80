/**
 * Transport normalization for transcript text.
 *
 * `transcript_segments.normalized_text` is produced from `raw_text` by this function,
 * between parsing and insertion. It exists so that two cues carrying the same words but
 * different invisible characters compare equal, and so that a transcript view cannot be
 * attacked with direction overrides.
 *
 * **This is not linguistic normalization.** It does not lowercase, and it does not fold
 * dashes. German capitalization is grammatical — `Sie` and `sie` are different words, and
 * every noun is capitalized — so case folding is a language decision belonging to
 * `LanguageAdapter.normalizeOrthography` in Stage 4. The en dash in `Nord-Sued` written
 * with U+2013 is not a hyphen. Keeping the two layers separate is what stops someone
 * lowercasing German nouns here and finding out at Stage 6, when dictionary lookups start
 * missing.
 */

/** Bumped when the output changes, so a stored `normalized_text` can be traced to the
 *  rules that produced it. */
export const TEXT_NORMALIZER_VERSION = '1';

/**
 * Characters that must not survive into stored text, each for its own reason:
 *
 * - **C0 and C1 controls** (keeping `\t\n\r`, which the whitespace passes fold) — they
 *   render unpredictably and can terminate strings in downstream consumers.
 * - **Zero-width characters** — invisible, so two visually identical cues would compare
 *   unequal and produce two observed units in Stage 5.
 * - **Bidi overrides and isolates** (U+202A-U+202E, U+2066-U+2069) — the direct render
 *   attack. A cue containing U+202E displays its remainder reversed, which can make one
 *   sentence read as another in a view the user is trusting as the source of truth.
 *   `CLAUDE.md` rule 8 says escape transcript text on render; this is the part escaping
 *   does not cover, because these are not markup.
 */
const INVISIBLE = new RegExp(
  '[' +
    '\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F' + // C0 and DEL
    '\\u0080-\\u009F' + // C1
    '\\u00AD' + // soft hyphen
    '\\u200B-\\u200F' + // zero-width space and joiners, LRM, RLM
    '\\u202A-\\u202E' + // bidi embeddings and overrides
    '\\u2060-\\u2064' + // word joiner, invisible operators
    '\\u2066-\\u206F' + // bidi isolates, deprecated formatting
    '\\uFEFF' + // byte-order mark anywhere it survived
    ']',
  'g',
);

/** Every Unicode space separator, plus the ones not classified as such. Folded to a plain
 *  space before the run-collapsing pass, so NBSP-padded subtitle text does not survive as
 *  text that nothing will match. */
const UNICODE_SPACE = new RegExp(
  '[\\t\\u00A0\\u1680\\u2000-\\u200A\\u202F\\u205F\\u3000]',
  'g',
);

const QUOTE_FOLDS: ReadonlyArray<readonly [RegExp, string]> = [
  // Typographic double quotes, including the German low-9 opener U+201E.
  [/[“”„‟″«»]/g, '"'],
  // Single quotes and the apostrophe. U+2019 is the common one: a transcript writing
  // `geht's` with a curly apostrophe must match a dictionary writing it straight.
  [/[‘’‚‛′‹›]/g, "'"],
];

/**
 * Idempotent by construction: every pass either removes characters from a fixed set or
 * maps them into it, so a second application has nothing left to do. The test asserts
 * `f(f(x)) === f(x)`, because a normalizer that is not idempotent will eventually be
 * applied twice by accident and silently change stored data.
 */
export function normalizeTranscriptText(input: string): string {
  let out = input.normalize('NFC');
  out = out.replace(INVISIBLE, '');
  out = out.replace(UNICODE_SPACE, ' ');
  for (const [pattern, replacement] of QUOTE_FOLDS) {
    out = out.replace(pattern, replacement);
  }
  // A cue's own line breaks are cosmetic — they are where the subtitle author wrapped.
  out = out.replace(/[\r\n]+/g, ' ');
  out = out.replace(/ {2,}/g, ' ');
  return out.trim();
}
