/**
 * Turning a flat word array into displayable segments, and resolving a span to a time
 * range across both timing tiers (ADR 0017).
 *
 * **This is not sentence segmentation.** Stage 4 does that properly — three-signal noisy-OR
 * fusion over punctuation, a boundary model, and pauses (ADR 0013), against a labelled
 * corpus. What is here is a *display* grouping so an ASR transcript has cues to render in
 * the same list an uploaded VTT renders in, and so `transcript_segments` has rows the rest
 * of Stage 2 already knows how to handle.
 *
 * Calling it what it is matters, because the two are easy to confuse and the difference is
 * the whole of Stage 4. When Stage 4 lands, `sentences` becomes the linguistic unit and
 * these groups stay what they always were: lines on a screen.
 *
 * Pure — no clock, no database, no I/O — so `apps/web` can preview a grouping and the
 * worker can persist one and neither holds the logic (ADR 0007).
 */

/** The shape both the ASR provider and the stored rows share. */
export interface TimedWord {
  text: string;
  startMs: number;
  endMs: number;
  confidence?: number | null;
}

export interface WordGroup {
  startMs: number;
  endMs: number;
  text: string;
  /** Half-open: `[wordStartIndex, wordEndIndex)`. */
  wordStartIndex: number;
  wordEndIndex: number;
  /** Mean of the words' alignment confidences, or null when none of them had one. Stored
   *  on the segment so a doubtful line is visible without joining to the word array. */
  confidence: number | null;
}

export interface GroupWordsOptions {
  /** A gap at least this long ends a group. 700 ms is a comfortable clause boundary in
   *  speech and well above the inter-word gaps forced alignment produces. */
  maxGapMs?: number;
  /** Hard ceiling, so one uninterrupted monologue does not become a single unreadable
   *  cue. Both limits exist because either alone has a degenerate case. */
  maxDurationMs?: number;
  maxWords?: number;
}

const DEFAULTS = {
  maxGapMs: 700,
  maxDurationMs: 8_000,
  maxWords: 20,
} as const;

/**
 * Group words into cue-sized runs.
 *
 * Terminal punctuation closes a group even when none of the limits is reached, because the
 * model punctuated with access to the audio and that is the cheapest good signal available
 * here (ADR 0016 §5). It is a heuristic and it is allowed to be — nothing downstream in
 * Stage 2 depends on a group being a sentence, and Stage 4 will not read these boundaries
 * at all. It reads the word array.
 */
export function groupWords(
  words: readonly TimedWord[],
  options: GroupWordsOptions = {},
): WordGroup[] {
  const maxGapMs = options.maxGapMs ?? DEFAULTS.maxGapMs;
  const maxDurationMs = options.maxDurationMs ?? DEFAULTS.maxDurationMs;
  const maxWords = options.maxWords ?? DEFAULTS.maxWords;

  const groups: WordGroup[] = [];
  let start = 0;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i]!;
    const next = words[i + 1];
    const first = words[start]!;

    const closes =
      next === undefined ||
      next.startMs - word.endMs >= maxGapMs ||
      next.endMs - first.startMs > maxDurationMs ||
      i - start + 1 >= maxWords ||
      /[.!?…]["'»]?$/.test(word.text);

    if (closes) {
      groups.push(toGroup(words, start, i + 1));
      start = i + 1;
    }
  }

  return groups;
}

function toGroup(words: readonly TimedWord[], from: number, to: number): WordGroup {
  const slice = words.slice(from, to);
  const scored = slice.filter((w) => w.confidence != null);
  return {
    startMs: slice[0]!.startMs,
    endMs: slice[slice.length - 1]!.endMs,
    // A single space, because the word array carries no spacing information. Restoring
    // German orthography exactly is not this function's job and guessing at it would put
    // invented text into a column that is supposed to be evidence.
    text: slice.map((w) => w.text).join(' '),
    wordStartIndex: from,
    wordEndIndex: to,
    confidence:
      scored.length > 0
        ? scored.reduce((sum, w) => sum + (w.confidence ?? 0), 0) / scored.length
        : null,
  };
}

