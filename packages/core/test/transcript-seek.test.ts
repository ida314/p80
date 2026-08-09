import { describe, expect, it } from 'vitest';
import {
  SEEK_TOLERANCE_MS,
  activeSegmentIndexAt,
  expectedSeekWindow,
  seekTargetMs,
} from '../src/transcript.js';

/**
 * Stage 2 exit criterion 3 — "clicking a segment seeks to the expected region".
 *
 * "The expected region" is an interval rather than a millisecond, and this file is the
 * half of the criterion that is a test rather than a manual check.
 *
 * <!-- REVISED: ADR 0015 -->
 * The interval used to be two seconds wide, because the embedded player started at the
 * nearest keyframe and P80 was forbidden from measuring the video to find out where those
 * were. A `<video>` element seeks a decoded local file precisely, so the allowance is now
 * decoder rounding — see `SEEK_TOLERANCE_MS`. It is not zero because a browser resolves a
 * seek to a sample boundary and reports a float, and an exact-equality assertion would
 * fail on arithmetic rather than on behaviour.
 */

const segments = [
  { startMs: 0, endMs: 2_000 },
  { startMs: 2_000, endMs: 4_500 },
  { startMs: 5_000, endMs: 7_000 }, // deliberate gap: nobody is speaking 4.5s-5.0s
  { startMs: 6_500, endMs: 9_000 }, // deliberate overlap, as rolling captions do
];

describe('seekTargetMs', () => {
  it('aims before the segment by the configured pre-roll', () => {
    expect(seekTargetMs({ startMs: 10_000 }, 500)).toBe(9_500);
  });

  it('clamps at zero, because a segment at 0:00 has nothing to lead into', () => {
    expect(seekTargetMs({ startMs: 200 }, 500)).toBe(0);
    expect(seekTargetMs({ startMs: 0 }, 500)).toBe(0);
  });

  it('treats a negative pre-roll as none rather than seeking past the line', () => {
    expect(seekTargetMs({ startMs: 10_000 }, -1_000)).toBe(10_000);
  });

  it('honours pre-roll as a setting, not a constant (§19.1)', () => {
    expect(seekTargetMs({ startMs: 10_000 }, 0)).toBe(10_000);
    expect(seekTargetMs({ startMs: 10_000 }, 2_000)).toBe(8_000);
  });
});

describe('expectedSeekWindow', () => {
  it('allows a rounding allowance early but never past the segment end', () => {
    const window = expectedSeekWindow({ startMs: 10_000, endMs: 12_000 }, 500);
    expect(window.earliestMs).toBe(9_500 - SEEK_TOLERANCE_MS);
    // Landing at or after the end means the line the user clicked is already over. No
    // tolerance makes that acceptable.
    expect(window.latestMs).toBe(12_000);
  });

  it('never proposes a negative earliest bound', () => {
    // A segment near 0:00 has less lead-in than the tolerance, which is the only way this
    // arithmetic can go negative.
    expect(expectedSeekWindow({ startMs: 20, endMs: 900 }, 0).earliestMs).toBe(0);
    expect(expectedSeekWindow({ startMs: 0, endMs: 900 }, 500).earliestMs).toBe(0);
  });

  it('keeps the tolerance small enough that no user could hear it', () => {
    // This constant used to be quoted back to the user, because a two-second imprecision
    // is something a person notices and has to be warned about. It is now an arithmetic
    // allowance and appears in no copy — `test/media-policy.test.ts` asserts the client
    // makes no keyframe claim at all. What is left to check is that it stays inaudible:
    // above roughly 100 ms a listener starts hearing a clipped word onset.
    expect(SEEK_TOLERANCE_MS).toBeLessThanOrEqual(100);
    expect(SEEK_TOLERANCE_MS).toBeGreaterThan(0);
  });
});

describe('activeSegmentIndexAt', () => {
  it('finds the segment containing the position', () => {
    expect(activeSegmentIndexAt(segments, 0)).toBe(0);
    expect(activeSegmentIndexAt(segments, 1_999)).toBe(0);
    expect(activeSegmentIndexAt(segments, 2_000)).toBe(1);
    expect(activeSegmentIndexAt(segments, 4_499)).toBe(1);
  });

  it('highlights nothing in a gap', () => {
    // Keeping the previous line lit through a silence reads as "the player is stuck",
    // which is a different and wrong message.
    expect(activeSegmentIndexAt(segments, 4_500)).toBe(-1);
    expect(activeSegmentIndexAt(segments, 4_900)).toBe(-1);
  });

  it('highlights nothing before the first segment or after the last', () => {
    expect(activeSegmentIndexAt([{ startMs: 1_000, endMs: 2_000 }], 0)).toBe(-1);
    expect(activeSegmentIndexAt(segments, 9_000)).toBe(-1);
    expect(activeSegmentIndexAt(segments, 60_000)).toBe(-1);
  });

  it('resolves an overlap to the latest-starting segment that has begun', () => {
    // YouTube's rolling captions overlap by design. The one that started most recently is
    // the one on screen.
    expect(activeSegmentIndexAt(segments, 6_400)).toBe(2);
    expect(activeSegmentIndexAt(segments, 6_500)).toBe(3);
    expect(activeSegmentIndexAt(segments, 6_999)).toBe(3);
  });

  it('handles an empty transcript', () => {
    expect(activeSegmentIndexAt([], 1_000)).toBe(-1);
  });

  it('stays fast on a transcript the size of a real auto-caption file', () => {
    const many = Array.from({ length: 5_000 }, (_, i) => ({
      startMs: i * 2_000,
      endMs: i * 2_000 + 1_800,
    }));
    // Binary search, because this runs on every playback sample.
    expect(activeSegmentIndexAt(many, 4_000)).toBe(2);
    expect(activeSegmentIndexAt(many, 9_998_000)).toBe(4_999);
    expect(activeSegmentIndexAt(many, 1_700)).toBe(0);
    // Each cue leaves a 200 ms tail before the next begins, and the gap rule holds at
    // scale exactly as it does for four segments.
    expect(activeSegmentIndexAt(many, 1_900)).toBe(-1);

    const started = performance.now();
    for (let i = 0; i < 20_000; i += 1) activeSegmentIndexAt(many, i * 500);
    expect(performance.now() - started).toBeLessThan(500);
  });
});
