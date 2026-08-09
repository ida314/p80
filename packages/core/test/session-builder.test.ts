import { describe, expect, it } from 'vitest';
import {
  NEW_ITEM_HARD_MAXIMUM,
  SEEDED_CARD_SECONDS,
  buildSessionPlan,
  medianSeconds,
  reviewBurdenMinutes,
  type SessionCandidate,
} from '../src/session.js';
import type { CardType, LearningItemType } from '../src/domain.js';

/**
 * Stage 3 exit criteria 4 and 10, and `05-cards-and-review.md` §36.4's definition-of-done
 * item: siblings never appear consecutively.
 *
 * That property is the one the relaxation ladder must never trade away, so it is asserted
 * against the degenerate input as well as the comfortable one — a session of nothing but
 * one item's three cards is exactly where a greedy builder gives up.
 */

const T0 = Date.UTC(2026, 7, 9, 9, 0, 0);
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
function card(overrides: Partial<SessionCandidate> = {}): SessionCandidate {
  seq += 1;
  return {
    cardId: `card-${seq}`,
    itemId: `item-${seq}`,
    itemType: 'word' as LearningItemType,
    cardType: 'contextual_cloze' as CardType,
    videoId: 'video-1',
    sentenceId: `sentence-${seq}`,
    dueAt: T0 - 1000,
    lapses: 0,
    isNew: false,
    ...overrides,
  };
}

/** The three cards of one item — siblings. */
function siblings(itemId: string, extra: Partial<SessionCandidate> = {}): SessionCandidate[] {
  return (['audio_recognition', 'contextual_cloze', 'productive_recall'] as CardType[]).map(
    (cardType) =>
      card({ itemId, cardId: `${itemId}-${cardType}`, cardType, sentenceId: `s-${itemId}`, ...extra }),
  );
}

function build(
  candidates: SessionCandidate[],
  overrides: {
    desiredMinutes?: number;
    includeNewItems?: boolean;
    newItemLimit?: number;
    newItemsIntroducedToday?: number;
    reviewBurdenMinutes?: number;
    secondsByCardType?: Partial<Record<CardType, number>>;
  } = {},
) {
  const { desiredMinutes, includeNewItems, ...rest } = overrides;
  return buildSessionPlan({
    request: {
      desiredMinutes: desiredMinutes ?? 30,
      includeNewItems: includeNewItems ?? true,
      includeVideoLoop: false,
      includeTransfer: false,
      includeErrorRepair: false,
    },
    now: T0,
    candidates,
    newItemsIntroducedToday: 0,
    newItemLimit: 10,
    ...rest,
  });
}

function consecutivePairs<T>(list: T[]): Array<[T, T]> {
  return list.slice(1).map((entry, i) => [list[i] as T, entry]);
}

