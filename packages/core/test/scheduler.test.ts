import { describe, expect, it } from 'vitest';
import {
  applyRating,
  emptySkillState,
  newSchedule,
  parseSnapshot,
  projectSkillState,
} from '../src/scheduler.js';

/**
 * Stage 3 exit criterion 3 — review ratings update due dates.
 *
 * The interesting assertions here are not "FSRS works", which is the library's problem.
 * They are the two things P80 owns: that the four ratings order correctly against each
 * other, and that the snapshot survives the JSON round trip the database will put it
 * through. The second is the one that would fail silently — a `Date` serialized to an ISO
 * string still compares and still sorts, and is no longer a date.
 */

const T0 = Date.UTC(2026, 7, 9, 9, 0, 0);

describe('newSchedule', () => {
  it('starts a card new, unreviewed, and immediately due', () => {
    const snapshot = newSchedule(T0);
    expect(snapshot.phase).toBe('not_started');
    expect(snapshot.reps).toBe(0);
    expect(snapshot.lapses).toBe(0);
    expect(snapshot.lastReview).toBeNull();
    // Availability of a new card is the session builder's call — the new-item limit — not
    // the scheduler's, so nothing here holds it back.
    expect(snapshot.due).toBeLessThanOrEqual(T0);
  });
});

describe('applyRating', () => {
  it('pushes the due date further out as the rating improves', () => {
    const start = newSchedule(T0);
    const dues = (['again', 'hard', 'good', 'easy'] as const).map(
      (rating) => applyRating(start, rating, T0).dueAt,
    );

    for (let i = 1; i < dues.length; i += 1) {
      expect(dues[i]!).toBeGreaterThan(dues[i - 1]!);
    }
  });

  it('records the review time and advances the rep count', () => {
    const outcome = applyRating(newSchedule(T0), 'good', T0);
    expect(outcome.lastReviewedAt).toBe(T0);
    expect(outcome.snapshot.reps).toBe(1);
    expect(outcome.snapshot.lastReview).toBe(T0);
    expect(outcome.dueAt).toBe(outcome.snapshot.due);
  });

  it('reports a lapse when a reviewing card is failed', () => {
    // Three good reps to reach `review`, then a failure.
    let snapshot = newSchedule(T0);
    let at = T0;
    for (let i = 0; i < 3; i += 1) {
      const out = applyRating(snapshot, 'good', at);
      snapshot = out.snapshot;
      at = out.dueAt;
    }
    expect(snapshot.phase).toBe('review');

    const lapse = applyRating(snapshot, 'again', at);
    expect(lapse.lapsed).toBe(true);
    expect(lapse.snapshot.lapses).toBe(1);
    expect(lapse.snapshot.phase).toBe('relearning');
  });

  it('never lets a failure schedule further out than a pass', () => {
    let snapshot = newSchedule(T0);
    let at = T0;
    for (let i = 0; i < 3; i += 1) {
      const out = applyRating(snapshot, 'good', at);
      snapshot = out.snapshot;
      at = out.dueAt;
    }
    expect(applyRating(snapshot, 'again', at).dueAt).toBeLessThan(
      applyRating(snapshot, 'good', at).dueAt,
    );
  });
});

describe('snapshot round trip', () => {
  /**
   * The named risk in the stage brief: five silent config bugs so far, all of the form
   * "everything reported healthy while being wrong". A snapshot that serializes lossily
   * would produce a card that reschedules from a slightly wrong past on every rep, which
   * no assertion about a single rating would catch.
   */
  it('survives JSON with every field intact and keeps scheduling identically', () => {
    const first = applyRating(newSchedule(T0), 'good', T0).snapshot;
    const restored = parseSnapshot(JSON.stringify(first));

    expect(restored).toEqual(first);

    const later = T0 + 3 * 24 * 60 * 60 * 1000;
    expect(applyRating(restored!, 'hard', later)).toEqual(applyRating(first, 'hard', later));
  });

  it('reads unusable stored state as absent rather than throwing', () => {
    // A row written by a path that died midway must not make a whole session unloadable.
    expect(parseSnapshot(null)).toBeNull();
    expect(parseSnapshot('')).toBeNull();
    expect(parseSnapshot('not json')).toBeNull();
    expect(parseSnapshot('{"due":123}')).toBeNull();
    expect(parseSnapshot('{"due":123,"phase":"nonsense"}')).toBeNull();
  });
});

describe('projectSkillState', () => {
  it('is not_started for a card type with no card', () => {
    expect(emptySkillState()).toMatchObject({ cardId: null, phase: 'not_started' });
  });

  it('reports suspension over the FSRS phase', () => {
    const snapshot = applyRating(newSchedule(T0), 'good', T0).snapshot;
    const state = projectSkillState({
      cardId: 'card-1',
      snapshot,
      suspendedAt: T0 + 1,
      lastRating: 'good',
    });
    expect(state.phase).toBe('suspended');
    // The schedule is still there underneath — suspension is not a reset.
    expect(state.dueAt).toBe(snapshot.due);
  });

  it('counts a success as a rep that was not a lapse', () => {
    let snapshot = newSchedule(T0);
    let at = T0;
    for (const rating of ['good', 'good', 'good'] as const) {
      const out = applyRating(snapshot, rating, at);
      snapshot = out.snapshot;
      at = out.dueAt;
    }
    const failed = applyRating(snapshot, 'again', at).snapshot;

    const state = projectSkillState({
      cardId: 'card-1',
      snapshot: failed,
      suspendedAt: null,
      lastRating: 'again',
    });
    expect(state.lapseCount).toBe(1);
    expect(state.successCount).toBe(failed.reps - 1);
  });
});
