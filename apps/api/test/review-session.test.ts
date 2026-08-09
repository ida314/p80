import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';
import { seedReadyTranscript, segment } from './transcript-fixture.js';

/**
 * A whole review session over the HTTP surface — Stage 3 exit criteria 3, 5, and 6, and
 * ADR 0007's requirement that a `curl` script can complete one.
 *
 * These are deliberately end-to-end rather than unit tests of the handlers. The scheduling
 * logic is already pinned in `packages/core`; what is unproven until here is that the
 * *sequence* works — that a card can be fetched, attempted, revealed, rated, and that the
 * rating reaches `cards.due_at` through two processes' worth of serialization.
 */

const SEGMENTS = [
  segment(0, 0, 3_000, 'Ich habe ihn gestern zufaellig getroffen.'),
  segment(1, 3_000, 6_500, 'Das war eine grosse Ueberraschung fuer mich.'),
  segment(2, 6_500, 9_000, 'Wir haben lange miteinander gesprochen.'),
];

let api: TestApi;
let videoId: string;
let segmentIds: string[];

beforeEach(async () => {
  api = await createTestApi();
  videoId = await seedReadyTranscript(api, SEGMENTS);
  const transcript = await api.server.app.inject({
    method: 'GET',
    url: `/api/videos/${videoId}/transcript`,
  });
  segmentIds = transcript.json().segments.map((s: { id: string }) => s.id);
});

afterEach(async () => {
  await api.dispose();
});

