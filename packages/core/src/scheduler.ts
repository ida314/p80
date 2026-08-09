/**
 * FSRS scheduling, wrapped exactly once.
 *
 * `05-cards-and-review.md` §5: use `ts-fsrs`, do not write a scheduler. This module is the
 * only place in the codebase that imports it, so the library's vocabulary — numeric
 * `Rating`, numeric `State`, `Date`-valued fields — stops here and P80's vocabulary
 * continues past it.
 *
 * **`cards` is the single authority for scheduling state.** `fsrs_state_json` holds the
 * snapshot below and `due_at` is denormalised from it for querying; both are written in
 * the same statement, never separately. `SkillState` (`01-domain-model.md` §2.1) is
 * projected on read and never stored.
 *
 * ## Why the snapshot is not the library's `Card`
 *
 * `ts-fsrs` carries `Date` objects and SQLite stores integers, so something has to
 * translate. Persisting the library's object shape directly would work today and would
 * make the stored rows a hostage to its field names — `elapsed_days` is already
 * deprecated for removal in its 6.0. The snapshot is P80's own shape, converted at this
 * boundary, so a library upgrade is a change to this file rather than a migration.
 *
 * The round trip is pinned by a test that goes through the database rather than through
 * memory, because a `Date` that survives `JSON.stringify` as an ISO string and comes back
 * as a string still compares, still sorts, and is no longer a date.
 */

import {
  Rating,
  State,
  createEmptyCard,
  fsrs,
  type Card as FsrsCard,
  type Grade,
} from 'ts-fsrs';
import type { SchedulerRating } from './domain.js';

/** §5: "Ratings map directly." The learner's word is the scheduler's grade, with no
 *  reinterpretation in between — §4's grading policy already put the human at the end of
 *  the pipeline, and a translation layer here would quietly undo that. */
const RATING_TO_GRADE: Readonly<Record<SchedulerRating, Grade>> = {
  again: Rating.Again,
  hard: Rating.Hard,
  good: Rating.Good,
  easy: Rating.Easy,
};

export const FSRS_PHASES = [
  'not_started',
  'learning',
  'review',
  'relearning',
  'suspended',
] as const;
export type FsrsPhase = (typeof FSRS_PHASES)[number];

/** The stored half of a phase. `suspended` is a card-status fact, not an FSRS state, and
 *  is applied by the projection rather than by the scheduler. */
const STATE_TO_PHASE: Readonly<Record<State, Exclude<FsrsPhase, 'suspended'>>> = {
  [State.New]: 'not_started',
  [State.Learning]: 'learning',
  [State.Review]: 'review',
  [State.Relearning]: 'relearning',
};

const PHASE_TO_STATE: Readonly<Record<Exclude<FsrsPhase, 'suspended'>, State>> = {
  not_started: State.New,
  learning: State.Learning,
  review: State.Review,
  relearning: State.Relearning,
};

/**
 * What `cards.fsrs_state_json` contains. Every timestamp is epoch milliseconds, matching
 * the rest of the schema (`02-database.md`, conventions).
 */
export interface FsrsSnapshot {
  due: number;
  stability: number;
  difficulty: number;
  /** Deprecated upstream for removal in `ts-fsrs` 6.0. Kept because the library still
   *  reads it, and dropping it from the snapshot would mean reconstructing it on load. */
  elapsedDays: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  phase: Exclude<FsrsPhase, 'suspended'>;
  lastReview: number | null;
}

/** MVP uses defaults. Parameter optimisation is deferred to post-MVP Phase G
 *  (`05-cards-and-review.md` §5), so nothing here reads a profile or a setting. */
const scheduler = fsrs();

function toSnapshot(card: FsrsCard): FsrsSnapshot {
  return {
    due: card.due.getTime(),
    stability: card.stability,
    difficulty: card.difficulty,
    elapsedDays: card.elapsed_days,
    scheduledDays: card.scheduled_days,
    learningSteps: card.learning_steps,
    reps: card.reps,
    lapses: card.lapses,
    phase: STATE_TO_PHASE[card.state],
    lastReview: card.last_review ? card.last_review.getTime() : null,
  };
}