describe('sibling burying', () => {
  it('never places two cards of the same item consecutively', () => {
    const plan = build([...siblings('a'), ...siblings('b'), ...siblings('c')]);
    expect(plan.cards.length).toBe(9);
    for (const [left, right] of consecutivePairs(plan.cards)) {
      expect(left.itemId).not.toBe(right.itemId);
    }
  });

  it('shows one card and defers the rest when the session is one item', () => {
    // The degenerate case, and the answer is not "relax the rule". Three siblings and no
    // filler means there is nothing to put between them, so §6 rule 2 takes over — "prefer
    // different days for introducing new siblings" — and two are held back.
    //
    // The count is reported because the visible effect is otherwise indistinguishable from
    // a bug: create one item, start a session, get one card.
    const plan = build(siblings('lonely'));
    expect(plan.cards.length).toBe(1);
    expect(plan.deferredSiblings).toBe(2);
  });

  it('does not count a card dropped for budget as a deferred sibling', () => {
    const plan = build(
      [...siblings('a'), ...Array.from({ length: 20 }, () => card())],
      { desiredMinutes: 1 },
    );
    const placedItems = new Set(plan.cards.map((c) => c.itemId));
    expect(plan.deferredSiblings).toBeLessThanOrEqual(
      [...placedItems].length * 2,
    );
  });

  it('prefers the five-card separation when there is room for it', () => {
    const plan = build([
      ...siblings('a'),
      ...Array.from({ length: 12 }, () => card({ itemType: 'word' })),
    ]);
    const positions = plan.cards
      .map((c, i) => (c.itemId === 'a' ? i : -1))
      .filter((i) => i >= 0);
    for (const [left, right] of consecutivePairs(positions)) {
      expect(right - left).toBeGreaterThan(5);
    }
  });

  it('gives up the cosmetic constraints before the structural ones', () => {
    // Four items, two cards each, all from one video and one sentence: something has to
    // give. The ladder decides what, in a fixed order, and records it.
    const crowded = ['a', 'b', 'c', 'd'].flatMap((id) =>
      (['audio_recognition', 'contextual_cloze'] as CardType[]).map((cardType) =>
        card({ itemId: id, cardId: `${id}-${cardType}`, cardType, videoId: 'v', sentenceId: 'one' }),
      ),
    );
    const plan = build(crowded);

    for (const [left, right] of consecutivePairs(plan.cards)) {
      expect(left.itemId).not.toBe(right.itemId);
    }
    // Whatever it relaxed, it relaxed in ladder order.
    const order = ['type_variety', 'video_run', 'sentence_repetition', 'sibling_gap'];
    const ranks = plan.relaxations.map((r) => order.indexOf(r));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it('does not report a relaxation for a constraint that never had a chance', () => {
    // Every item is a word, so "prefer a mix of types" is unsatisfiable. Reporting it as
    // relaxed on every session would be noise in an explanation.
    const plan = build(Array.from({ length: 8 }, (_, i) => card({ itemId: `w-${i}`, videoId: `v-${i}` })));
    expect(plan.relaxations).not.toContain('type_variety');
  });
});

describe('selection order', () => {
  it('puts overdue lapse cards before ordinary due cards, and new cards last', () => {
    const plan = build([
      card({ itemId: 'new-1', isNew: true, dueAt: null }),
      card({ itemId: 'due-1', dueAt: T0 - 1000 }),
      card({ itemId: 'lapse-1', dueAt: T0 - 5 * DAY, lapses: 2 }),
    ]);
    expect(plan.cards.map((c) => c.tier)).toEqual(['overdue_lapse', 'due', 'new']);
  });

  it('takes the longest overdue first within a tier', () => {
    const plan = build([
      card({ itemId: 'recent', dueAt: T0 - 1000 }),
      card({ itemId: 'ancient', dueAt: T0 - 30 * DAY }),
    ]);
    expect(plan.cards[0]!.itemId).toBe('ancient');
  });

  it('names the tiers it cannot fill rather than omitting them', () => {
    const plan = build([card()]);
    expect(plan.unimplementedTiers).toEqual(['struggle_repair', 'transfer', 'fluency']);
  });
});

describe('the new-item allowance', () => {
  it('counts items, not cards', () => {
    // §7: "One item introducing three cards counts once." Two items, six cards, a limit
    // of two — all six must fit.
    const plan = build([...siblings('a', { isNew: true, dueAt: null }), ...siblings('b', { isNew: true, dueAt: null })], {
      newItemLimit: 2,
    });
    expect(plan.newItemCount).toBe(2);
    expect(plan.cards.length).toBe(6);
  });

  it('stops at the limit', () => {
    const items = ['a', 'b', 'c', 'd'].flatMap((id) =>
      siblings(id, { isNew: true, dueAt: null }),
    );
    const plan = build(items, { newItemLimit: 2 });
    expect(plan.newItemCount).toBe(2);
    expect(new Set(plan.cards.map((c) => c.itemId)).size).toBe(2);
  });

  it('subtracts what was already introduced today', () => {
    const plan = build(
      ['a', 'b', 'c'].flatMap((id) => siblings(id, { isNew: true, dueAt: null })),
      { newItemLimit: 10, newItemsIntroducedToday: 8 },
    );
    expect(plan.newItemAllowance).toBe(2);
    expect(plan.newItemCount).toBe(2);
  });

  it('never exceeds the hard maximum even when the profile asks for more', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      card({ itemId: `n-${i}`, isNew: true, dueAt: null, cardType: 'contextual_cloze' }),
    );
    const plan = build(many, { newItemLimit: 100, desiredMinutes: 180 });
    expect(plan.newItemAllowance).toBe(NEW_ITEM_HARD_MAXIMUM);
    expect(plan.newItemCount).toBeLessThanOrEqual(NEW_ITEM_HARD_MAXIMUM);
  });

  it('introduces nothing new when the request says not to', () => {
    const plan = build(siblings('a', { isNew: true, dueAt: null }), {
      includeNewItems: false,
    });
    expect(plan.cards).toEqual([]);
  });

  it('suppresses new items when §8 burden exceeds the session budget', () => {
    const plan = build(
      [card({ itemId: 'due-1' }), ...siblings('new-1', { isNew: true, dueAt: null })],
      { reviewBurdenMinutes: 90 },
    );
    expect(plan.newItemsSuppressedByBurden).toBe(true);
    expect(plan.cards.every((c) => c.tier !== 'new')).toBe(true);
  });
});