async function makeItem(
  segmentIndex: number,
  needle: string,
  canonicalForm: string,
  meaning: string,
) {
  const text = SEGMENTS[segmentIndex]!.rawText;
  const spanStart = text.indexOf(needle);
  const response = await api.server.app.inject({
    method: 'POST',
    url: '/api/items',
    payload: {
      videoId,
      selection: {
        segmentIds: [segmentIds[segmentIndex]],
        spanStart,
        spanEnd: spanStart + needle.length,
      },
      canonicalForm,
      itemType: 'word',
      meaning,
    },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

async function startSession(body: Record<string, unknown> = {}) {
  const response = await api.server.app.inject({
    method: 'POST',
    url: '/api/review/session',
    payload: { desiredMinutes: 30, includeNewItems: true, ...body },
  });
  expect(response.statusCode).toBe(201);
  return response.json();
}

const next = (sessionId: string) =>
  api.server.app
    .inject({ method: 'GET', url: `/api/review/session/${sessionId}/next` })
    .then((r) => r.json());

const answer = (sessionId: string, payload: Record<string, unknown>) =>
  api.server.app
    .inject({ method: 'POST', url: `/api/review/session/${sessionId}/answer`, payload })
    .then((r) => r);

const rate = (sessionId: string, payload: Record<string, unknown>) =>
  api.server.app
    .inject({ method: 'POST', url: `/api/review/session/${sessionId}/rate`, payload })
    .then((r) => r);

describe('a full session', () => {
  it('runs card → attempt → reveal → rating and moves the due date', async () => {
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();
    expect(session.plan.cards.length).toBeGreaterThan(0);

    const card = await next(session.id);
    expect(card.reviewId).toBeTruthy();
    expect(card.prompt).toBeTruthy();

    const revealed = await answer(session.id, {
      reviewId: card.reviewId,
      responseText: 'by chance',
      responseLatencyMs: 4_200,
    });
    expect(revealed.statusCode).toBe(200);
    expect(revealed.json().meaning).toBe('by chance');

    const rated = await rate(session.id, { reviewId: card.reviewId, rating: 'good' });
    expect(rated.statusCode).toBe(200);
    expect(rated.json().dueAt).toBeGreaterThan(Date.now());
    expect(rated.json().intervalDays).toBeGreaterThan(0);
  });

  it('gives four different due dates for the four ratings', async () => {
    // Exit criterion 3, from the outside. Four items so each rating lands on its own card
    // and nothing is rescheduled twice.
    const intervals: number[] = [];
    for (const [i, rating] of (['again', 'hard', 'good', 'easy'] as const).entries()) {
      const fresh = await createTestApi();
      const freshVideo = await seedReadyTranscript(fresh, SEGMENTS);
      const transcript = await fresh.server.app.inject({
        method: 'GET',
        url: `/api/videos/${freshVideo}/transcript`,
      });
      const sid = transcript.json().segments[0].id as string;
      await fresh.server.app.inject({
        method: 'POST',
        url: '/api/items',
        payload: {
          videoId: freshVideo,
          selection: { segmentIds: [sid], spanStart: 0, spanEnd: 3 },
          canonicalForm: `item-${i}`,
          itemType: 'word',
          meaning: `meaning ${i}`,
        },
      });
      const s = await fresh.server.app
        .inject({ method: 'POST', url: '/api/review/session', payload: { desiredMinutes: 30 } })
        .then((r) => r.json());
      const c = await fresh.server.app
        .inject({ method: 'GET', url: `/api/review/session/${s.id}/next` })
        .then((r) => r.json());
      await fresh.server.app.inject({
        method: 'POST',
        url: `/api/review/session/${s.id}/answer`,
        payload: { reviewId: c.reviewId },
      });
      const rated = await fresh.server.app
        .inject({
          method: 'POST',
          url: `/api/review/session/${s.id}/rate`,
          payload: { reviewId: c.reviewId, rating },
        })
        .then((r) => r.json());
      intervals.push(rated.dueAt);
      await fresh.dispose();
    }

    for (let i = 1; i < intervals.length; i += 1) {
      expect(intervals[i]!).toBeGreaterThan(intervals[i - 1]!);
    }
  });

  it('persists the new schedule to the card row, not only to the response', async () => {
    // The stage brief's named risk: the FSRS state round trip crosses a JSON boundary and
    // two processes read `cards`. A response that looks right while the row does not is
    // exactly the family of bug this project has hit five times.
    const item = await makeItem(0, 'gestern', 'gestern', 'yesterday');
    const session = await startSession();
    const card = await next(session.id);
    await answer(session.id, { reviewId: card.reviewId });
    const rated = await rate(session.id, { reviewId: card.reviewId, rating: 'good' });

    const row = api.server.handle.sqlite
      .prepare('SELECT due_at, fsrs_state_json, last_reviewed_at FROM cards WHERE id = ?')
      .get(card.cardId) as {
      due_at: number;
      fsrs_state_json: string;
      last_reviewed_at: number;
    };
    expect(row.due_at).toBe(rated.json().dueAt);
    expect(row.last_reviewed_at).toBeGreaterThan(0);
    // The denormalised column and the snapshot are two views of one fact and are written
    // together; a path that could write one without the other is the bug.
    expect(JSON.parse(row.fsrs_state_json).due).toBe(row.due_at);

    const reread = await api.server.app
      .inject({ method: 'GET', url: `/api/items/${item.id}` })
      .then((r) => r.json());
    expect(reread.skills.audio_recognition.dueAt).toBe(row.due_at);
    expect(reread.skills.audio_recognition.lastRating).toBe('good');
  });
});

describe('the reveal is earned', () => {
  it('does not put the answer in the front-face payload', async () => {
    // §1 rule 2: a rep happens before the answer is revealed. A client holding the back
    // face could reveal without a round trip, and then the server cannot tell a retrieval
    // from a restudy.
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();
    const card = await next(session.id);
    expect(JSON.stringify(card)).not.toContain('by chance');
  });

  it('refuses a rating before an attempt was recorded', async () => {
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();
    const card = await next(session.id);

    const rated = await rate(session.id, { reviewId: card.reviewId, rating: 'good' });
    expect(rated.statusCode).toBe(409);
    expect(rated.json().error.code).toBe('REVIEW_NOT_ATTEMPTED');
  });

  it('refuses a second rating for the same rep', async () => {
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();
    const card = await next(session.id);
    await answer(session.id, { reviewId: card.reviewId });
    await rate(session.id, { reviewId: card.reviewId, rating: 'good' });

    const again = await rate(session.id, { reviewId: card.reviewId, rating: 'easy' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('REVIEW_ALREADY_RATED');
  });

  it('holds cloze playback back until the first attempt', async () => {
    // §3.2: offering the clip first turns a retrieval into a listening exercise.
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();
    for (let i = 0; i < 3; i += 1) {
      const card = await next(session.id);
      if (card.done) break;
      if (card.cardType === 'contextual_cloze') {
        expect(card.clipAvailableBeforeAnswer).toBe(false);
        expect(card.clozeText).toContain('____');
        expect(card.clozeText).not.toContain('zufaellig');
        return;
      }
      await answer(session.id, { reviewId: card.reviewId });
      await rate(session.id, { reviewId: card.reviewId, rating: 'good' });
    }
  });
});

describe('the source clip', () => {
  it('carries a playable window with pre-roll and the item span inside it', async () => {
    // Exit criterion 5's server half. That it plays is manual check M2.
    await makeItem(1, 'Ueberraschung', 'Überraschung', 'surprise');
    const session = await startSession();
    const card = await next(session.id);

    expect(card.clip).not.toBeNull();
    expect(card.clip.mediaUrl).toBe(`/api/videos/${videoId}/media`);
    expect(card.clip.startMs).toBeLessThan(card.clip.itemStartMs);
    expect(card.clip.endMs).toBeGreaterThan(card.clip.itemEndMs);
    // ADR 0017: the fixture is an uploaded transcript, so timing is cue-bounded and says so.
    expect(card.clip.timingPrecision).toBe('cue');
  });

  it('honours an adjusted pre-roll, which §11 requires', async () => {
    await makeItem(1, 'Ueberraschung', 'Überraschung', 'surprise');
    const session = await startSession();
    const card = await api.server.app
      .inject({
        method: 'GET',
        url: `/api/review/session/${session.id}/next?preRollMs=0&postRollMs=0`,
      })
      .then((r) => r.json());
    expect(card.clip.startMs).toBe(card.clip.itemStartMs);
    expect(card.clip.endMs).toBe(card.clip.itemEndMs);
  });
});

describe('session lifecycle', () => {
  it('reports done once everything planned has been rated', async () => {
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();

    for (let i = 0; i < 10; i += 1) {
      const card = await next(session.id);
      if (card.done) break;
      await answer(session.id, { reviewId: card.reviewId });
      await rate(session.id, { reviewId: card.reviewId, rating: 'good' });
    }
    expect((await next(session.id)).done).toBe(true);
  });

  it('hands back the same card when the client asks twice without answering', async () => {
    // A refresh must not open a second review row; one shown card is one rep.
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();
    const first = await next(session.id);
    const second = await next(session.id);
    expect(second.reviewId).toBe(first.reviewId);
  });

  it('refuses to serve a completed session', async () => {
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();
    await api.server.app.inject({
      method: 'POST',
      url: `/api/review/session/${session.id}/complete`,
    });

    const response = await api.server.app.inject({
      method: 'GET',
      url: `/api/review/session/${session.id}/next`,
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SESSION_COMPLETE');
  });

  it('summarises what happened, including cards shown and abandoned', async () => {
    // Two items, because one item's siblings cannot be adjacent — a single-item session
    // plans exactly one card, and there would be no second card to walk away from.
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    await makeItem(1, 'Ueberraschung', 'Überraschung', 'surprise');
    const session = await startSession();
    const card = await next(session.id);
    await answer(session.id, { reviewId: card.reviewId });
    await rate(session.id, { reviewId: card.reviewId, rating: 'hard' });
    await next(session.id);

    await api.server.app.inject({
      method: 'POST',
      url: `/api/review/session/${session.id}/complete`,
    });
    const summary = JSON.parse(
      (
        api.server.handle.sqlite
          .prepare('SELECT summary_json FROM review_sessions WHERE id = ?')
          .get(session.id) as { summary_json: string }
      ).summary_json,
    );
    expect(summary.rated).toBe(1);
    expect(summary.hard).toBe(1);
    // Abandoning a session mid-card is data about the session, not a write that failed.
    expect(summary.abandoned).toBeGreaterThanOrEqual(1);
  });
});

describe('the dashboard', () => {
  it('counts new items available and the day’s remaining allowance', async () => {
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    await makeItem(1, 'Ueberraschung', 'Überraschung', 'surprise');

    const due = await api.server.app
      .inject({ method: 'GET', url: '/api/review/due' })
      .then((r) => r.json());
    expect(due.newItemsAvailable).toBe(2);
    expect(due.newItemsIntroducedToday).toBe(0);
    expect(due.newItemAllowance).toBe(10);
  });

  it('counts an item once however many cards it produced', async () => {
    // §7: "One item introducing three cards counts once."
    const item = await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    expect(
      Object.values(item.skills).filter((s) => (s as { cardId: string | null }).cardId).length,
    ).toBe(3);

    const session = await startSession();
    for (let i = 0; i < 5; i += 1) {
      const card = await next(session.id);
      if (card.done) break;
      await answer(session.id, { reviewId: card.reviewId });
      await rate(session.id, { reviewId: card.reviewId, rating: 'good' });
    }

    const due = await api.server.app
      .inject({ method: 'GET', url: '/api/review/due' })
      .then((r) => r.json());
    expect(due.newItemsIntroducedToday).toBe(1);
    expect(due.newItemAllowance).toBe(9);
  });

  it('forecasts seven days of burden', async () => {
    await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const forecast = await api.server.app
      .inject({ method: 'GET', url: '/api/review/forecast' })
      .then((r) => r.json());
    expect(forecast.days).toHaveLength(7);
    expect(forecast.overdueMinutes).toBeGreaterThan(0);
  });
});

describe('GET /api/items/:id/history', () => {
  it('is inspectable after a rep, with the attempt and the rating separable', async () => {
    // Exit criterion 6. The attempt and the rating are two facts because §9.9 needs to
    // tell a rep from a restudy, so the history must not collapse them.
    const item = await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    const session = await startSession();
    const card = await next(session.id);
    await answer(session.id, {
      reviewId: card.reviewId,
      responseText: 'coincidentally',
      responseLatencyMs: 3_100,
      sourceContextUsed: true,
    });
    await rate(session.id, { reviewId: card.reviewId, rating: 'hard' });

    const history = await api.server.app
      .inject({ method: 'GET', url: `/api/items/${item.id}/history` })
      .then((r) => r.json());

    expect(history.reviews).toHaveLength(1);
    const review = history.reviews[0];
    expect(review.responseText).toBe('coincidentally');
    expect(review.responseLatencyMs).toBe(3_100);
    expect(review.schedulerRating).toBe('hard');
    expect(review.sourceContextUsed).toBe(true);
    expect(review.shownAt).toBeLessThanOrEqual(review.answeredAt);
    // §4 step 2 is optional and no LLM runs in Stage 3.
    expect(review.machineClassification).toBeNull();
    expect(history.definitions).toHaveLength(1);
  });

  it('keeps the superseded definition when the meaning is edited', async () => {
    const item = await makeItem(0, 'gestern', 'gestern', 'yesterday');
    await api.server.app.inject({
      method: 'PUT',
      url: `/api/items/${item.id}`,
      payload: { meaning: 'on the previous day' },
    });

    const history = await api.server.app
      .inject({ method: 'GET', url: `/api/items/${item.id}/history` })
      .then((r) => r.json());
    expect(history.definitions).toHaveLength(2);
    expect(history.definitions.map((d: { definition: string }) => d.definition)).toContain(
      'yesterday',
    );
  });
});

describe('suspension', () => {
  it('takes an item out of the next session and puts it back', async () => {
    const item = await makeItem(0, 'zufaellig', 'zufällig', 'by chance');
    await api.server.app.inject({ method: 'POST', url: `/api/items/${item.id}/suspend` });

    const suspended = await startSession();
    expect(suspended.plan.cards).toHaveLength(0);

    await api.server.app.inject({ method: 'POST', url: `/api/items/${item.id}/unsuspend` });
    const restored = await startSession();
    expect(restored.plan.cards.length).toBeGreaterThan(0);
  });
});