function fromSnapshot(snapshot: FsrsSnapshot): FsrsCard {
  return {
    due: new Date(snapshot.due),
    stability: snapshot.stability,
    difficulty: snapshot.difficulty,
    elapsed_days: snapshot.elapsedDays,
    scheduled_days: snapshot.scheduledDays,
    learning_steps: snapshot.learningSteps,
    reps: snapshot.reps,
    lapses: snapshot.lapses,
    state: PHASE_TO_STATE[snapshot.phase],
    ...(snapshot.lastReview === null ? {} : { last_review: new Date(snapshot.lastReview) }),
  };
}

/** A card that has never been reviewed. Due immediately: a new card's availability is a
 *  session-builder decision (the new-item limit), not a scheduling one. */
export function newSchedule(at: number): FsrsSnapshot {
  return toSnapshot(createEmptyCard(new Date(at)));
}

export interface RatingOutcome {
  snapshot: FsrsSnapshot;
  /** Denormalised onto `cards.due_at` in the same statement that writes the snapshot. */
  dueAt: number;
  lastReviewedAt: number;
  /** True when this rep moved the card out of `review` — a lapse, which §8 prioritises. */
  lapsed: boolean;
}

export function applyRating(
  snapshot: FsrsSnapshot,
  rating: SchedulerRating,
  at: number,
): RatingOutcome {
  const before = fromSnapshot(snapshot);
  const { card } = scheduler.next(before, new Date(at), RATING_TO_GRADE[rating]);
  const next = toSnapshot(card);
  return {
    snapshot: next,
    dueAt: next.due,
    lastReviewedAt: at,
    lapsed: next.lapses > snapshot.lapses,
  };
}

/**
 * `01-domain-model.md` §2.1 — a derived view, never a stored column.
 *
 * `lastRating` is not in the snapshot because FSRS does not keep it; it comes from the
 * most recent `reviews` row, which is the append-only record of what the learner actually
 * said. Reading it from the scheduler instead would make the displayed history a
 * reconstruction rather than the log.
 */
export interface SkillState {
  cardId: string | null;
  phase: FsrsPhase;
  dueAt: number | null;
  lastRating: SchedulerRating | null;
  successCount: number;
  lapseCount: number;
}

/** The projection for a card type that has no card row yet. */
export function emptySkillState(): SkillState {
  return {
    cardId: null,
    phase: 'not_started',
    dueAt: null,
    lastRating: null,
    successCount: 0,
    lapseCount: 0,
  };
}

export function projectSkillState(input: {
  cardId: string;
  snapshot: FsrsSnapshot | null;
  suspendedAt: number | null;
  lastRating: SchedulerRating | null;
}): SkillState {
  const snapshot = input.snapshot;
  if (!snapshot) {
    return { ...emptySkillState(), cardId: input.cardId };
  }
  return {
    cardId: input.cardId,
    phase: input.suspendedAt === null ? snapshot.phase : 'suspended',
    dueAt: snapshot.due,
    lastRating: input.lastRating,
    // FSRS counts every rep, including the failures. A "success" is a rep that was not a
    // lapse, which is the closest honest reading of a counter the library does not keep.
    successCount: Math.max(0, snapshot.reps - snapshot.lapses),
    lapseCount: snapshot.lapses,
  };
}

/** Parse a stored `fsrs_state_json`. A row that predates a snapshot, or one written by a
 *  path that failed midway, reads as `null` rather than throwing — the card is then
 *  treated as new, which is recoverable, where a throw would make the whole session
 *  unloadable over one bad row. */
export function parseSnapshot(json: string | null): FsrsSnapshot | null {
  if (json === null || json === '') return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return null;
    const candidate = parsed as Partial<FsrsSnapshot>;
    if (typeof candidate.due !== 'number' || typeof candidate.phase !== 'string') return null;
    if (!(candidate.phase in PHASE_TO_STATE)) return null;
    return candidate as FsrsSnapshot;
  } catch {
    return null;
  }
}
