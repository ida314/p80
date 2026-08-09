import { describe, expect, it } from 'vitest';
import { parseTranscriptContent } from '../src/transcript/index.js';
import { decodeEntitiesOnce } from '../src/transcript/cue-text.js';
import { parseTimecode } from '../src/transcript/timecode.js';

/**
 * Stage 2 steps 5-7 and 9. Spec §34.1 lists "transcript parsers" and "timestamp
 * normalization" as the first two unit-test subjects in the whole project.
 *
 * Fixtures are inline rather than on disk: each one is small, each isolates one anomaly,
 * and reading the case next to its assertion is worth more here than reuse.
 */

const kinds = (result: { warnings: Array<{ kind: string }> }) =>
  result.warnings.map((w) => w.kind);

describe('parseTimecode', () => {
  it('reads a fraction as a decimal, not as a millisecond count', () => {
    // `.5` is half a second. The intuitive-but-wrong reading (5 ms) would shift every
    // timestamp in a file written with one- or two-digit fractions.
    expect(parseTimecode('00:00:01.5')?.ms).toBe(1_500);
    expect(parseTimecode('00:00:01.05')?.ms).toBe(1_050);
    expect(parseTimecode('00:00:01.005')?.ms).toBe(1_005);
    expect(parseTimecode('00:00:01.500')?.ms).toBe(1_500);
  });

  it('disambiguates MM:SS from HH:MM:SS', () => {
    expect(parseTimecode('01:30')?.ms).toBe(90_000);
    expect(parseTimecode('01:30:00')?.ms).toBe(5_400_000);
  });

  it('accepts either decimal separator and records which one', () => {
    expect(parseTimecode('00:00:01,500')?.ms).toBe(1_500);
    expect(parseTimecode('00:00:01,500')?.anomalies).toContain('comma_decimal');
    expect(parseTimecode('00:00:01.500')?.anomalies).toContain('dot_decimal');
  });

  it('normalizes minutes and seconds past 59 arithmetically', () => {
    expect(parseTimecode('00:60:00')?.ms).toBe(3_600_000);
  });

  it('rejects a value past 24 hours rather than returning a huge number', () => {
    expect(parseTimecode('99:99:99,999')).toBeNull();
    expect(parseTimecode('not a time')).toBeNull();
    expect(parseTimecode('')).toBeNull();
  });
});

describe('decodeEntitiesOnce', () => {
  it('decodes exactly once, so a double-encoded entity stays literal', () => {
    // The file said "print the text &lt;". Decoding to a fixed point would produce `<`,
    // which is the classic double-decode bug: we would have manufactured markup the file
    // deliberately escaped.
    expect(decodeEntitiesOnce('&amp;lt;')).toBe('&lt;');
    expect(decodeEntitiesOnce('&amp;')).toBe('&');
    expect(decodeEntitiesOnce('a &lt;b&gt; c')).toBe('a <b> c');
  });

  it('leaves an unknown entity alone rather than guessing', () => {
    expect(decodeEntitiesOnce('&notreal; &copy;')).toBe('&notreal; &copy;');
  });

  it('refuses numeric entities that smuggle a control or a surrogate', () => {
    // A numeric entity is a perfectly good way to hide U+202E from someone reading the
    // raw file. `normalizeTranscriptText` would strip it later, but not decoding it is
    // the earlier and better place to stop.
    expect(decodeEntitiesOnce('&#8238;')).toBe('&#8238;');
    expect(decodeEntitiesOnce('&#0;')).toBe('&#0;');
    expect(decodeEntitiesOnce('&#xD800;')).toBe('&#xD800;');
    expect(decodeEntitiesOnce('&#65;')).toBe('A');
    expect(decodeEntitiesOnce('&#x41;')).toBe('A');
  });
});

