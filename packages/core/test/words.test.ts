import { describe, expect, it } from 'vitest';
import { groupWords, resolveSpanTiming, type TimedWord } from '../src/words.js';

/**
 * ADR 0017 — the word array is the source of truth, segments are ranges over it.
 *
 * Two things are tested here and they are not the same thing. `groupWords` is a *display*
 * grouping, deliberately not sentence segmentation — Stage 4 does that properly, against a
 * labelled corpus. `resolveSpanTiming` is the load-bearing half: it is the single call site
 * where both timing fallbacks live, and getting it wrong means a review card replays the
 * wrong audio.
 */

const w = (text: string, startMs: number, endMs: number, confidence: number | null = 0.9) =>
  ({ text, startMs, endMs, confidence }) satisfies TimedWord;

describe('groupWords', () => {
  it('splits on a pause long enough to be a clause boundary', () => {
    const groups = groupWords(
      [w('Ich', 0, 300), w('fange', 300, 700), w('an', 3_000, 3_400)],
      { maxGapMs: 700 },
    );

    expect(groups).toHaveLength(2);
    expect(groups[0]!.text).toBe('Ich fange');
    expect(groups[1]!.text).toBe('an');
  });

  it('splits on terminal punctuation even when nothing else says to', () => {
    const groups = groupWords([
      w('Guten', 0, 300),
      w('Tag.', 300, 700),
      w('Wie', 750, 900),
      w('geht', 900, 1_100),
    ]);

    // The model punctuated with access to the audio, which is the cheapest good signal
    // available at this stage (ADR 0016 §5).
    expect(groups).toHaveLength(2);
    expect(groups[0]!.text).toBe('Guten Tag.');
  });

  it('caps a group by word count, so a monologue is not one unreadable cue', () => {
    const words = Array.from({ length: 25 }, (_, i) => w(`wort${i}`, i * 100, i * 100 + 90));
    const groups = groupWords(words, { maxWords: 10, maxGapMs: 10_000 });

    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.wordEndIndex - group.wordStartIndex).toBeLessThanOrEqual(10);
    }
  });

  it('caps a group by duration too, because either limit alone has a degenerate case', () => {
    // Few words, each very long — under the word cap, over any readable duration.
    const words = [w('eins', 0, 4_000), w('zwei', 4_100, 9_000), w('drei', 9_100, 14_000)];
    const groups = groupWords(words, { maxDurationMs: 8_000, maxGapMs: 10_000, maxWords: 50 });
    expect(groups.length).toBeGreaterThan(1);
  });

  it('emits half-open index ranges that tile the array exactly', () => {
    const words = Array.from({ length: 30 }, (_, i) => w(`w${i}`, i * 200, i * 200 + 150));
    const groups = groupWords(words);

    // No gap and no overlap. A hole here means a word that no segment addresses, which is
    // a word with text and no clip.
    expect(groups[0]!.wordStartIndex).toBe(0);
    expect(groups[groups.length - 1]!.wordEndIndex).toBe(words.length);
    for (let i = 1; i < groups.length; i += 1) {
      expect(groups[i]!.wordStartIndex).toBe(groups[i - 1]!.wordEndIndex);
    }
  });

  it('takes its timing from the words rather than restating it', () => {
    const groups = groupWords([w('eins', 120, 480), w('zwei.', 500, 900)]);
    expect(groups[0]).toMatchObject({ startMs: 120, endMs: 900 });
  });

  it('averages confidence, and reports null when no word had one', () => {
    expect(groupWords([w('a', 0, 100, 0.8), w('b.', 100, 200, 0.6)])[0]!.confidence).toBeCloseTo(
      0.7,
    );
    // Null means "the aligner did not place these", which is a different fact from a low
    // score and must not be averaged into one.
    expect(groupWords([w('a', 0, 100, null), w('b.', 100, 200, null)])[0]!.confidence).toBeNull();
  });

  it('returns nothing for nothing, rather than an empty group', () => {
    expect(groupWords([])).toEqual([]);
  });
});

describe('resolveSpanTiming', () => {
  const words = [w('Ich', 0, 300), w('fange', 350, 700), w('um', 750, 900), w('acht', 950, 1_400)];

  const segment = {
    startMs: 0,
    endMs: 1_400,
    wordStartIndex: 0,
    wordEndIndex: 4,
    corrected: false,
  };

  it('resolves a span to the exact words it covers', () => {
    const timing = resolveSpanTiming({
      segment,
      words,
      span: { startOffset: 1, endOffset: 2 },
    });

    // This is the whole point of ADR 0017: "replay this word" replays that word, not the
    // line containing it.
    expect(timing).toEqual({ startMs: 350, endMs: 700, precision: 'word' });
  });

  it('falls back to cue timing on a cue-tier transcript', () => {
    const timing = resolveSpanTiming({
      segment: { ...segment, wordStartIndex: null, wordEndIndex: null },
      words: null,
    });
    expect(timing).toEqual({ startMs: 0, endMs: 1_400, precision: 'cue' });
  });

  /**
   * The case that would be forgotten if this logic were spread across consumers.
   *
   * A correction changes the effective text without changing the words beneath it — the
   * words are the original ASR evidence, the correction is the user's reading. So the
   * indices no longer address the text a caller is asking about, and word timing would
   * confidently return a clip of different words.
   */
  it('falls back to cue timing inside a corrected segment', () => {
    const timing = resolveSpanTiming({
      segment: { ...segment, corrected: true },
      words,
      span: { startOffset: 1, endOffset: 2 },
    });
    expect(timing.precision).toBe('cue');
    expect(timing).toMatchObject({ startMs: 0, endMs: 1_400 });
  });

  it('reports which tier it used, rather than leaving the caller to guess', () => {
    expect(resolveSpanTiming({ segment, words }).precision).toBe('word');
    expect(resolveSpanTiming({ segment, words: null }).precision).toBe('cue');
  });

  it('defaults to the whole segment when no span is given', () => {
    expect(resolveSpanTiming({ segment, words })).toEqual({
      startMs: 0,
      endMs: 1_400,
      precision: 'word',
    });
  });

  it('degrades to cue timing rather than returning an unplayable range', () => {
    // An offset past the end of the array is a caller bug. A broken range would surface as
    // a clip that plays nothing; cue timing is wrong-but-playable, which is the better
    // failure and the one a user can report.
    const timing = resolveSpanTiming({
      segment,
      words,
      span: { startOffset: 0, endOffset: 99 },
    });
    expect(timing.precision).toBe('cue');
  });

  it('offsets are relative to the segment, not to the whole transcript', () => {
    // A segment starting at word 2 asked for its own first word must get word 2.
    const later = { startMs: 750, endMs: 1_400, wordStartIndex: 2, wordEndIndex: 4, corrected: false };
    const timing = resolveSpanTiming({
      segment: later,
      words,
      span: { startOffset: 0, endOffset: 1 },
    });
    expect(timing).toEqual({ startMs: 750, endMs: 900, precision: 'word' });
  });
});
