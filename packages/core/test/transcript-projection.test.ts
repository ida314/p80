import { describe, expect, it } from 'vitest';
import { projectCorrections, validateSegmentEdit } from '../src/transcript.js';

/**
 * Stage 2 exit criteria 4 and 7 — a user can correct a segment, and the original survives.
 *
 * The architectural invariant this protects: `transcript_segments` is never mutated, so a
 * correction is a *projection* rather than an edit. `06-scoring.md` §4.2 counts corrections
 * as a transcript-quality signal, which only works if they are rows; and §38.4's mitigation
 * for bad captions is source replay, which only works if the original text is still there
 * to replay against.
 */

const base = {
  id: 'seg-1',
  sequenceIndex: 0,
  startMs: 1_000,
  endMs: 3_000,
  speakerLabel: null,
  rawText: 'Ich habe kein Ahnung.',
  normalizedText: 'Ich habe kein Ahnung.',
};

const second = { ...base, id: 'seg-2', sequenceIndex: 1, startMs: 3_000, endMs: 5_000 };

describe('projectCorrections', () => {
  it('leaves an uncorrected segment alone', () => {
    const [projected] = projectCorrections([base], []);
    expect(projected).toMatchObject({
      text: 'Ich habe kein Ahnung.',
      corrected: false,
      correctionId: null,
      startMs: 1_000,
      endMs: 3_000,
    });
  });

  it('applies a correction while carrying the original through untouched', () => {
    const [projected] = projectCorrections(
      [base],
      [
        {
          id: 'c1',
          transcriptSegmentId: 'seg-1',
          afterText: 'Ich habe keine Ahnung.',
          afterStartMs: null,
          afterEndMs: null,
          createdAt: 100,
        },
      ],
    );
    expect(projected?.text).toBe('Ich habe keine Ahnung.');
    expect(projected?.corrected).toBe(true);
    expect(projected?.correctionId).toBe('c1');
    // The original is still readable beside the correction — this is what the row's
    // disclosure shows, and what an item cut from this line must be traceable to.
    expect(projected?.rawText).toBe('Ich habe kein Ahnung.');
    expect(projected?.normalizedText).toBe('Ich habe kein Ahnung.');
  });

  it('applies a timing-only correction without touching the text', () => {
    const [projected] = projectCorrections(
      [base],
      [
        {
          id: 'c1',
          transcriptSegmentId: 'seg-1',
          afterText: null,
          afterStartMs: 500,
          afterEndMs: 2_800,
          createdAt: 100,
        },
      ],
    );
    expect(projected).toMatchObject({
      text: 'Ich habe kein Ahnung.',
      startMs: 500,
      endMs: 2_800,
      corrected: true,
    });
  });

  it('lets the latest correction win while every earlier one survives', () => {
    const corrections = [
      {
        id: 'c1',
        transcriptSegmentId: 'seg-1',
        afterText: 'first attempt',
        afterStartMs: null,
        afterEndMs: null,
        createdAt: 100,
      },
      {
        id: 'c2',
        transcriptSegmentId: 'seg-1',
        afterText: 'second attempt',
        afterStartMs: null,
        afterEndMs: null,
        createdAt: 200,
      },
    ];
    const [projected] = projectCorrections([base], corrections);
    expect(projected?.text).toBe('second attempt');
    expect(projected?.correctionId).toBe('c2');
    // Input order must not matter — the SQL sorts, and so does this.
    const [reversed] = projectCorrections([base], [...corrections].reverse());
    expect(reversed?.text).toBe('second attempt');
  });

  it('breaks a same-millisecond tie by id, matching the SQL secondary sort', () => {
    // Two corrections inside one millisecond is not hypothetical for a keyboard-driven
    // editor. ULIDs are monotonic, so the larger id is the later write.
    const [projected] = projectCorrections(
      [base],
      [
        {
          id: '01JBQZ8K4M3N5P7R9T1V2W3X4Y',
          transcriptSegmentId: 'seg-1',
          afterText: 'earlier',
          afterStartMs: null,
          afterEndMs: null,
          createdAt: 100,
        },
        {
          id: '01JBQZ8K4M3N5P7R9T1V2W3X4Z',
          transcriptSegmentId: 'seg-1',
          afterText: 'later',
          afterStartMs: null,
          afterEndMs: null,
          createdAt: 100,
        },
      ],
    );
    expect(projected?.text).toBe('later');
  });

  it('routes each correction to its own segment', () => {
    const projected = projectCorrections(
      [base, second],
      [
        {
          id: 'c1',
          transcriptSegmentId: 'seg-2',
          afterText: 'only the second',
          afterStartMs: null,
          afterEndMs: null,
          createdAt: 100,
        },
      ],
    );
    expect(projected[0]?.corrected).toBe(false);
    expect(projected[1]?.text).toBe('only the second');
  });

  it('ignores a correction pointing at a segment that is not present', () => {
    const projected = projectCorrections(
      [base],
      [
        {
          id: 'c1',
          transcriptSegmentId: 'seg-nonexistent',
          afterText: 'nowhere',
          afterStartMs: null,
          afterEndMs: null,
          createdAt: 100,
        },
      ],
    );
    expect(projected[0]?.corrected).toBe(false);
  });
});

describe('validateSegmentEdit', () => {
  const current = { startMs: 1_000, endMs: 3_000, text: 'original' };

  it('accepts a text-only edit', () => {
    const result = validateSegmentEdit(current, { text: 'corrected' });
    expect(result).toEqual({
      ok: true,
      merged: { startMs: 1_000, endMs: 3_000, text: 'corrected' },
    });
  });

  it('judges a partial edit against current effective values, not the original', () => {
    // A previous correction already moved `endMs` to 2_000. Moving `startMs` to 2_500 now
    // is incoherent, and it is only visible as incoherent if the merge uses the corrected
    // end rather than the segment's stored one.
    const corrected = { startMs: 1_000, endMs: 2_000, text: 'x' };
    expect(validateSegmentEdit(corrected, { startMs: 2_500 })).toEqual({
      ok: false,
      reason: 'A segment cannot end before it starts.',
    });
  });

  it('rejects an empty patch', () => {
    expect(validateSegmentEdit(current, {})).toMatchObject({ ok: false });
  });

  it('rejects an end before the start', () => {
    expect(validateSegmentEdit(current, { endMs: 500 })).toMatchObject({ ok: false });
  });

  it('rejects a negative start', () => {
    expect(validateSegmentEdit(current, { startMs: -1 })).toMatchObject({ ok: false });
  });

  it('rejects fractional milliseconds', () => {
    expect(validateSegmentEdit(current, { startMs: 1_000.5 })).toMatchObject({ ok: false });
  });

  it('accepts a zero-length segment, because a nudge may legitimately produce one', () => {
    expect(validateSegmentEdit(current, { endMs: 1_000 })).toMatchObject({ ok: true });
  });
});
