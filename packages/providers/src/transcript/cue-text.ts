/**
 * Turning a cue's payload lines into plain text.
 *
 * **The order of the two passes is load-bearing.** Tags are stripped first, entities are
 * decoded second, and decoding happens exactly once. Reversing the order would turn
 * `&lt;i&gt;` — which the file intends as the literal text `<i>` — into a tag that the
 * stripper then deletes, silently losing content. Decoding more than once would turn
 * `&amp;lt;` into `<`, which is the classic double-decode bug: the file said "print
 * `&lt;`" and we would have produced markup.
 *
 * §14.2's parser responsibilities are the specification here: remove formatting tags,
 * preserve punctuation, merge malformed lines when possible.
 */

/**
 * Bounded and linear. Every regex in this file runs over attacker-controlled text, so
 * nothing here nests a quantifier: `[^>]{0,200}` cannot backtrack catastrophically the way
 * `(.*)*` can, and requiring a letter or `/` after `<` means arithmetic like `a < b`
 * survives instead of being eaten as a malformed tag.
 */
const TAG = /<\/?[a-zA-Z][^>]{0,200}>/g;

/** WebVTT inline karaoke timings. YouTube auto-captions are dense with these — a single
 *  cue can carry one per word. */
const INLINE_TIMING = /<\d{1,3}:\d{2}:\d{2}[.,]\d{1,3}>/g;

/** ASS/SSA override blocks, common in SRT files converted from other subtitle formats:
 *  `{\an8}` positions a cue, `{\i1}` italicises it. */
const SSA_OVERRIDE = /\{\\[^}]{0,100}\}/g;

/** A closed set. Anything not listed stays literal, which is the safe direction: an
 *  undecoded entity is visible and wrong, a wrongly decoded one is invisible and wrong. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

const ENTITY = /&(?:([a-zA-Z]{2,8})|#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6}));/g;

/**
 * One pass, never to a fixed point. `replace` with a global regex scans left to right over
 * the *original* string, so a replacement's output is never rescanned — which is exactly
 * the property that makes `&amp;lt;` become the literal `&lt;` rather than `<`.
 */
export function decodeEntitiesOnce(input: string): string {
  return input.replace(ENTITY, (whole, name, decimal, hex) => {
    if (typeof name === 'string') {
      return NAMED_ENTITIES[name.toLowerCase()] ?? whole;
    }
    const code = Number.parseInt(
      typeof decimal === 'string' ? decimal : String(hex),
      typeof decimal === 'string' ? 10 : 16,
    );
    // Reject surrogates, out-of-range scalars, controls other than tab, and every
    // invisible formatting character. A numeric entity is a perfectly good way to smuggle
    // U+202E past someone reading the raw file, and `&#8238;` looks like nothing at all.
    // `normalizeTranscriptText` would strip these later; refusing to decode them is the
    // earlier and better place, because it keeps them visible in `raw_text`.
    if (!Number.isFinite(code) || code > 0x10ffff) return whole;
    if (code >= 0xd800 && code <= 0xdfff) return whole;
    if (code < 0x20 && code !== 0x09) return whole;
    if (code >= 0x7f && code <= 0x9f) return whole;
    if (code === 0xad || code === 0xfeff) return whole;
    if (code >= 0x200b && code <= 0x200f) return whole; // zero-width, LRM, RLM
    if (code >= 0x202a && code <= 0x202e) return whole; // bidi embeddings and overrides
    if (code >= 0x2060 && code <= 0x2064) return whole; // word joiner, invisible operators
    if (code >= 0x2066 && code <= 0x206f) return whole; // bidi isolates
    return String.fromCodePoint(code);
  });
}

export function stripCueMarkup(input: string): string {
  return input.replace(INLINE_TIMING, '').replace(SSA_OVERRIDE, '').replace(TAG, '');
}

/**
 * `rawText` for a cue: markup removed, entities decoded once, lines joined.
 *
 * **Subtitle line breaks are cosmetic** — they are where the caption author wrapped to fit
 * the screen, not where the speaker paused — so lines join with a single space. A leading
 * `- ` on the second and later lines is *kept*: it marks a second speaker in a two-person
 * cue, and dropping it would destroy information no later stage can recover. No attempt is
 * made to split such a cue; that is a decision, and it belongs to the user.
 */
export function cueTextFromLines(lines: readonly string[]): string {
  const cleaned = lines.map((line) => decodeEntitiesOnce(stripCueMarkup(line)).trim());
  return cleaned.filter((line) => line.length > 0).join(' ').trim();
}