describe('the other §9 constraints', () => {
  it('does not exceed the time budget by more than ten percent', () => {
    const many = Array.from({ length: 200 }, () => card());
    const plan = build(many, { desiredMinutes: 5 });
    expect(plan.estimatedSeconds).toBeLessThanOrEqual(5 * 60 * 1.1);
    expect(plan.estimatedSeconds).toBeGreaterThan(0);
  });

  it('breaks a run of four cards from the same video', () => {
    const fromOne = Array.from({ length: 6 }, (_, i) =>
      card({ itemId: `one-${i}`, videoId: 'video-1' }),
    );
    const fromTwo = Array.from({ length: 6 }, (_, i) =>
      card({ itemId: `two-${i}`, videoId: 'video-2' }),
    );
    const plan = build([...fromOne, ...fromTwo]);

    let run = 1;
    const videos = plan.cards.map(
      (c) => [...fromOne, ...fromTwo].find((x) => x.cardId === c.cardId)!.videoId,
    );
    for (const [left, right] of consecutivePairs(videos)) {
      run = left === right ? run + 1 : 1;
      expect(run).toBeLessThanOrEqual(3);
    }
  });

  it('does not drill one sentence more than twice', () => {
    const sameSentence = Array.from({ length: 6 }, (_, i) =>
      card({ itemId: `s-${i}`, sentenceId: 'one-line', videoId: `v-${i}` }),
    );
    const filler = Array.from({ length: 6 }, (_, i) => card({ itemId: `f-${i}`, videoId: `w-${i}` }));
    const plan = build([...sameSentence, ...filler]);

    const drilled = plan.cards.filter((c) => c.cardId.startsWith('card-') && sameSentence.some((s) => s.cardId === c.cardId));
    expect(drilled.length).toBeLessThanOrEqual(2);
  });

  it('uses the learner’s own latency when there is enough of it', () => {
    const plan = build([card({ cardType: 'contextual_cloze' })], {
      secondsByCardType: { contextual_cloze: 40 },
    });
    expect(plan.cards[0]!.estimatedSeconds).toBe(40);
    expect(SEEDED_CARD_SECONDS.contextual_cloze).not.toBe(40);
  });
});

describe('reviewBurdenMinutes', () => {
  it('separates overdue from the seven-day window rather than double counting', () => {
    const burden = reviewBurdenMinutes({
      now: T0,
      cards: [
        { cardType: 'contextual_cloze', dueAt: T0 - DAY },
        { cardType: 'contextual_cloze', dueAt: T0 + 2 * DAY },
        // Beyond the horizon — not counted at all.
        { cardType: 'contextual_cloze', dueAt: T0 + 30 * DAY },
      ],
    });
    expect(burden.overdueMinutes).toBeCloseTo(15 / 60);
    expect(burden.upcomingMinutes).toBeCloseTo(15 / 60);
    expect(burden.totalMinutes).toBeCloseTo(30 / 60);
  });
});

describe('medianSeconds', () => {
  it('waits for enough samples before preferring the learner over the seed', () => {
    expect(medianSeconds([1000, 2000, 3000, 4000])).toBeNull();
    expect(medianSeconds([1000, 2000, 3000, 4000, 5000])).toBe(3);
  });

  it('is unmoved by one card left open while the learner answered the door', () => {
    expect(medianSeconds([9000, 10_000, 11_000, 12_000, 900_000])).toBe(11);
  });

  it('ignores impossible latencies rather than averaging them in', () => {
    expect(medianSeconds([0, -5, 10_000, 10_000, 10_000, 10_000, 10_000])).toBe(10);
  });
});
