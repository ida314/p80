import { describe, expect, it } from 'vitest';
import { BOILERPLATE_PATTERNS, LIMITS, parseTranscriptContent } from '../src/transcript/index.js';

/**
 * Stage 2 step 9 and exit criterion 8.
 *
 * The line these tests police: a warning says the transcript is poor, a fatal says it
 * cannot be used. `06-scoring.md` §4.2 consumes the warnings as a quality dimension shown
 * separately from difficulty, which only works if quality problems stay warnings.
 */

const vtt = (cues: Array<[string, string, string]>) =>
  `WEBVTT\n\n${cues.map(([a, b, t]) => `${a} --> ${b}\n${t}`).join('\n\n')}\n`;

const kinds = (result: { warnings: Array<{ kind: string }> }) =>
  result.warnings.map((w) => w.kind);

describe('hard failures', () => {
  it('refuses a transcript whose line ends before it starts', () => {
    // No non-arbitrary repair exists, and a negative duration breaks click-to-seek, which
    // is this stage's own exit criterion 3.
    const result = parseTranscriptContent(
      vtt([['00:00:05.000', '00:00:02.000', 'Rückwärts.']]),
    );
    expect(result.fatal?.code).toBe('TRANSCRIPT_INVALID_TIMESTAMPS');
    expect(result.fatal?.details).toMatchObject({ startMs: 5_000, endMs: 2_000 });
    // The user gets the offending index so they can fix the file rather than guess.
    expect(result.fatal?.details).toHaveProperty('segmentIndex', 0);
    expect(result.segments).toEqual([]);
  });

  it('refuses a file that parses into nothing', () => {
    const result = parseTranscriptContent('WEBVTT\n\nNOTE only a comment\n');
    expect(result.fatal?.code).toBe('TRANSCRIPT_NO_SEGMENTS');
  });

  it('refuses a single cue larger than the per-cue limit', () => {
    // The one-cue-two-megabytes shape: a whole document posing as a subtitle.
    const huge = 'a'.repeat(LIMITS.maxSegmentChars + 1);
    const result = parseTranscriptContent(
      vtt([['00:00:01.000', '00:00:03.000', huge]]),
    );
    expect(result.fatal?.code).toBe('TRANSCRIPT_TOO_LARGE');
    expect(result.fatal?.details).toMatchObject({ limit: LIMITS.maxSegmentChars });
  });

  it('refuses more cues than the limit', () => {
    const cues: Array<[string, string, string]> = [];
    for (let i = 0; i < LIMITS.maxSegments + 1; i += 1) {
      const start = `00:00:${String(i % 60).padStart(2, '0')}.000`;
      cues.push([start, start, `Zeile ${i}`]);
    }
    const result = parseTranscriptContent(vtt(cues));
    expect(result.fatal?.code).toBe('TRANSCRIPT_TOO_LARGE');
  });

  it('still returns the parse warnings when it fails, so the preview can explain why', () => {
    // Showing the user what is wrong before they commit is why the preview endpoint
    // exists. A failure that returned nothing would leave that screen blank.
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 --> 00:00:03.000
Erste.

this block has no timing line

00:00:05,000 --> 00:00:02,000
Rückwärts.
`);
    expect(result.fatal?.code).toBe('TRANSCRIPT_INVALID_TIMESTAMPS');
    expect(kinds(result)).toContain('unparsed_region');
    expect(result.warnings.some((w) => /decimal separator/.test(w.message))).toBe(true);
  });

  it('does not compute quality warnings on a file it has already rejected', () => {
    // Deliberate: overlap, ordering, and duration statistics computed across a cue whose
    // end precedes its start describe nothing real. Reporting them would give the user
    // three problems to chase when they have one.
    const result = parseTranscriptContent(
      vtt([
        ['00:00:01.000', '00:00:03.000', 'Erste'],
        ['00:00:05.000', '00:00:02.000', 'Rückwärts'],
      ]),
    );
    expect(result.fatal?.code).toBe('TRANSCRIPT_INVALID_TIMESTAMPS');
    expect(kinds(result)).not.toContain('overlapping_timestamps');
    expect(kinds(result)).not.toContain('suspicious_duration');
  });
});

describe('quality warnings', () => {
  it('records out-of-order cues without reordering them', () => {
    // Storage is file order; display order is time order. Re-sorting during the parse
    // would break correspondence to the file on disk and to its cue numbers, and
    // reordering a transcript is a decision that belongs to the user.
    const result = parseTranscriptContent(
      vtt([
        ['00:00:05.000', '00:00:07.000', 'Zweite'],
        ['00:00:01.000', '00:00:03.000', 'Erste'],
      ]),
    );
    expect(result.fatal).toBeNull();
    expect(result.segments.map((s) => s.rawText)).toEqual(['Zweite', 'Erste']);
    expect(result.segments.map((s) => s.sequenceIndex)).toEqual([0, 1]);
    expect(kinds(result)).toContain('out_of_order');
  });

  it('reports a handful of overlaps individually', () => {
    const cues: Array<[string, string, string]> = [];
    for (let i = 0; i < 40; i += 1) {
      cues.push([
        `00:00:${String(i).padStart(2, '0')}.000`,
        `00:00:${String(i + 1).padStart(2, '0')}.000`,
        `Zeile ${i}. Ein Satz.`,
      ]);
    }
    cues[10] = ['00:00:09.500', '00:00:11.000', 'Überlappt. Ein Satz.'];
    const result = parseTranscriptContent(vtt(cues));
    const overlaps = result.warnings.filter((w) => w.kind === 'overlapping_timestamps');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.segmentIndex).toBe(10);
  });

  it('collapses pervasive overlap into one warning naming the rate', () => {
    // YouTube's rolling captions overlap by design. One warning with the rate is useful;
    // three thousand identical ones would bury everything else in the list.
    const cues: Array<[string, string, string]> = [];
    for (let i = 0; i < 40; i += 1) {
      cues.push([
        `00:00:${String(i).padStart(2, '0')}.000`,
        `00:00:${String(i + 2).padStart(2, '0')}.000`,
        `Zeile ${i}. Ein Satz.`,
      ]);
    }
    const result = parseTranscriptContent(vtt(cues));
    const overlaps = result.warnings.filter((w) => w.kind === 'overlapping_timestamps');
    expect(overlaps).toHaveLength(1);
    expect(overlaps[0]?.segmentIndex).toBeNull();
    expect(overlaps[0]?.message).toMatch(/9[0-9]%|100%/);
  });

  it('flags an unpunctuated transcript, which Stage 4 needs to know about', () => {
    const cues: Array<[string, string, string]> = [];
    for (let i = 0; i < 20; i += 1) {
      cues.push([
        `00:00:${String(i).padStart(2, '0')}.000`,
        `00:00:${String(i).padStart(2, '0')}.900`,
        'und dann sagte er',
      ]);
    }
    const result = parseTranscriptContent(vtt(cues));
    expect(kinds(result)).toContain('missing_punctuation');
  });

  it('does not flag a well-punctuated transcript', () => {
    const result = parseTranscriptContent(
      vtt([
        ['00:00:01.000', '00:00:03.000', 'Guten Tag.'],
        ['00:00:03.000', '00:00:05.000', 'Wie geht es Ihnen?'],
      ]),
    );
    expect(kinds(result)).not.toContain('missing_punctuation');
  });

  it('flags suspicious durations and large gaps', () => {
    const result = parseTranscriptContent(
      vtt([
        ['00:00:01.000', '00:00:01.000', 'Null.'],
        ['00:00:02.000', '00:00:02.010', 'Sehr kurz.'],
        ['00:00:10.000', '00:01:20.000', 'Sehr lang.'],
        ['00:10:00.000', '00:10:02.000', 'Nach einer Lücke.'],
      ]),
    );
    const messages = result.warnings
      .filter((w) => w.kind === 'suspicious_duration')
      .map((w) => w.message);
    expect(messages.some((m) => /no duration/.test(m))).toBe(true);
    expect(messages.some((m) => /10 ms/.test(m))).toBe(true);
    expect(messages.some((m) => /70 seconds/.test(m))).toBe(true);
    expect(messages.some((m) => /gap/.test(m))).toBe(true);
  });
});

describe('subtitle boilerplate — ADR 0013 conformance', () => {
  it('warns about a boilerplate cue and STILL STORES IT', () => {
    // The load-bearing test of ADR 0013 §4. The pattern list came wrapped in a filter that
    // drops these segments silently; taking the list and taking the filter are one
    // copy-paste apart, and P80 does not drop transcript rows.
    const result = parseTranscriptContent(
      vtt([
        ['00:00:01.000', '00:00:03.000', 'Guten Tag.'],
        ['00:00:03.000', '00:00:05.000', 'Subtitles by the Amara.org community'],
        ['00:00:05.000', '00:00:07.000', 'Wie geht es Ihnen?'],
      ]),
    );
    expect(result.segments).toHaveLength(3);
    expect(result.segments[1]?.rawText).toBe('Subtitles by the Amara.org community');
    expect(kinds(result)).toContain('subtitle_boilerplate');
  });

  it('counts boilerplate cues so the preview can say how many', () => {
    const result = parseTranscriptContent(
      vtt([
        ['00:00:01.000', '00:00:03.000', 'Please subscribe to the channel.'],
        ['00:00:03.000', '00:00:05.000', '[Music]'],
        ['00:00:05.000', '00:00:07.000', 'Untertitel von amara.org'],
      ]),
    );
    // ADR 0013's own words: "The user sees '3 cues look like subtitle boilerplate' on the
    // transcript-preview screen and decides."
    expect(result.warningsByKind.subtitle_boilerplate).toBe(3);
    expect(result.segments).toHaveLength(3);
  });

  it('does not flag an ordinary cue that merely contains a marker', () => {
    // `[Music]` alone is not a transcript line. `[Music] Guten Tag` is.
    const result = parseTranscriptContent(
      vtt([['00:00:01.000', '00:00:03.000', '[Music] Guten Tag.']]),
    );
    expect(kinds(result)).not.toContain('subtitle_boilerplate');
  });

  it('names the pattern, never the cue text, in the warning', () => {
    const result = parseTranscriptContent(
      vtt([['00:00:01.000', '00:00:03.000', 'Subtitles by SECRETSENTINEL']]),
    );
    const warning = result.warnings.find((w) => w.kind === 'subtitle_boilerplate');
    expect(warning?.message).toContain('subtitles_by');
    expect(warning?.message).not.toContain('SECRETSENTINEL');
  });

  it('has a pattern for every name it advertises, and every pattern is bounded', () => {
    for (const { name, pattern } of BOILERPLATE_PATTERNS) {
      expect(name).toMatch(/^[a-z0-9_]+$/);
      // No nested quantifier — these run over attacker-controlled text.
      expect(pattern.source).not.toMatch(/\([^)]*[+*]\)[+*]/);
    }
  });
});
