import { describe, expect, it } from 'vitest';
import {
  CLOZE_BLANK,
  DEFAULT_POST_ROLL_MS,
  DEFAULT_PRE_ROLL_MS,
  MIN_CLOZE_CONTEXT_WORDS,
  clipWindow,
  contextWordCount,
  planCards,
  renderCloze,
} from '../src/cards.js';

/** Stage 3 exit criterion 2, the deterministic half. That each card *renders* is manual
 *  check M1; that the right cards are *generated* and that a cloze front is answerable is
 *  here. */

const SENTENCE = 'Ich habe ihn gestern zufaellig in der Stadt getroffen.';
const SPAN_START = SENTENCE.indexOf('zufaellig');
const SPAN_END = SPAN_START + 'zufaellig'.length;

describe('planCards', () => {
  it('gives a word all three cards when the sentence leaves enough context', () => {
    expect(
      planCards({
        itemType: 'word',
        sentenceText: SENTENCE,
        spanStart: SPAN_START,
        spanEnd: SPAN_END,
      }),
    ).toEqual(['audio_recognition', 'contextual_cloze', 'productive_recall']);
  });

  it('drops the cloze when there is not enough context to constrain the answer', () => {
    // §2's "a useful source sentence" — not merely that a sentence exists.
    const short = 'Er kam.';
    const cards = planCards({
      itemType: 'word',
      sentenceText: short,
      spanStart: 0,
      spanEnd: 2,
    });
    expect(cards).not.toContain('contextual_cloze');
    expect(cards).toContain('productive_recall');
  });

  it('defaults a construction away from an audio card', () => {
    const cards = planCards({
      itemType: 'construction',
      sentenceText: SENTENCE,
      spanStart: SPAN_START,
      spanEnd: SPAN_END,
    });
    expect(cards).not.toContain('audio_recognition');
    expect(cards).toEqual(['contextual_cloze', 'productive_recall']);
  });

  it('lets the user override both judgement calls', () => {
    expect(
      planCards({
        itemType: 'construction',
        sentenceText: SENTENCE,
        spanStart: SPAN_START,
        spanEnd: SPAN_END,
        includeAudio: true,
      }),
    ).toContain('audio_recognition');

    expect(
      planCards({
        itemType: 'word',
        sentenceText: 'Er kam.',
        spanStart: 0,
        spanEnd: 2,
        includeCloze: true,
      }),
    ).toContain('contextual_cloze');
  });

  it('always produces at least a productive-recall card', () => {
    const cards = planCards({
      itemType: 'word',
      sentenceText: 'Ja.',
      spanStart: 0,
      spanEnd: 2,
      includeAudio: false,
      includeCloze: false,
    });
    expect(cards).toEqual(['productive_recall']);
  });

  it('returns cards in a stable order regardless of how they were decided', () => {
    const a = planCards({
      itemType: 'multiword_expression',
      sentenceText: SENTENCE,
      spanStart: SPAN_START,
      spanEnd: SPAN_END,
      includeAudio: true,
      includeCloze: true,
    });
    expect(a).toEqual(['audio_recognition', 'contextual_cloze', 'productive_recall']);
  });
});

describe('contextWordCount', () => {
  it('counts only the words outside the span', () => {
    expect(
      contextWordCount({ sentenceText: SENTENCE, spanStart: SPAN_START, spanEnd: SPAN_END }),
    ).toBe(8);
    expect(contextWordCount({ sentenceText: 'Er kam.', spanStart: 0, spanEnd: 2 })).toBe(1);
    expect(contextWordCount({ sentenceText: 'Er kam.', spanStart: 0, spanEnd: 2 })).toBeLessThan(
      MIN_CLOZE_CONTEXT_WORDS,
    );
  });
});

describe('renderCloze', () => {
  it('blanks the span and leaves the rest of the sentence intact', () => {
    const front = renderCloze({
      sentenceText: SENTENCE,
      spanStart: SPAN_START,
      spanEnd: SPAN_END,
    });
    expect(front).toBe(`Ich habe ihn gestern ${CLOZE_BLANK} in der Stadt getroffen.`);
    expect(front).not.toContain('zufaellig');
  });

  it('blanks only the selected occurrence when the word repeats', () => {
    // Textual replacement would blank both and turn one retrieval into two, which §1
    // rule 1 says measures neither.
    const text = 'Er kam und er ging.';
    const second = text.lastIndexOf('er');
    expect(renderCloze({ sentenceText: text, spanStart: second, spanEnd: second + 2 })).toBe(
      `Er kam und ${CLOZE_BLANK} ging.`,
    );
  });

  it('clamps offsets rather than producing a broken front', () => {
    expect(renderCloze({ sentenceText: 'Hallo', spanStart: -5, spanEnd: 99 })).toBe(CLOZE_BLANK);
  });
});

describe('clipWindow', () => {
  it('adds pre-roll and post-roll and keeps the item span for highlighting', () => {
    expect(clipWindow({ startMs: 10_000, endMs: 10_800 })).toEqual({
      startMs: 10_000 - DEFAULT_PRE_ROLL_MS,
      endMs: 10_800 + DEFAULT_POST_ROLL_MS,
      itemStartMs: 10_000,
      itemEndMs: 10_800,
    });
  });

  it('does not run off either end of the video', () => {
    expect(clipWindow({ startMs: 100, endMs: 400, durationMs: 900 })).toMatchObject({
      startMs: 0,
      endMs: 900,
    });
  });

  it('honours an adjusted pre-roll, which §11 requires', () => {
    expect(clipWindow({ startMs: 5_000, endMs: 5_500, preRollMs: 0, postRollMs: 0 })).toMatchObject(
      { startMs: 5_000, endMs: 5_500 },
    );
  });
});
