import { describe, expect, it } from 'vitest';
import {
  MAX_WARNINGS_PER_KIND,
  parseTranscriptContent,
} from '../src/transcript/index.js';

/**
 * Stage 2 exit criterion 11, and `CLAUDE.md` rule 8 applied to a surface that does not look
 * like a render.
 *
 * `transcript_files.parse_warnings_json` is persisted forever and re-served on every
 * transcript read. Anything the parser puts in a warning message is therefore published,
 * unbounded, and outside the escaping anyone thinks to apply.
 */

const SENTINEL = 'ZZQXSENTINELQXZZ';

describe('warning messages never carry transcript content', () => {
  it('keeps a sentinel out of every message, across every warning path', () => {
    // The cue text is a unique string that appears nowhere in the code. If any template
    // ever interpolates cue text — `cue "${text}" is empty` is the tempting one — this
    // fails, whichever path produced it.
    const content = `00:00:05,000 --> 00:00:02,000
${SENTINEL} subtitles by ${SENTINEL}

not a cue block ${SENTINEL}

00:00:01.000 – > 00:00:03.000
<i>${SENTINEL}</i>

00:00:03,000 --> 00:00:03,000
${SENTINEL}
`;
    const result = parseTranscriptContent(content, { filename: `${SENTINEL}.vtt` });
    expect(result.warnings.length).toBeGreaterThan(0);
    for (const warning of result.warnings) {
      expect(warning.message).not.toContain(SENTINEL);
    }
    // The filename is untrusted too, and it is right there in the mismatch warning's
    // reason for existing.
    for (const warning of result.warnings) {
      expect(warning.message).not.toMatch(/\.vtt/);
    }
  });

  it('keeps every message inside the persisted length bound', () => {
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 --> 00:00:01.000
${'sehr langer text '.repeat(200)}
`);
    for (const warning of result.warnings) {
      expect(warning.message.length).toBeLessThanOrEqual(500);
    }
  });
});

describe('warning volume is bounded', () => {
  it('caps a kind and reports how many it suppressed', () => {
    // A three-thousand-cue file with one warning per cue would turn an unbounded TEXT
    // column into a stored amplification vector, re-served on every read.
    const cues: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const mm = String(Math.floor(i / 60)).padStart(2, '0');
      const ss = String(i % 60).padStart(2, '0');
      const s = `00:${mm}:${ss}.000`;
      cues.push(`${s} --> ${s}\nZeile ${i}`);
    }
    const result = parseTranscriptContent(`WEBVTT\n\n${cues.join('\n\n')}\n`);

    const listed = result.warnings.filter(
      (w) => w.kind === 'suspicious_duration' && w.segmentIndex !== null,
    );
    expect(listed).toHaveLength(MAX_WARNINGS_PER_KIND);

    // The suppressed count survives even though the detail does not — the preview screen
    // must be able to say the real number.
    const summary = result.warnings.find((w) => /not listed individually/.test(w.message));
    expect(summary).toBeDefined();
    expect(result.warningsByKind.suspicious_duration).toBe(200);

    const serialized = JSON.stringify(result.warnings);
    expect(serialized.length).toBeLessThan(64 * 1024);
  });
});

describe('regex safety', () => {
  const budget = (label: string, run: () => void) => {
    const started = performance.now();
    run();
    const elapsed = performance.now() - started;
    expect(elapsed, `${label} took ${Math.round(elapsed)}ms`).toBeLessThan(2_000);
  };

  it('survives a long run of tag-opening characters', () => {
    // The tag stripper is `<\/?[a-zA-Z][^>]{0,200}>`: bounded, requiring a letter after
    // `<`, so it cannot backtrack the way `<.*>` would.
    budget('tag flood', () => {
      parseTranscriptContent(
        `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${'<'.repeat(100_000)}\n`,
      );
    });
  });

  it('survives a long run of colons, which the speaker regex scans', () => {
    budget('speaker flood', () => {
      parseTranscriptContent(
        `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${'Aa'.repeat(50_000)}:\n`,
      );
    });
  });

  it('survives a long run of entity-shaped text', () => {
    budget('entity flood', () => {
      parseTranscriptContent(
        `WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n${'&amp'.repeat(50_000)};\n`,
      );
    });
  });

  it('survives many blocks that look almost like cues', () => {
    const blocks: string[] = [];
    for (let i = 0; i < 3_000; i += 1) blocks.push(`${i}\nnot a timing line\nsome text`);
    budget('near-cue flood', () => {
      parseTranscriptContent(`WEBVTT\n\n${blocks.join('\n\n')}\n`);
    });
  });
});

describe('cue retention', () => {
  it('never drops a cue, whatever is wrong with it', () => {
    // §14.2: "never silently discard large transcript regions". Every anomaly below is a
    // warning, and every cue below is still in the output.
    const result = parseTranscriptContent(`WEBVTT

00:00:01.000 --> 00:00:03.000
<i></i>

00:00:03.000 --> 00:00:05.000
Please subscribe!

00:00:05.000 --> 00:00:05.000
Null-Dauer.

00:00:04.000 --> 00:00:06.000
Überlappt und außer der Reihe.
`);
    expect(result.fatal).toBeNull();
    expect(result.segments).toHaveLength(4);
    expect(result.segments.map((s) => s.sequenceIndex)).toEqual([0, 1, 2, 3]);
    // Even the cue that stripped down to nothing keeps its row and its timing — Stage 4
    // needs the gap it occupies.
    expect(result.segments[0]?.rawText).toBe('');
    expect(result.segments[0]?.startMs).toBe(1_000);
  });
});