describe('WebVTT', () => {
  const simple = `WEBVTT

00:00:01.000 --> 00:00:03.000
Guten Tag.

00:00:03.000 --> 00:00:05.000
Wie geht es Ihnen?
`;

  it('parses cues in file order with exact timings', () => {
    const result = parseTranscriptContent(simple);
    expect(result.format).toBe('vtt');
    expect(result.fatal).toBeNull();
    expect(result.segments).toEqual([
      { startMs: 1_000, endMs: 3_000, speakerLabel: null, rawText: 'Guten Tag.', sequenceIndex: 0 },
      { startMs: 3_000, endMs: 5_000, speakerLabel: null, rawText: 'Wie geht es Ihnen?', sequenceIndex: 1 },
    ]);
  });

  it('tolerates a BOM, CRLF line endings, and no trailing newline', () => {
    const messy = `﻿WEBVTT\r\n\r\n00:00:01.000 --> 00:00:03.000\r\nGuten Tag.`;
    const result = parseTranscriptContent(messy);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.rawText).toBe('Guten Tag.');
    // A BOM is what Windows tooling writes. Warning about it would train users to ignore
    // warnings.
    expect(kinds(result)).not.toContain('encoding_fallback');
  });

  it('skips NOTE, STYLE and REGION blocks silently — they are valid structure', () => {
    const result = parseTranscriptContent(`WEBVTT
Kind: captions
Language: de

NOTE This is a comment
spanning two lines.

STYLE
::cue { color: yellow }

REGION
id:r1 width:40%

00:00:01.000 --> 00:00:03.000
Guten Tag.
`);
    expect(result.segments).toHaveLength(1);
    expect(kinds(result)).not.toContain('unparsed_region');
  });

  it('ignores cue identifiers and cue settings on the timing line', () => {
    const result = parseTranscriptContent(`WEBVTT

intro-cue
00:00:01.000 --> 00:00:03.000 align:start position:0% line:90% size:80%
Guten Tag.
`);
    expect(result.segments).toEqual([
      { startMs: 1_000, endMs: 3_000, speakerLabel: null, rawText: 'Guten Tag.', sequenceIndex: 0 },
    ]);
  });

  it('takes the speaker from a voice span and removes the tag', () => {
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 --> 00:00:03.000
<v.loud Anna>Guten Tag.</v>
`);
    expect(result.segments[0]).toMatchObject({
      speakerLabel: 'Anna',
      rawText: 'Guten Tag.',
    });
  });

  it('strips styling tags and inline karaoke timings', () => {
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 --> 00:00:03.000
<c.yellow><00:00:01.100>Guten <00:00:01.500>Tag</c>, <i>sagte</i> er.
`);
    expect(result.segments[0]?.rawText).toBe('Guten Tag, sagte er.');
  });

  it('joins a multi-line cue with a space but keeps a dialogue dash', () => {
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 --> 00:00:03.000
- Guten Tag.
- Guten Tag auch.
`);
    // Dropping the second dash would destroy the only marker that two people speak here,
    // and no later stage could recover it.
    expect(result.segments[0]?.rawText).toBe('- Guten Tag. - Guten Tag auch.');
  });

  it('warns about a non-standard arrow but still parses the cue', () => {
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 – > 00:00:03.000
Guten Tag.
`);
    expect(result.segments).toHaveLength(1);
    expect(kinds(result)).toContain('malformed_line');
  });

  it('warns once, with a count, when a VTT file uses comma decimals', () => {
    const result = parseTranscriptContent(`WEBVTT

00:00:01,000 --> 00:00:03,000
Eins.

00:00:03,000 --> 00:00:05,000
Zwei.
`);
    expect(result.segments).toHaveLength(2);
    const separator = result.warnings.filter((w) => /decimal separator/.test(w.message));
    expect(separator).toHaveLength(1);
    expect(separator[0]?.message).toContain('4');
  });

  it('reports a block with no timing line as an unparsed region, naming the line', () => {
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 --> 00:00:03.000
Guten Tag.

This block has no timing at all
and would otherwise vanish.
`);
    const unparsed = result.warnings.find((w) => w.kind === 'unparsed_region');
    expect(unparsed).toBeDefined();
    expect(unparsed?.message).toMatch(/line 6/);
  });

  it('parses a headerless VTT body and says the header was missing', () => {
    const result = parseTranscriptContent(`00:00:01.000 --> 00:00:03.000
Guten Tag.
`);
    expect(result.format).toBe('vtt');
    expect(result.segments).toHaveLength(1);
    expect(result.warnings.some((w) => /WEBVTT header/.test(w.message))).toBe(true);
  });
});

describe('SubRip', () => {
  const simple = `1
00:00:01,000 --> 00:00:03,000
Guten Tag.

2
00:00:03,000 --> 00:00:05,000
Wie geht es Ihnen?
`;

  it('parses cues in file order', () => {
    const result = parseTranscriptContent(simple);
    expect(result.format).toBe('srt');
    expect(result.segments.map((s) => s.rawText)).toEqual([
      'Guten Tag.',
      'Wie geht es Ihnen?',
    ]);
  });

  it('parses when the cue number line is absent', () => {
    const result = parseTranscriptContent(`00:00:01,000 --> 00:00:03,000
Guten Tag.
`);
    expect(result.segments).toHaveLength(1);
  });

  it('does not eat a bare-number cue text as a cue number', () => {
    // The guard: a number line only counts when a timing line follows it. Without it,
    // `1995` here would be consumed as a cue number and this line of transcript would
    // silently disappear.
    const result = parseTranscriptContent(`00:00:01,000 --> 00:00:03,000
1995
`);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.rawText).toBe('1995');
  });

  it('uses file order and warns when cue numbers are irregular', () => {
    const result = parseTranscriptContent(`5
00:00:01,000 --> 00:00:03,000
Erste.

2
00:00:03,000 --> 00:00:05,000
Zweite.
`);
    expect(result.segments.map((s) => s.rawText)).toEqual(['Erste.', 'Zweite.']);
    expect(result.segments.map((s) => s.sequenceIndex)).toEqual([0, 1]);
    expect(result.warnings.some((w) => /cue number/.test(w.message))).toBe(true);
  });

  it('ignores trailing VobSub coordinates and strips SSA overrides', () => {
    const result = parseTranscriptContent(`1
00:00:01,000 --> 00:00:03,000  X1:0 X2:0 Y1:0 Y2:0
{\\an8}{\\i1}Guten Tag.
`);
    expect(result.segments[0]).toMatchObject({
      startMs: 1_000,
      endMs: 3_000,
      rawText: 'Guten Tag.',
    });
  });

  it('decodes entities in cue text exactly once', () => {
    const result = parseTranscriptContent(`1
00:00:01,000 --> 00:00:03,000
Fisch &amp; Chips &lt;laut&gt; &amp;lt;
`);
    expect(result.segments[0]?.rawText).toBe('Fisch & Chips <laut> &lt;');
  });
});

describe('pasted timestamped text', () => {
  it('accepts the shapes a copied transcript panel actually produces', () => {
    const result = parseTranscriptContent(`[00:12] Guten Tag.
00:15 Wie geht es Ihnen?
0:18 - 0:21 Danke, gut.
1:02:03 Und Ihnen?
`);
    expect(result.format).toBe('pasted_timestamped');
    expect(result.segments.map((s) => [s.startMs, s.rawText])).toEqual([
      [12_000, 'Guten Tag.'],
      [15_000, 'Wie geht es Ihnen?'],
      [18_000, 'Danke, gut.'],
      [3_723_000, 'Und Ihnen?'],
    ]);
  });

  it('derives a missing end time from the next cue start', () => {
    const result = parseTranscriptContent(`00:10 Erste Zeile.
00:14 Zweite Zeile.
00:20 Dritte Zeile.
`);
    expect(result.segments.map((s) => [s.startMs, s.endMs])).toEqual([
      [10_000, 14_000],
      [14_000, 20_000],
      // The last cue has nothing to borrow, so it gets a bounded estimate.
      [20_000, 21_000],
    ]);
  });

  it('treats an untimed line as a continuation of the previous cue', () => {
    // This is how wrapped text behaves when pasted. Treating each wrapped line as its own
    // untimed cue would shred every long sentence in the file.
    const result = parseTranscriptContent(`00:10 Das ist ein sehr langer Satz,
der über zwei Zeilen umgebrochen wurde.
00:20 Und der nächste.
`);
    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.rawText).toBe(
      'Das ist ein sehr langer Satz, der über zwei Zeilen umgebrochen wurde.',
    );
  });

  it('warns about a preamble rather than discarding it silently', () => {
    const result = parseTranscriptContent(`Folge 3 — Im Restaurant
Ein Transkript

00:10 Guten Abend.
00:14 Einen Tisch für zwei, bitte.
`);
    expect(result.segments).toHaveLength(2);
    const unparsed = result.warnings.find((w) => w.kind === 'unparsed_region');
    expect(unparsed?.message).toMatch(/2 line/);
  });
});

describe('speaker detection', () => {
  it('accepts an ALL-CAPS label on a single cue', () => {
    const result = parseTranscriptContent(`00:10 ANNA: Guten Tag.
00:14 Wie geht es dir?
`);
    expect(result.segments[0]).toMatchObject({
      speakerLabel: 'ANNA',
      rawText: 'Guten Tag.',
    });
  });

  it('accepts a title-case label that recurs across cues', () => {
    const result = parseTranscriptContent(`00:10 Anna: Guten Tag.
00:14 Bernd: Guten Tag auch.
00:18 Anna: Wie geht es dir?
`);
    expect(result.segments.map((s) => s.speakerLabel)).toEqual(['Anna', 'Bernd', 'Anna']);
    expect(result.segments.map((s) => s.rawText)).toEqual([
      'Guten Tag.',
      'Guten Tag auch.',
      'Wie geht es dir?',
    ]);
  });

  it('does NOT treat a one-off German discourse marker as a speaker', () => {
    // The whole reason speaker detection is two-pass. German opens clauses with a colon
    // constantly, and a naive rule would strip the first word off a large share of cues
    // and file it as a name.
    const result = parseTranscriptContent(`00:10 Also: das ist ganz einfach.
00:14 Man nimmt zwei Eier.
00:18 Fazit: es lohnt sich.
`);
    expect(result.segments.map((s) => s.speakerLabel)).toEqual([null, null, null]);
    expect(result.segments[0]?.rawText).toBe('Also: das ist ganz einfach.');
    expect(result.segments[2]?.rawText).toBe('Fazit: es lohnt sich.');
  });

  it('accepts a recurring marker, which is the documented cost of the rule', () => {
    // `Fazit:` three times is indistinguishable from a speaker without a language model,
    // and the rule deliberately errs toward a wrong label over corrupted text.
    const result = parseTranscriptContent(`00:10 Fazit: eins.
00:14 Fazit: zwei.
00:18 Fazit: drei.
`);
    expect(result.segments.map((s) => s.speakerLabel)).toEqual([
      'Fazit',
      'Fazit',
      'Fazit',
    ]);
  });
});

describe('format detection', () => {
  it('lets content beat a disagreeing filename, and says so', () => {
    // A `.srt` file holding WebVTT is routine. Letting an untrusted filename pick the
    // parser is untrusted input reaching control flow.
    const result = parseTranscriptContent(
      `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nGuten Tag.\n`,
      { filename: 'folge-1.srt' },
    );
    expect(result.format).toBe('vtt');
    expect(result.segments).toHaveLength(1);
    expect(result.warnings.some((w) => /disagreed/.test(w.message))).toBe(true);
  });

  it('lets content beat a disagreeing format hint', () => {
    const result = parseTranscriptContent(
      `1\n00:00:01,000 --> 00:00:03,000\nGuten Tag.\n`,
      { formatHint: 'vtt' },
    );
    expect(result.format).toBe('srt');
    expect(result.warnings.some((w) => /disagreed/.test(w.message))).toBe(true);
  });

  it('rejects JSON by name, pointing at the stage that will read it', () => {
    const result = parseTranscriptContent('{"segments": []}');
    expect(result.fatal?.code).toBe('TRANSCRIPT_FORMAT_UNRECOGNIZED');
    expect(result.fatal?.message).toMatch(/Stage 13/);
  });

  it('rejects prose that merely mentions a time', () => {
    const result = parseTranscriptContent(
      'Dies ist ein Aufsatz über Sprachen.\nEr beginnt um 10:30 und dauert lange.\nEs gibt keine Zeitstempel.\n',
    );
    expect(result.fatal?.code).toBe('TRANSCRIPT_FORMAT_UNRECOGNIZED');
  });

  it('flags mojibake as encoding damage without repairing it', () => {
    // Repairing would be hand-editing untrusted content, and it would desynchronise the
    // stored text from the checksummed file on disk. The user re-exports.
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 --> 00:00:03.000
Das MÃ¤dchen ist grÃ¶ÃŸer.
`);
    expect(kinds(result)).toContain('encoding_fallback');
    expect(result.segments[0]?.rawText).toBe('Das MÃ¤dchen ist grÃ¶ÃŸer.');
  });
});
