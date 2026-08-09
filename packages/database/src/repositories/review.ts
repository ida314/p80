import {
  ERROR_CODES,
  P80Error,
  newId,
  now,
  type CardType,
  type ContextMode,
  type LearningItemType,
  type SchedulerRating,
  type SessionCandidate,
  type SessionPlan,
  type SessionRequest,
} from '@p80/core';
import type { DatabaseHandle } from '../client.js';

/**
 * Review sessions and the append-only review log.
 *
 * **`reviews` is append-only.** There is no update and no delete in this file, and that is
 * a design constraint rather than an omission: the review history is what makes an item's
 * behaviour interpretable, and §36 makes it inspectable. A rating arrives as an `UPDATE` in
 * exactly one place — `recordRating`, filling in the fields of a row this session already
 * created — and a second rating for the same review is refused rather than absorbed. See
 * `reviews-append-only.test.ts`, which asserts the absence.
 *
 * The `answer` / `rate` split is the other load-bearing shape (`03-api.md` §6). A rep
 * happens before the answer is revealed (§9.9); collapsing the two calls would make a
 * restudy indistinguishable from a retrieval and would measure latency against the wrong
 * moment.
 */

export interface SessionRow {
  id: string;
  profileId: string;
  startedAt: number;
  completedAt: number | null;
  request: SessionRequest;
  plan: SessionPlan | null;
}

interface RawSession {
  id: string;
  profile_id: string;
  started_at: number;
  completed_at: number | null;
  desired_minutes: number | null;
  include_new_items: number;
  include_video_loop: number;
  include_transfer: number;
  include_error_repair: number;
  plan_json: string | null;
  summary_json: string | null;
}

function toSession(row: RawSession): SessionRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    request: {
      desiredMinutes: row.desired_minutes ?? 20,
      includeNewItems: row.include_new_items === 1,
      includeVideoLoop: row.include_video_loop === 1,
      includeTransfer: row.include_transfer === 1,
      includeErrorRepair: row.include_error_repair === 1,
    },
    plan: row.plan_json ? (JSON.parse(row.plan_json) as SessionPlan) : null,
  };
}

/**
 * Everything the session builder needs, in one query.
 *
 * A card is **new** when it has never been reviewed, which is read from `reviews` rather
 * than from the FSRS phase. The two agree in normal operation, but a card whose snapshot
 * failed to parse reads as `not_started` while having a review history, and treating it as
 * new would spend the day's new-item allowance on something the learner has already seen.
 */
export function listSessionCandidates(
  handle: DatabaseHandle,
  profileId: string,
): SessionCandidate[] {
  const rows = handle.sqlite
    .prepare(
      `SELECT c.id            AS card_id,
              c.item_id       AS item_id,
              c.card_type     AS card_type,
              c.due_at        AS due_at,
              i.item_type     AS item_type,
              o.video_id      AS video_id,
              o.sentence_id   AS sentence_id,
              (SELECT COUNT(*) FROM reviews r
                WHERE r.card_id = c.id AND r.scheduler_rating = 'again') AS lapses,
              (SELECT COUNT(*) FROM reviews r
                WHERE r.card_id = c.id AND r.scheduler_rating IS NOT NULL) AS rated
         FROM cards c
         JOIN learning_items i ON i.id = c.item_id
         LEFT JOIN item_occurrences o
                ON o.item_id = c.item_id AND o.is_primary_occurrence = 1
        WHERE c.profile_id = ?
          AND c.status = 'active'
          AND c.suspended_at IS NULL
          AND i.status = 'active'`,
    )
    .all(profileId) as Array<{
    card_id: string;
    item_id: string;
    card_type: string;
    due_at: number | null;
    item_type: string;
    video_id: string | null;
    sentence_id: string | null;
    lapses: number;
    rated: number;
  }>;

  return rows.map((r) => ({
    cardId: r.card_id,
    itemId: r.item_id,
    itemType: r.item_type as LearningItemType,
    cardType: r.card_type as CardType,
    videoId: r.video_id,
    sentenceId: r.sentence_id,
    dueAt: r.due_at,
    lapses: r.lapses,
    isNew: r.rated === 0,
  }));
}

