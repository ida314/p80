import { z } from 'zod';
import {
  CARD_TYPES,
  DEFAULT_POST_ROLL_MS,
  DEFAULT_PRE_ROLL_MS,
  MIN_INTERVENING_CARDS,
  P80Error,
  SEEDED_CARD_SECONDS,
  applyRating,
  buildMediaDescriptor,
  buildSessionPlan,
  clipWindow,
  dueSummaryResponse,
  medianSeconds,
  newSchedule,
  now,
  parseSnapshot,
  renderCloze,
  reviewAnswerRequest,
  reviewCardResponse,
  reviewForecastResponse,
  reviewRateRequest,
  reviewRateResponse,
  reviewRevealResponse,
  reviewBurdenMinutes,
  sessionRequestSchema,
  sessionResponse,
  type CardType,
  type ReviewCardPayload,
} from '@p80/core';
import {
  completeSession,
  countNewItemsSince,
  createSession,
  ensureProfile,
  getCard,
  getItem,
  getLatestTranscriptFile,
  getPrimaryOccurrence,
  getReview,
  getSession,
  getVideo,
  listScheduledCards,
  listSessionCandidates,
  listSessionReviews,
  listTranslations,
  openReview,
  recentLatenciesByCardType,
  recordAttempt,
  recordHint,
  recordRating,
  requireOpenSession,
  type DatabaseHandle,
} from '@p80/database';
import type { App } from '../app.js';

/**
 * Review sessions — `03-api.md` §6.
 *
 * The plan is computed once, server-side, and stored. `GET /next` walks it and may deviate
 * when a card is failed and requeued, which §9 explicitly allows; both the plan and the
 * actual sequence are recoverable from `reviews`.
 *
 * **`answer` and `rate` are separate on purpose.** A rep happens before the answer is
 * revealed (§9.9). `answer` records the attempt and its latency and returns the back face;
 * `rate` records the learner's judgement and advances FSRS. Collapsing them would make a
 * restudy indistinguishable from a retrieval and would measure latency from the wrong
 * moment (§23.1).
 */

/**
 * Whether a clip for this video is word-bounded or cue-bounded (ADR 0017).
 *
 * Reported rather than absorbed: a replay that covers a whole line when it was asked for
 * one word is a worse answer, not a rounder one (`05-cards-and-review.md` §3.1).
 */
function timingPrecisionOf(handle: DatabaseHandle, videoId: string): 'word' | 'cue' {
  const file = getLatestTranscriptFile(handle, videoId);
  return file?.timingGranularity === 'word' ? 'word' : 'cue';
}

