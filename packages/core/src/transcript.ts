/**
 * The testable core of the synchronized transcript view.
 *
 * ADR 0007: clients hold no domain logic, and the standing test is that a `curl` script
 * can do everything the UI can. Everything here is a pure function precisely so that the
 * transcript view's behaviour is verified by `pnpm test` rather than by a browser runner
 * P80 does not ship until Stage 3.
 */

/** The shape a segment takes once corrections have been projected over it. Matches the
 *  `segmentResponse` the API returns, so nothing has to be reshaped client-side. */
export interface ProjectedSegment {
  id: string;
  sequenceIndex: number;
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  /** As stored. Never mutated after ingestion. */
  rawText: string;
  normalizedText: string;
  /** What the user should read: the latest correction if there is one, else `rawText`. */
  text: string;
  corrected: boolean;
  correctionId: string | null;
}

/**
 * How far before a segment's start to aim the player.
 *
 * Two separate reasons, and they compound. The player begins at the nearest keyframe
 * rather than the requested instant (`04-providers.md` §1, media rule 5), so a seek to
 * exactly `startMs` can land *after* the first syllable — the one part of the line the
 * learner most needs. And §19.1 makes pre-roll a user setting rather than a constant,
 * because how much lead-in reads as natural is a preference.
 *
 * Clamped at zero: a segment at 0:00 has nothing to lead into.
 */
export function seekTargetMs(segment: { startMs: number }, preRollMs: number): number {
  return Math.max(0, segment.startMs - Math.max(0, preRollMs));
}

/**
 * The window a seek may legitimately land in — the testable reading of exit criterion 3's
 * "seeks to the expected region".
 *
 * <!-- REVISED: ADR 0015 -->
 * This used to carry a two-second allowance, because the IFrame player started at the
 * nearest keyframe and P80 was forbidden from measuring the video to find out where the
 * keyframes were. Neither is true now: a `<video>` element seeks a decoded local file
 * precisely, so the tolerance drops to a decoder-rounding allowance and the UI copy that
 * quoted the old number is gone with it.
 *
 * The tolerance is not zero, and that is not hedging. A browser resolves a seek to a
 * sample boundary and reports `currentTime` as a float, so an exact-equality assertion
 * would be a test that fails on a rounding difference. 50 ms is well below anything a
 * listener can hear and well above what any decoder rounds by.
 */
export const SEEK_TOLERANCE_MS = 50;

export function expectedSeekWindow(
  segment: { startMs: number; endMs: number },
  preRollMs: number,
): { earliestMs: number; latestMs: number } {
  const target = seekTargetMs(segment, preRollMs);
  return {
    earliestMs: Math.max(0, target - SEEK_TOLERANCE_MS),
    // A landing at or past the segment's end is a failure however tolerant we are: the
    // line the user clicked would already be over.
    latestMs: segment.endMs,
  };
}

/**
 * The segment to highlight at a given playback position, or `-1` for none.
 *
 * Binary search over `startMs`, because this runs on every playback sample and a
 * three-thousand-cue auto-caption file is ordinary. **Requires segments ordered by
 * `startMs`** — which is exactly the order the API returns them in.
 *
 * Two behaviours worth stating:
 *
 * - **Overlaps resolve to the latest-starting segment that has begun.** YouTube's rolling
 *   captions overlap by design, and the one that started most recently is the one on
 *   screen.
 * - **A gap highlights nothing.** Returning the previous segment would leave a line lit up
 *   through a silence, which reads as "the player is stuck" rather than "nobody is
 *   speaking".
 */
export function activeSegmentIndexAt(
  segments: ReadonlyArray<{ startMs: number; endMs: number }>,
  positionMs: number,
): number {
  let low = 0;
  let high = segments.length - 1;
  let candidate = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (segment === undefined) break;
    if (segment.startMs <= positionMs) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  if (candidate === -1) return -1;
  const found = segments[candidate];
  if (found === undefined) return -1;
  return positionMs < found.endMs ? candidate : -1;
}

/**
 * Latest correction wins, and the original survives beside it.
 *
 * The server does this in SQL (`ROW_NUMBER() OVER (PARTITION BY transcript_segment_id
 * ORDER BY created_at DESC, id DESC)`); this is the same rule as a function, so the
 * projection can be unit-tested without a database and so the ordering rule exists in
 * exactly one readable place.
 *
 * `rawText` is carried through untouched. Anything built on a corrected segment — a Stage
 * 3 item, an occurrence — must reference the segment id, never the projected text, because
 * a later correction changes `text` and must not orphan what was cut from it.
 */
export function projectCorrections<
  S extends {
    id: string;
    sequenceIndex: number;
    startMs: number;
    endMs: number;
    speakerLabel: string | null;
    rawText: string;
    normalizedText: string;
  },
>(
  segments: readonly S[],
  corrections: ReadonlyArray<{
    id: string;
    transcriptSegmentId: string;
    afterText: string | null;
    afterStartMs: number | null;
    afterEndMs: number | null;
    createdAt: number;
  }>,
): ProjectedSegment[] {
  const latest = new Map<string, (typeof corrections)[number]>();
  for (const correction of corrections) {
    const existing = latest.get(correction.transcriptSegmentId);
    // Ties on `createdAt` are real — two corrections inside one millisecond — and the id
    // breaks them, matching the SQL's secondary sort. ULIDs are monotonic, so the larger
    // id is the later write.
    if (
      existing === undefined ||
      correction.createdAt > existing.createdAt ||
      (correction.createdAt === existing.createdAt && correction.id > existing.id)
    ) {
      latest.set(correction.transcriptSegmentId, correction);
    }
  }

  return segments.map((segment) => {
    const correction = latest.get(segment.id);
    return {
      id: segment.id,
      sequenceIndex: segment.sequenceIndex,
      startMs: correction?.afterStartMs ?? segment.startMs,
      endMs: correction?.afterEndMs ?? segment.endMs,
      speakerLabel: segment.speakerLabel,
      rawText: segment.rawText,
      normalizedText: segment.normalizedText,
      text: correction?.afterText ?? segment.rawText,
      corrected: correction !== undefined,
      correctionId: correction?.id ?? null,
    };
  });
}

/**
 * Whether an edit is coherent, checked against the segment's *current effective* values
 * rather than the original — a correction that only moves `startMs` must still be judged
 * against the `endMs` a previous correction set.
 *
 * Returns the merged result so the caller cannot re-derive it differently.
 */
export function validateSegmentEdit(
  current: { startMs: number; endMs: number; text: string },
  patch: { startMs?: number; endMs?: number; text?: string },
): { ok: true; merged: { startMs: number; endMs: number; text: string } } | { ok: false; reason: string } {
  if (patch.startMs === undefined && patch.endMs === undefined && patch.text === undefined) {
    return { ok: false, reason: 'An edit must change the text, the start, or the end.' };
  }

  const merged = {
    startMs: patch.startMs ?? current.startMs,
    endMs: patch.endMs ?? current.endMs,
    text: patch.text ?? current.text,
  };

  if (!Number.isInteger(merged.startMs) || !Number.isInteger(merged.endMs)) {
    return { ok: false, reason: 'Timestamps are whole milliseconds.' };
  }
  if (merged.startMs < 0) {
    return { ok: false, reason: 'A segment cannot start before the video does.' };
  }
  if (merged.endMs < merged.startMs) {
    return { ok: false, reason: 'A segment cannot end before it starts.' };
  }
  return { ok: true, merged };
}