/** Distinct items that received their first rating today, for §7's allowance. */
export function countNewItemsSince(
  handle: DatabaseHandle,
  profileId: string,
  since: number,
): number {
  return (
    (
      handle.sqlite
        .prepare(
          `SELECT COUNT(DISTINCT r.item_id) AS n
             FROM reviews r
             JOIN cards c ON c.id = r.card_id
            WHERE c.profile_id = ?
              AND r.scheduler_rating IS NOT NULL
              AND r.created_at >= ?
              AND NOT EXISTS (
                    SELECT 1 FROM reviews prior
                     WHERE prior.item_id = r.item_id
                       AND prior.scheduler_rating IS NOT NULL
                       AND prior.created_at < ?
                  )`,
        )
        .get(profileId, since, since) as { n: number } | undefined
    )?.n ?? 0
  );
}

/** Observed latencies per card type, for §8's rolling median. Bounded so a long history
 *  does not make session creation slower every week. */
export function recentLatenciesByCardType(
  handle: DatabaseHandle,
  profileId: string,
  perType = 50,
): Record<string, number[]> {
  const rows = handle.sqlite
    .prepare(
      `SELECT card_type, response_latency_ms FROM (
         SELECT r.card_type,
                r.response_latency_ms,
                ROW_NUMBER() OVER (PARTITION BY r.card_type ORDER BY r.created_at DESC) AS rn
           FROM reviews r
           JOIN cards c ON c.id = r.card_id
          WHERE c.profile_id = ? AND r.response_latency_ms IS NOT NULL
       ) WHERE rn <= ?`,
    )
    .all(profileId, perType) as Array<{ card_type: string; response_latency_ms: number }>;

  const out: Record<string, number[]> = {};
  for (const row of rows) {
    (out[row.card_type] ??= []).push(row.response_latency_ms);
  }
  return out;
}