/** Local midnight, for §7's per-day allowance. */
function startOfDay(at: number): number {
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function secondsByCardType(
  handle: DatabaseHandle,
  profileId: string,
): Partial<Record<CardType, number>> {
  const latencies = recentLatenciesByCardType(handle, profileId);
  const out: Partial<Record<CardType, number>> = {};
  for (const cardType of CARD_TYPES) {
    const median = medianSeconds(latencies[cardType] ?? []);
    if (median !== null) out[cardType] = median;
  }
  return out;
}

/**
 * Which card comes next.
 *
 * The plan is the order; this walks it, skipping cards already rated in this session and
 * honouring §6 rule 4 for a card that was failed. A failed card is not re-planned — it is
 * offered again once five other cards have gone by, which is what "same-session relearning
 * requires at least five intervening cards" means in a walk rather than in a plan.
 */
function chooseNextCardId(
  handle: DatabaseHandle,
  sessionId: string,
  planCardIds: string[],
): { cardId: string; position: number; total: number } | null {
  const reviews = listSessionReviews(handle, sessionId);
  const rated = reviews.filter((r) => r.schedulerRating !== null);
  const ratedCardIds = new Set(rated.map((r) => r.cardId));

  // An opened-but-unanswered review means the client asked for a card and never came back
  // — a refresh, or a closed tab. Hand back the same card rather than opening a second row
  // for it, so one shown card is one review.
  const open = reviews.find((r) => r.schedulerRating === null && r.cardId !== null);
  if (open?.cardId) {
    return {
      cardId: open.cardId,
      position: rated.length,
      total: planCardIds.length,
    };
  }

  const failed = rated
    .filter((r) => r.schedulerRating === 'again' && r.cardId !== null)
    .map((r) => r.cardId as string);
  const lastFailedIndex = new Map<string, number>();
  rated.forEach((r, i) => {
    if (r.schedulerRating === 'again' && r.cardId) lastFailedIndex.set(r.cardId, i);
  });

  const unrated = planCardIds.filter((id) => !ratedCardIds.has(id));
  if (unrated.length > 0) {
    return { cardId: unrated[0] as string, position: rated.length, total: planCardIds.length };
  }

  // Everything planned has been rated. A card failed earlier comes back once enough other
  // cards have intervened; otherwise the session is done.
  for (const cardId of failed) {
    const since = rated.length - (lastFailedIndex.get(cardId) ?? 0) - 1;
    if (since >= MIN_INTERVENING_CARDS) {
      return { cardId, position: rated.length, total: planCardIds.length };
    }
  }
  return null;
}

const PROMPTS: Readonly<Record<CardType, string>> = {
  // §3.1's exact wording.
  audio_recognition: 'What does the speaker mean?',
  contextual_cloze: 'Fill the gap.',
  productive_recall: 'Produce the target expression for this meaning.',
};

export async function registerReviewRoutes(
  app: App,
  deps: { handle: DatabaseHandle },
): Promise<void> {
  const { handle } = deps;

  app.post(
    '/api/review/session',
    { schema: { body: sessionRequestSchema, response: { 201: sessionResponse } } },
    async (request, reply) => {
      const profile = ensureProfile(handle);
      const at = now();

      const burden = reviewBurdenMinutes({
        now: at,
        cards: listScheduledCards(handle, profile.id),
        secondsByCardType: secondsByCardType(handle, profile.id),
      });

      const plan = buildSessionPlan({
        request: request.body,
        now: at,
        candidates: listSessionCandidates(handle, profile.id),
        newItemsIntroducedToday: countNewItemsSince(handle, profile.id, startOfDay(at)),
        newItemLimit: profile.newItemLimit,
        secondsByCardType: secondsByCardType(handle, profile.id),
        reviewBurdenMinutes: burden.totalMinutes,
      });

      const session = createSession(handle, profile.id, request.body, plan);
      reply.code(201);
      return {
        id: session.id,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        request: session.request,
        plan,
      };
    },
  );

  app.get(
    '/api/review/session/:id',
    { schema: { params: z.object({ id: z.string() }), response: { 200: sessionResponse } } },
    async (request) => {
      const profile = ensureProfile(handle);
      const session = getSession(handle, profile.id, request.params.id);
      if (!session || !session.plan) throw P80Error.notFound('Review session');
      return {
        id: session.id,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        request: session.request,
        plan: session.plan,
      };
    },
  );

  /**
   * The next card, front face only.
   *
   * The answer is deliberately absent from this payload. A client that already held the
   * back face could reveal it without a round trip, and then a reveal would no longer be
   * an event the server can distinguish from a retrieval (§1 rule 2).
   */
  app.get(
    '/api/review/session/:id/next',
    {
      schema: {
        params: z.object({ id: z.string() }),
        querystring: z.object({
          preRollMs: z.coerce.number().int().min(0).max(10_000).optional(),
          postRollMs: z.coerce.number().int().min(0).max(10_000).optional(),
        }),
        response: {
          200: z.union([reviewCardResponse, z.object({ done: z.literal(true) })]),
        },
      },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const session = requireOpenSession(handle, profile.id, request.params.id);
      const plan = session.plan;
      if (!plan) throw P80Error.notFound('Review session');

      const next = chooseNextCardId(
        handle,
        session.id,
        plan.cards.map((c) => c.cardId),
      );
      if (!next) return { done: true as const };

      const card = getCard(handle, next.cardId);
      if (!card) throw P80Error.notFound('Card');
      const item = getItem(handle, card.itemId);
      if (!item) throw P80Error.notFound('Item');
      const occurrence = getPrimaryOccurrence(handle, item.id);

      const existing = listSessionReviews(handle, session.id).find(
        (r) => r.cardId === card.id && r.schedulerRating === null,
      );
      const review =
        existing ??
        openReview(handle, {
          sessionId: session.id,
          cardId: card.id,
          itemId: item.id,
          videoId: occurrence?.videoId ?? null,
          cardType: card.cardType,
          // Stage 3 has one occurrence per item, so every rep is a source rep. Transfer
          // needs a second occurrence from a second video (Stage 11).
          contextMode: 'source',
          occurrenceId: occurrence?.id ?? null,
        });

      let clip: ReviewCardPayload['clip'] = null;
      if (occurrence) {
        const video = getVideo(handle, occurrence.videoId);
        const window = clipWindow({
          startMs: occurrence.startMs,
          endMs: occurrence.endMs,
          preRollMs: request.query.preRollMs ?? DEFAULT_PRE_ROLL_MS,
          postRollMs: request.query.postRollMs ?? DEFAULT_POST_ROLL_MS,
          durationMs: video?.durationMs ?? null,
        });
        clip = {
          videoId: occurrence.videoId,
          mediaUrl: buildMediaDescriptor(occurrence.videoId, {
            missing: video?.mediaMissing ?? true,
          }).mediaUrl,
          mediaMissing: video?.mediaMissing ?? true,
          startMs: window.startMs,
          endMs: window.endMs,
          itemStartMs: window.itemStartMs,
          itemEndMs: window.itemEndMs,
          // ADR 0017. A cue-bounded clip covers the whole line; saying so is the
          // alternative to silently returning a coarser answer.
          timingPrecision: timingPrecisionOf(handle, occurrence.videoId),
        };
      }

      const spanStart = occurrence
        ? occurrence.sentenceText.indexOf(occurrence.surfaceForm)
        : -1;

      return {
        reviewId: review.id,
        cardId: card.id,
        itemId: item.id,
        cardType: card.cardType,
        contextMode: review.contextMode,
        position: next.position,
        total: next.total,
        clip,
        prompt:
          card.cardType === 'productive_recall'
            ? `${PROMPTS.productive_recall}\n${item.meaning}`
            : PROMPTS[card.cardType],
        clozeText:
          card.cardType === 'contextual_cloze' && occurrence && spanStart >= 0
            ? renderCloze({
                sentenceText: occurrence.sentenceText,
                spanStart,
                spanEnd: spanStart + occurrence.surfaceForm.length,
              })
            : null,
        // §3.1: a typed meaning is optional on audio recognition, a mental answer is
        // permitted. The other two are answered in writing.
        acceptsText: true,
        // §3.2: source playback is offered after the first attempt on a cloze, never
        // before — offering it first turns a retrieval into a listening exercise.
        clipAvailableBeforeAnswer: card.cardType !== 'contextual_cloze',
      };
    },
  );

  /** The attempt, and the back face it earns. */
  app.post(
    '/api/review/session/:id/answer',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: reviewAnswerRequest,
        response: { 200: reviewRevealResponse },
      },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const session = requireOpenSession(handle, profile.id, request.params.id);

      const review = getReview(handle, request.body.reviewId);
      if (!review || review.sessionId !== session.id) throw P80Error.notFound('Review');

      recordAttempt(handle, review.id, {
        responseText: request.body.responseText ?? null,
        responseLatencyMs: request.body.responseLatencyMs ?? null,
        sourceContextUsed: request.body.sourceContextUsed,
      });

      const item = review.itemId ? getItem(handle, review.itemId) : null;
      if (!item) throw P80Error.notFound('Item');
      const occurrence = getPrimaryOccurrence(handle, item.id);
      const translations = listTranslations(handle, item.id);
      const natural = translations.find((t) => t.kind === 'natural')?.text ?? null;

      const spanStart = occurrence
        ? Math.max(0, occurrence.sentenceText.indexOf(occurrence.surfaceForm))
        : 0;

      const expected = occurrence?.surfaceForm ?? item.canonicalForm;
      const given = (request.body.responseText ?? '').trim();

      return {
        reviewId: review.id,
        canonicalForm: item.canonicalForm,
        meaning: item.meaning,
        translation: natural,
        // Hard rule 11. A user-authored gloss has no dictionary evidence, so nothing in
        // Stage 3 is verified — and the flag exists so Stage 6 can flip it rather than the
        // client learning a rule.
        meaningVerified: false,
        sentenceText: occurrence?.sentenceText ?? '',
        spanStart,
        spanEnd: spanStart + (occurrence?.surfaceForm.length ?? 0),
        precedingText: occurrence?.precedingText ?? null,
        followingText: occurrence?.followingText ?? null,
        // §3.3. The source sentence is one acceptable answer, never the only one, and this
        // is part of the card rather than advice the client adds.
        isOneOfSeveralAnswers: review.cardType === 'productive_recall',
        // §4 step 1: a structured check where the answer is checkable. Cloze only — an
        // exact form is checkable, a produced sentence is not, and §18.6 forbids relying
        // on automatic semantic grading. Whatever this says, the learner rates.
        automaticCheck:
          review.cardType === 'contextual_cloze'
            ? { correct: given.toLowerCase() === expected.toLowerCase(), expected }
            : null,
      };
    },
  );

  app.post(
    '/api/review/session/:id/hint',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reviewId: z.string() }),
        response: { 200: z.object({ reviewId: z.string(), hintCount: z.number().int() }) },
      },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const session = requireOpenSession(handle, profile.id, request.params.id);
      const review = getReview(handle, request.body.reviewId);
      if (!review || review.sessionId !== session.id) throw P80Error.notFound('Review');
      const updated = recordHint(handle, review.id);
      return { reviewId: updated.id, hintCount: updated.hintCount };
    },
  );

  /** The scheduler rating. Stage 3 exit criterion 3. */
  app.post(
    '/api/review/session/:id/rate',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: reviewRateRequest,
        response: { 200: reviewRateResponse },
      },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const session = requireOpenSession(handle, profile.id, request.params.id);
      const review = getReview(handle, request.body.reviewId);
      if (!review || review.sessionId !== session.id) throw P80Error.notFound('Review');
      if (!review.cardId) throw P80Error.notFound('Card');

      const card = getCard(handle, review.cardId);
      if (!card) throw P80Error.notFound('Card');

      const at = now();
      // A card whose stored snapshot cannot be parsed reschedules from a fresh one rather
      // than failing the rep. Losing an interval is recoverable; losing the rating is not.
      const snapshot = parseSnapshot(card.fsrsStateJson) ?? newSchedule(at);
      const outcome = applyRating(snapshot, request.body.rating, at);

      recordRating(handle, {
        reviewId: review.id,
        rating: request.body.rating,
        fsrsStateJson: JSON.stringify(outcome.snapshot),
        dueAt: outcome.dueAt,
        lastReviewedAt: outcome.lastReviewedAt,
      });

      return {
        cardId: card.id,
        rating: request.body.rating,
        dueAt: outcome.dueAt,
        intervalDays: (outcome.dueAt - at) / (24 * 60 * 60 * 1000),
        phase: outcome.snapshot.phase,
        lapsed: outcome.lapsed,
        // §6 rule 4: a failed card returns after five intervening cards, within this
        // session. Anything else waits for its due date.
        requeued: request.body.rating === 'again',
      };
    },
  );

  app.post(
    '/api/review/session/:id/complete',
    { schema: { params: z.object({ id: z.string() }), response: { 200: sessionResponse } } },
    async (request) => {
      const profile = ensureProfile(handle);
      const session = completeSession(handle, profile.id, request.params.id);
      if (!session.plan) throw P80Error.notFound('Review session');
      return {
        id: session.id,
        startedAt: session.startedAt,
        completedAt: session.completedAt,
        request: session.request,
        plan: session.plan,
      };
    },
  );

  /** The due-card dashboard, spec §35 step 15. */
  app.get(
    '/api/review/due',
    { schema: { response: { 200: dueSummaryResponse } } },
    async () => {
      const profile = ensureProfile(handle);
      const at = now();
      const candidates = listSessionCandidates(handle, profile.id);
      const seconds = { ...SEEDED_CARD_SECONDS, ...secondsByCardType(handle, profile.id) };

      const due = candidates.filter((c) => !c.isNew && c.dueAt !== null && c.dueAt <= at);
      const dueByCardType = {} as Record<CardType, number>;
      for (const cardType of CARD_TYPES) {
        dueByCardType[cardType] = due.filter((c) => c.cardType === cardType).length;
      }

      const introducedToday = countNewItemsSince(handle, profile.id, startOfDay(at));
      const newItems = new Set(candidates.filter((c) => c.isNew).map((c) => c.itemId));

      return {
        dueNow: due.length,
        // "Overdue" here means due before today began, not merely due — a card that came
        // due an hour ago is due, and calling it overdue would make every session start
        // with a backlog.
        overdue: due.filter((c) => (c.dueAt as number) < startOfDay(at)).length,
        dueByCardType,
        newItemsAvailable: newItems.size,
        newItemAllowance: Math.max(0, profile.newItemLimit - introducedToday),
        newItemsIntroducedToday: introducedToday,
        estimatedMinutes:
          due.reduce((total, c) => total + (seconds[c.cardType] ?? 0), 0) / 60,
      };
    },
  );

  /** §8's burden, over the next seven days. */
  app.get(
    '/api/review/forecast',
    { schema: { response: { 200: reviewForecastResponse } } },
    async () => {
      const profile = ensureProfile(handle);
      const at = now();
      const seconds = { ...SEEDED_CARD_SECONDS, ...secondsByCardType(handle, profile.id) };
      const cards = listScheduledCards(handle, profile.id);
      const burden = reviewBurdenMinutes({ now: at, cards, secondsByCardType: seconds });

      const DAY = 24 * 60 * 60 * 1000;
      const startToday = startOfDay(at);
      const days = Array.from({ length: 7 }, (_, i) => {
        const from = startToday + i * DAY;
        const to = from + DAY;
        // Everything overdue lands on day 0, which is where the learner will meet it.
        const onDay = cards.filter((c) =>
          i === 0 ? c.dueAt < to : c.dueAt >= from && c.dueAt < to,
        );
        return {
          date: new Date(from).toISOString().slice(0, 10),
          cards: onDay.length,
          minutes: onDay.reduce((total, c) => total + (seconds[c.cardType] ?? 0), 0) / 60,
        };
      });

      return {
        totalMinutes: burden.totalMinutes,
        overdueMinutes: burden.overdueMinutes,
        upcomingMinutes: burden.upcomingMinutes,
        days,
      };
    },
  );
}