/**
 * Map a character selection inside a segment's rendered text onto word offsets.
 *
 * The browser gives a selection in characters, and `resolveSpanTiming` wants half-open
 * word offsets. The mapping is exact rather than approximate because a word-tier segment's
 * text is *defined* as its words joined by one space (`toGroup`, above) — so walking the
 * array with a cursor reproduces the rendered string character for character.
 *
 * Returns null when the segment's text was not built that way, which is every corrected
 * segment and every `cue`-tier one. The caller then has cue timing and nothing finer, which
 * is the honest answer rather than a guess (ADR 0017 §1).
 *
 * A selection that starts or ends mid-word widens to the whole word. Half a word has no
 * clip: forced alignment places words, and a learner asked to hear *laufen* is not served
 * by the audio for *lauf*.
 */
export function charSpanToWordOffsets(
  segmentWords: readonly TimedWord[],
  charStart: number,
  charEnd: number,
): { startOffset: number; endOffset: number } | null {
  if (segmentWords.length === 0) return null;
  if (charEnd <= charStart) return null;

  let cursor = 0;
  let startOffset: number | null = null;
  let endOffset: number | null = null;

  for (let i = 0; i < segmentWords.length; i += 1) {
    const word = segmentWords[i]!;
    const wordStart = cursor;
    const wordEnd = cursor + word.text.length;
    // Overlap, not containment: a selection clipping one character of a word takes it.
    if (charStart < wordEnd && charEnd > wordStart) {
      if (startOffset === null) startOffset = i;
      endOffset = i + 1;
    }
    cursor = wordEnd + 1; // the joining space
  }

  if (startOffset === null || endOffset === null) return null;
  return { startOffset, endOffset };
}

export interface SpanTiming {
  startMs: number;
  endMs: number;
  /** How the range was arrived at. Recorded rather than inferred, because a clip built
   *  from cue timing and one built from word timing are not equally precise and the user
   *  is entitled to know which they got (ADR 0017 §1). */
  precision: 'word' | 'cue';
}

/**
 * The single call site for both fallbacks ADR 0017 §1 requires.
 *
 * A span resolves against the word array when there is one **and** the segment has not
 * been corrected. A correction changes the effective text without changing the words
 * beneath it — the words are the original ASR evidence, the correction is the user's
 * reading — so word indices no longer address the text a caller is asking about, and cue
 * timing is the honest answer.
 *
 * Keeping both fallbacks here rather than at every consumer is the point. Spread across
 * five call sites, one of them eventually forgets the corrected case and silently returns
 * a clip of the wrong words.
 */
export function resolveSpanTiming(args: {
  segment: {
    startMs: number;
    endMs: number;
    wordStartIndex: number | null;
    wordEndIndex: number | null;
    corrected: boolean;
  };
  /** The transcript's words, or null when the tier is `cue`. */
  words: readonly TimedWord[] | null;
  /** Half-open, relative to the segment's own word range. Omit for the whole segment. */
  span?: { startOffset: number; endOffset: number };
}): SpanTiming {
  const { segment, words, span } = args;

  const usable =
    words !== null &&
    !segment.corrected &&
    segment.wordStartIndex !== null &&
    segment.wordEndIndex !== null;

  if (!usable) {
    return { startMs: segment.startMs, endMs: segment.endMs, precision: 'cue' };
  }

  const base = segment.wordStartIndex!;
  const from = base + (span?.startOffset ?? 0);
  const to = base + (span?.endOffset ?? segment.wordEndIndex! - base);

  const first = words![from];
  const last = words![to - 1];
  // An offset past the end of the array is a caller bug, but returning a broken range
  // would surface as a clip that plays nothing. Cue timing is wrong-but-playable, which is
  // the better failure.
  if (first === undefined || last === undefined) {
    return { startMs: segment.startMs, endMs: segment.endMs, precision: 'cue' };
  }

  return { startMs: first.startMs, endMs: last.endMs, precision: 'word' };
}