export function createSession(
  handle: DatabaseHandle,
  profileId: string,
  request: SessionRequest,
  plan: SessionPlan,
): SessionRow {
  const id = newId();
  handle.sqlite
    .prepare(
      `INSERT INTO review_sessions
         (id, profile_id, started_at, desired_minutes, include_new_items,
          include_video_loop, include_transfer, include_error_repair, plan_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      profileId,
      now(),
      request.desiredMinutes,
      request.includeNewItems ? 1 : 0,
      request.includeVideoLoop ? 1 : 0,
      request.includeTransfer ? 1 : 0,
      request.includeErrorRepair ? 1 : 0,
      JSON.stringify(plan),
    );
  return getSession(handle, profileId, id) as SessionRow;
}

export function getSession(
  handle: DatabaseHandle,
  profileId: string,
  id: string,
): SessionRow | null {
  const row = handle.sqlite
    .prepare('SELECT * FROM review_sessions WHERE id = ? AND profile_id = ?')
    .get(id, profileId) as RawSession | undefined;
  return row ? toSession(row) : null;
}

export function requireOpenSession(
  handle: DatabaseHandle,
  profileId: string,
  id: string,
): SessionRow {
  const session = getSession(handle, profileId, id);
  if (!session) throw P80Error.notFound('Review session');
  if (session.completedAt !== null) {
    throw P80Error.conflict(
      ERROR_CODES.SESSION_COMPLETE,
      'This review session is finished. Start a new one.',
      { sessionId: id },
    );
  }
  return session;
}

export interface ReviewRow {
  id: string;
  sessionId: string | null;
  cardId: string | null;
  itemId: string | null;
  videoId: string | null;
  cardType: CardType;
  contextMode: ContextMode;
  shownAt: number;
  answeredAt: number | null;
  responseText: string | null;
  responseLatencyMs: number | null;
  machineClassification: string | null;
  schedulerRating: SchedulerRating | null;
  hintCount: number;
  sourceContextUsed: boolean;
  occurrenceId: string | null;
  createdAt: number;
}

interface RawReview {
  id: string;
  session_id: string | null;
  card_id: string | null;
  item_id: string | null;
  video_id: string | null;
  card_type: string;
  context_mode: string;
  shown_at: number;
  answered_at: number | null;
  response_text: string | null;
  response_latency_ms: number | null;
  machine_classification: string | null;
  scheduler_rating: string | null;
  hint_count: number;
  source_context_used: number;
  occurrence_id: string | null;
  created_at: number;
}

function toReview(row: RawReview): ReviewRow {
  return {
    id: row.id,
    sessionId: row.session_id,
    cardId: row.card_id,
    itemId: row.item_id,
    videoId: row.video_id,
    cardType: row.card_type as CardType,
    contextMode: row.context_mode as ContextMode,
    shownAt: row.shown_at,
    answeredAt: row.answered_at,
    responseText: row.response_text,
    responseLatencyMs: row.response_latency_ms,
    machineClassification: row.machine_classification,
    schedulerRating: row.scheduler_rating as SchedulerRating | null,
    hintCount: row.hint_count,
    sourceContextUsed: row.source_context_used === 1,
    occurrenceId: row.occurrence_id,
    createdAt: row.created_at,
  };
}

/** The rows this session has already opened, in the order they were shown. */
export function listSessionReviews(handle: DatabaseHandle, sessionId: string): ReviewRow[] {
  return (
    handle.sqlite
      .prepare('SELECT * FROM reviews WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(sessionId) as RawReview[]
  ).map(toReview);
}

export function getReview(handle: DatabaseHandle, id: string): ReviewRow | null {
  const row = handle.sqlite.prepare('SELECT * FROM reviews WHERE id = ?').get(id) as
    | RawReview
    | undefined;
  return row ? toReview(row) : null;
}

export interface OpenReviewInput {
  sessionId: string;
  cardId: string;
  itemId: string;
  videoId: string | null;
  cardType: CardType;
  /** Always `source` in Stage 3 — transfer needs a second occurrence from a second video. */
  contextMode: ContextMode;
  occurrenceId: string | null;
}

/** A card has been shown. The row exists from this moment so that abandoning a session
 *  mid-card is still recorded — an unanswered review is data about the session, not a
 *  write that failed. */
export function openReview(handle: DatabaseHandle, input: OpenReviewInput): ReviewRow {
  const id = newId();
  const at = now();
  handle.sqlite
    .prepare(
      `INSERT INTO reviews
         (id, session_id, card_id, item_id, video_id, card_type, context_mode,
          shown_at, hint_count, source_context_used, occurrence_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
    )
    .run(
      id,
      input.sessionId,
      input.cardId,
      input.itemId,
      input.videoId,
      input.cardType,
      input.contextMode,
      at,
      input.occurrenceId,
      at,
    );
  return getReview(handle, id) as ReviewRow;
}

/** The retrieval attempt, recorded before the answer is revealed. */
export function recordAttempt(
  handle: DatabaseHandle,
  reviewId: string,
  input: { responseText: string | null; responseLatencyMs: number | null; sourceContextUsed: boolean },
): ReviewRow {
  const review = getReview(handle, reviewId);
  if (!review) throw P80Error.notFound('Review');
  if (review.schedulerRating !== null) {
    throw P80Error.conflict(
      ERROR_CODES.REVIEW_ALREADY_RATED,
      'This card has already been rated. Answering again would rewrite a logged rep.',
      { reviewId },
    );
  }
  handle.sqlite
    .prepare(
      `UPDATE reviews
          SET answered_at = ?, response_text = ?, response_latency_ms = ?,
              source_context_used = ?
        WHERE id = ?`,
    )
    .run(
      now(),
      input.responseText,
      input.responseLatencyMs,
      input.sourceContextUsed ? 1 : 0,
      reviewId,
    );
  return getReview(handle, reviewId) as ReviewRow;
}

export function recordHint(handle: DatabaseHandle, reviewId: string): ReviewRow {
  const review = getReview(handle, reviewId);
  if (!review) throw P80Error.notFound('Review');
  handle.sqlite
    .prepare('UPDATE reviews SET hint_count = hint_count + 1 WHERE id = ?')
    .run(reviewId);
  return getReview(handle, reviewId) as ReviewRow;
}

/**
 * The rating, and the card's new schedule, in one transaction.
 *
 * `fsrs_state_json` and `due_at` are written by the same statement. They are two
 * representations of one fact — `05-cards-and-review.md` §5 requires the denormalised copy
 * for querying — and a path that could write one without the other is a path that produces
 * a card whose stored schedule disagrees with the index used to find it.
 */
export function recordRating(
  handle: DatabaseHandle,
  input: {
    reviewId: string;
    rating: SchedulerRating;
    fsrsStateJson: string;
    dueAt: number;
    lastReviewedAt: number;
  },
): ReviewRow {
  return handle.sqlite.transaction(() => {
    const review = getReview(handle, input.reviewId);
    if (!review) throw P80Error.notFound('Review');
    if (review.schedulerRating !== null) {
      throw P80Error.conflict(
        ERROR_CODES.REVIEW_ALREADY_RATED,
        'This card has already been rated.',
        { reviewId: input.reviewId, rating: review.schedulerRating },
      );
    }
    if (review.answeredAt === null) {
      throw P80Error.conflict(
        ERROR_CODES.REVIEW_NOT_ATTEMPTED,
        'Record the attempt before the rating — a rep happens before the reveal.',
        { reviewId: input.reviewId },
      );
    }

    handle.sqlite
      .prepare('UPDATE reviews SET scheduler_rating = ?, user_rating = ? WHERE id = ?')
      .run(input.rating, input.rating, input.reviewId);

    if (review.cardId !== null) {
      handle.sqlite
        .prepare(
          'UPDATE cards SET fsrs_state_json = ?, due_at = ?, last_reviewed_at = ? WHERE id = ?',
        )
        .run(input.fsrsStateJson, input.dueAt, input.lastReviewedAt, review.cardId);
    }

    if (review.itemId !== null) {
      handle.sqlite
        .prepare(
          `UPDATE learner_item_states
              SET last_seen_at = ?,
                  lapse_count = lapse_count + ?,
                  updated_at = ?
            WHERE item_id = ?`,
        )
        .run(
          input.lastReviewedAt,
          input.rating === 'again' ? 1 : 0,
          input.lastReviewedAt,
          review.itemId,
        );
    }

    return getReview(handle, input.reviewId) as ReviewRow;
  })();
}

export function completeSession(
  handle: DatabaseHandle,
  profileId: string,
  sessionId: string,
): SessionRow {
  const session = getSession(handle, profileId, sessionId);
  if (!session) throw P80Error.notFound('Review session');
  if (session.completedAt !== null) return session;

  const reviews = listSessionReviews(handle, sessionId);
  const rated = reviews.filter((r) => r.schedulerRating !== null);
  const summary = {
    shown: reviews.length,
    rated: rated.length,
    again: rated.filter((r) => r.schedulerRating === 'again').length,
    hard: rated.filter((r) => r.schedulerRating === 'hard').length,
    good: rated.filter((r) => r.schedulerRating === 'good').length,
    easy: rated.filter((r) => r.schedulerRating === 'easy').length,
    // Cards shown and never answered. Abandoning a session is data, not an error.
    abandoned: reviews.filter((r) => r.answeredAt === null).length,
  };

  handle.sqlite
    .prepare('UPDATE review_sessions SET completed_at = ?, summary_json = ? WHERE id = ?')
    .run(now(), JSON.stringify(summary), sessionId);
  return getSession(handle, profileId, sessionId) as SessionRow;
}

export function listItemReviews(handle: DatabaseHandle, itemId: string): ReviewRow[] {
  return (
    handle.sqlite
      .prepare('SELECT * FROM reviews WHERE item_id = ? ORDER BY created_at DESC, rowid DESC')
      .all(itemId) as RawReview[]
  ).map(toReview);
}

/** Active, unsuspended cards with a due date — the input to §8's burden. */
export function listScheduledCards(
  handle: DatabaseHandle,
  profileId: string,
): Array<{ cardType: CardType; dueAt: number }> {
  return (
    handle.sqlite
      .prepare(
        `SELECT c.card_type, c.due_at
           FROM cards c
           JOIN learning_items i ON i.id = c.item_id
          WHERE c.profile_id = ?
            AND c.status = 'active'
            AND c.suspended_at IS NULL
            AND i.status = 'active'
            AND c.due_at IS NOT NULL`,
      )
      .all(profileId) as Array<{ card_type: string; due_at: number }>
  ).map((r) => ({ cardType: r.card_type as CardType, dueAt: r.due_at }));
}
