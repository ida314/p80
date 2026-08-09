/**
 * Session generation — `05-cards-and-review.md` §6 to §9.
 *
 * The plan is computed here, server-side, and stored in `review_sessions.plan_json`.
 * Clients receive an ordered list of card ids and hold none of this logic (ADR 0007): a
 * `curl` script must be able to complete a full session, which it cannot do if the order
 * is decided in a browser.
 *
 * ## What Stage 3 implements
 *
 * §9's selection order has six tiers. This builds **1, 2, and 5** — overdue lapse cards,
 * due cards, and new cards. Struggling-item repair needs the learner model (Stage 9),
 * transfer needs a second occurrence from a second video (Stage 11), and the fluency task
 * needs recording. The tiers are named in `SELECTION_TIERS` so the gap is visible in the
 * plan rather than implied by its absence.
 *
 * ## Why greedy with explicit relaxation
 *
 * The constraints in §9 conflict. "Prefer high-priority" pulls one way, "no more than
 * three consecutive cards from the same video" pulls another, and a session of six cards
 * from two items cannot satisfy every separation rule at once. A solver would find the
 * optimum and be unable to say why a card was placed where it was.
 *
 * So: highest-priority eligible card wins, and when nothing is eligible the constraints
 * are relaxed in a **fixed, recorded order** — each relaxation lands in the plan. One is
 * never relaxed. Siblings are never consecutive; §36.4 makes that a definition-of-done
 * item, and a plan that quietly gave up on it would pass every test that checks for a
 * card id and fail the one property the user can see.
 */

import type { CardType, LearningItemType } from './domain.js';

export const SELECTION_TIERS = [
  'overdue_lapse',
  'due',
  // Stage 9. Named so its absence from a plan is legible.
  'struggle_repair',
  // Stage 11.
  'transfer',
  'new',
  // Stage 12.
  'fluency',
] as const;
export type SelectionTier = (typeof SELECTION_TIERS)[number];

/** The tiers this stage can actually fill. */
export const IMPLEMENTED_TIERS: readonly SelectionTier[] = ['overdue_lapse', 'due', 'new'];

/** §9. `desiredMinutes` is the learner's ask; §10's default session is 35–45 minutes. */
export interface SessionRequest {
  desiredMinutes: number;
  includeNewItems: boolean;
  includeVideoLoop: boolean;
  includeTransfer: boolean;
  includeErrorRepair: boolean;
}

export interface SessionCandidate {
  cardId: string;
  itemId: string;
  itemType: LearningItemType;
  cardType: CardType;
  /** Null when the item's occurrences were all deleted with their video. */
  videoId: string | null;
  sentenceId: string | null;
  /** Null for a card that has never been scheduled. */
  dueAt: number | null;
  lapses: number;
  isNew: boolean;
}

export interface PlannedCard {
  cardId: string;
  itemId: string;
  cardType: CardType;
  tier: SelectionTier;
  estimatedSeconds: number;
}

/**
 * The constraints the ladder may trade away, cheapest first.
 *
 * Two of §9's constraints are **not** on this list and are never relaxed: siblings are
 * never consecutive (§36.4 makes it a definition-of-done item) and one sentence is never
 * tested more than twice. Both are quality floors — a session that breaks either is worse
 * than a shorter session — so cards that cannot be placed without breaking them are left
 * out and counted rather than squeezed in at the end.
 */
export const RELAXATIONS = ['type_variety', 'video_run', 'sibling_gap'] as const;
export type Relaxation = (typeof RELAXATIONS)[number];

export interface SessionPlan {
  cards: PlannedCard[];
  estimatedSeconds: number;
  budgetSeconds: number;
  /** Distinct items appearing for the first time. §7 counts items, never cards. */
  newItemCount: number;
  newItemAllowance: number;
  /** Which constraints had to give, in the order they gave. Empty is the common case. */
  relaxations: Relaxation[];
  /**
   * Cards that were available and left out because their sibling was already placed and
   * the session had nothing to put between them.
   *
   * This is §6 rule 2 — "prefer different days for introducing new siblings" — doing its
   * job, not the builder failing. It is counted because the visible effect is surprising:
   * a learner who has created exactly one item starts a session and is shown one card. A
   * plan that reported only "1 card" would look like a bug. Reporting "1 card, 2 siblings
   * held for another day" is the same fact, explained.
   */
  deferredSiblings: number;
  /** Everything the tiers offered and the plan did not take, for any reason. The plan is
   *  a selection; this is the size of what it selected from. */
  unplacedCards: number;
  /** Tiers §9 lists that this stage cannot fill. Carried so a plan is self-describing. */
  unimplementedTiers: SelectionTier[];
  /** True when §8's burden rule suppressed new items regardless of the request. */
  newItemsSuppressedByBurden: boolean;
}

/** §7. */
export const NEW_ITEM_HARD_MAXIMUM = 20;

/** §6 rule 4. A card that was failed and requeued comes back no sooner than this many
 *  intervening cards. Also the target separation for siblings, which §6 rule 1 states as
 *  a floor ("never consecutive") rather than a number — five is the one number §6 gives,
 *  so siblings aim for it and settle for the floor. */
export const MIN_INTERVENING_CARDS = 5;

/** §6 rule 1, the floor. At least this many cards between two siblings. Never relaxed. */
const ABSOLUTE_SIBLING_GAP = 1;

/** §9. Three consecutive from one video is the limit, so a fourth is refused. */
const MAX_CONSECUTIVE_SAME_VIDEO = 3;

/**
 * §9, "do not repeatedly test one exact sentence."
 *
 * Counted in **distinct items**, not cards. An item's three cards necessarily share its
 * primary occurrence's sentence, and they are three different retrievals of one thing —
 * §6's sibling rules already govern how far apart they sit. What §9 is guarding against is
 * the other case: several items extracted from one line, so the session keeps returning to
 * the same sentence with a different word blanked out. Counting cards would make it
 * impossible for any item to receive its full set in one session, which would quietly
 * defeat §10's two-reps-per-new-item protocol.
 */
const MAX_ITEMS_PER_SENTENCE = 2;

/** §8, "per-card time estimates come from the learner's own rolling median latency by card
 *  type, falling back to seeded defaults before enough data exists." These are the seeds.
 *  Production is the slowest because the learner is composing, not recognising. */
export const SEEDED_CARD_SECONDS: Readonly<Record<CardType, number>> = {
  audio_recognition: 25,
  contextual_cloze: 15,
  productive_recall: 35,
};

/** §9, "do not exceed the estimated time budget by more than 10%." */
const BUDGET_OVERRUN_ALLOWANCE = 1.1;

export interface SessionBuildInput {
  request: SessionRequest;
  now: number;
  candidates: SessionCandidate[];
  /** Distinct items already introduced today, from `reviews`. */
  newItemsIntroducedToday: number;
  /** `profiles.new_item_limit`. */
  newItemLimit: number;
  /** Rolling medians where they exist, seeds where they do not. */
  secondsByCardType?: Partial<Record<CardType, number>> | undefined;
  /** §8's `review_burden` in minutes. When it exceeds the session budget, new items stop. */
  reviewBurdenMinutes?: number | undefined;
}

interface Placement {
  candidate: SessionCandidate;
  tier: SelectionTier;
}

function tierOf(candidate: SessionCandidate, now: number): SelectionTier | null {
  if (candidate.isNew) return 'new';
  if (candidate.dueAt === null || candidate.dueAt > now) return null;
  // §9 tier 1 is "overdue lapse cards" — a card that is both past due and has lapsed
  // before. A lapse-prone card recovered late is the most expensive thing to lose.
  return candidate.lapses > 0 ? 'overdue_lapse' : 'due';
}

const TIER_ORDER: Readonly<Record<SelectionTier, number>> = {
  overdue_lapse: 0,
  due: 1,
  struggle_repair: 2,
  transfer: 3,
  new: 4,
  fluency: 5,
};

export function buildSessionPlan(input: SessionBuildInput): SessionPlan {
  const seconds = { ...SEEDED_CARD_SECONDS, ...(input.secondsByCardType ?? {}) };
  const budgetSeconds = Math.max(0, Math.round(input.request.desiredMinutes * 60));

  // §8 rule 1: burden over budget stops new items, whatever the request said. The other
  // three §8 rules need the learner model and are not applied here.
  const burdenSeconds = (input.reviewBurdenMinutes ?? 0) * 60;
  const newItemsSuppressedByBurden =
    input.request.includeNewItems && burdenSeconds > budgetSeconds && budgetSeconds > 0;
  const allowNew = input.request.includeNewItems && !newItemsSuppressedByBurden;

  const remainingAllowance = Math.max(
    0,
    Math.min(input.newItemLimit, NEW_ITEM_HARD_MAXIMUM) - input.newItemsIntroducedToday,
  );

  const pool: Placement[] = [];
  for (const candidate of input.candidates) {
    const tier = tierOf(candidate, input.now);
    if (tier === null) continue;
    if (tier === 'new' && !allowNew) continue;
    pool.push({ candidate, tier });
  }
  pool.sort((a, b) => {
    const byTier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
    if (byTier !== 0) return byTier;
    // Within a tier, the longest overdue first. New cards have no due date and keep the
    // order the caller gave, which is item creation order.
    const aDue = a.candidate.dueAt ?? Number.POSITIVE_INFINITY;
    const bDue = b.candidate.dueAt ?? Number.POSITIVE_INFINITY;
    return aDue - bDue;
  });

  const placed: PlannedCard[] = [];
  const relaxations: Relaxation[] = [];
  const remaining = new Set(pool.map((p) => p.candidate.cardId));
  const byId = new Map(pool.map((p) => [p.candidate.cardId, p]));

  const newItems = new Set<string>();
  /** Sentence id -> the distinct items already drawn from it this session. */
  const sentenceItems = new Map<string, Set<string>>();
  const seenTypes: LearningItemType[] = [];
  const poolHasMixedTypes = new Set(pool.map((p) => p.candidate.itemType)).size > 1;
  let usedSeconds = 0;

  /** How many cards back the most recent card of this item sits. Infinity when absent. */
  const distanceToLastOfItem = (itemId: string): number => {
    for (let i = placed.length - 1; i >= 0; i -= 1) {
      const entry = placed[i];
      if (entry && entry.itemId === itemId) return placed.length - i;
    }
    return Number.POSITIVE_INFINITY;
  };

  const consecutiveSameVideo = (videoId: string | null): number => {
    if (videoId === null) return 0;
    let run = 0;
    for (let i = placed.length - 1; i >= 0; i -= 1) {
      const entry = placed[i];
      if (!entry) break;
      const source = byId.get(entry.cardId);
      if (!source || source.candidate.videoId !== videoId) break;
      run += 1;
    }
    return run;
  };

  const eligible = (
    placement: Placement,
    siblingGap: number,
    checkVideoRun: boolean,
    preferVariety: boolean,
  ): boolean => {
    const c = placement.candidate;

    // Never relaxed below its floor. §9's "never repeat the same item consecutively" and
    // §6's sibling rules are the same check: two cards of one item, too close together.
    if (distanceToLastOfItem(c.itemId) <= siblingGap) return false;

    // Never relaxed at all. §9, "do not repeatedly test one exact sentence." A third card
    // on one line is the session drilling it, and a shorter session is the better answer.
    if (c.sentenceId !== null) {
      const drawn = sentenceItems.get(c.sentenceId);
      if (drawn && !drawn.has(c.itemId) && drawn.size >= MAX_ITEMS_PER_SENTENCE) return false;
    }

    if (checkVideoRun && consecutiveSameVideo(c.videoId) >= MAX_CONSECUTIVE_SAME_VIDEO) {
      return false;
    }
    if (preferVariety && poolHasMixedTypes && seenTypes.length >= 2) {
      // §9, "prefer a mix of words, expressions, and constructions." Only applied when the
      // pool actually holds more than one type — otherwise it is unsatisfiable, would be
      // relaxed on the first card of every session, and would fill `relaxations` with a
      // constraint that never had a chance. A list of relaxations nobody could avoid is
      // noise, and noise in an explanation is the same as no explanation.
      const lastTwo = seenTypes.slice(-2);
      if (lastTwo.every((t) => t === c.itemType)) return false;
    }
    if (placement.tier === 'new') {
      if (!newItems.has(c.itemId) && newItems.size >= remainingAllowance) return false;
    }
    return true;
  };

  // Relaxation ladder. Each rung loosens exactly one more thing, ordered by what the
  // constraint is worth: monotony of item type is cosmetic, a fourth card from one video
  // is dull, testing one exact sentence a third time is genuine redundancy, and siblings
  // adjacent is the actual harm. The sibling *floor* is not on the ladder at all.
  const ladder: Array<{
    relaxation: Relaxation | null;
    siblingGap: number;
    checkVideoRun: boolean;
    preferVariety: boolean;
  }> = [
    { relaxation: null, siblingGap: MIN_INTERVENING_CARDS, checkVideoRun: true, preferVariety: true },
    { relaxation: 'type_variety', siblingGap: MIN_INTERVENING_CARDS, checkVideoRun: true, preferVariety: false },
    { relaxation: 'video_run', siblingGap: MIN_INTERVENING_CARDS, checkVideoRun: false, preferVariety: false },
    { relaxation: 'sibling_gap', siblingGap: ABSOLUTE_SIBLING_GAP, checkVideoRun: false, preferVariety: false },
  ];

  for (;;) {
    let chosen: Placement | null = null;
    let usedRelaxation: Relaxation | null = null;

    for (const rung of ladder) {
      const eligibleHere = pool.filter(
        (placement) =>
          remaining.has(placement.candidate.cardId) &&
          usedSeconds + seconds[placement.candidate.cardType] <=
            budgetSeconds * BUDGET_OVERRUN_ALLOWANCE &&
          eligible(placement, rung.siblingGap, rung.checkVideoRun, rung.preferVariety),
      );
      if (eligibleHere.length === 0) continue;

      // Tier priority is absolute — a due card never waits behind a new one. Within the
      // best tier available, the tiebreak spreads the session out.
      //
      // The third key is the one that matters most and is the least obvious: prefer the
      // item with the most cards still to place. Without it, greedy takes the pool in
      // order and paints itself into a corner — nine cards across three items can be
      // interleaved perfectly, but a first-fit pass runs the last item's remaining cards
      // up against each other and has to drop one. It is the same heuristic that solves
      // "rearrange a string so equal characters are k apart", and the failure mode without
      // it is identical: a solvable arrangement reported as impossible.
      const bestTier = Math.min(...eligibleHere.map((p) => TIER_ORDER[p.tier]));
      const contenders = eligibleHere.filter((p) => TIER_ORDER[p.tier] === bestTier);
      const lastPlaced = placed[placed.length - 1];
      const lastVideo = lastPlaced ? byId.get(lastPlaced.cardId)?.candidate.videoId : undefined;
      const lastType = seenTypes[seenTypes.length - 1];

      const remainingForItem = new Map<string, number>();
      for (const cardId of remaining) {
        const itemId = byId.get(cardId)?.candidate.itemId;
        if (itemId) remainingForItem.set(itemId, (remainingForItem.get(itemId) ?? 0) + 1);
      }

      chosen = contenders.reduce<Placement | null>((best, p) => {
        if (best === null) return p;
        const key = (x: Placement): [number, number, number] => [
          x.candidate.videoId !== lastVideo ? 0 : 1,
          -(remainingForItem.get(x.candidate.itemId) ?? 0),
          x.candidate.itemType !== lastType ? 0 : 1,
        ];
        const [a0, a1, a2] = key(p);
        const [b0, b1, b2] = key(best);
        if (a0 !== b0) return a0 < b0 ? p : best;
        if (a1 !== b1) return a1 < b1 ? p : best;
        if (a2 !== b2) return a2 < b2 ? p : best;
        // Fall through to pool order, which is already sorted by tier then due date.
        return best;
      }, null);
      usedRelaxation = rung.relaxation;
      if (chosen) break;
    }

    if (!chosen) break;
    if (usedRelaxation && !relaxations.includes(usedRelaxation)) {
      relaxations.push(usedRelaxation);
    }

    const c = chosen.candidate;
    const cost = seconds[c.cardType];
    placed.push({
      cardId: c.cardId,
      itemId: c.itemId,
      cardType: c.cardType,
      tier: chosen.tier,
      estimatedSeconds: cost,
    });
    remaining.delete(c.cardId);
    usedSeconds += cost;
    seenTypes.push(c.itemType);
    if (chosen.tier === 'new') newItems.add(c.itemId);
    if (c.sentenceId !== null) {
      const drawn = sentenceItems.get(c.sentenceId) ?? new Set<string>();
      drawn.add(c.itemId);
      sentenceItems.set(c.sentenceId, drawn);
    }
  }

  // Everything left over that shares an item with something placed. A card left out for
  // any other reason — budget, allowance — is not a deferred sibling.
  const placedItems = new Set(placed.map((p) => p.itemId));
  const deferredSiblings = [...remaining].filter((cardId) => {
    const placement = byId.get(cardId);
    return placement !== undefined && placedItems.has(placement.candidate.itemId);
  }).length;

  return {
    cards: placed,
    estimatedSeconds: usedSeconds,
    budgetSeconds,
    newItemCount: newItems.size,
    newItemAllowance: remainingAllowance,
    relaxations,
    deferredSiblings,
    unplacedCards: remaining.size,
    unimplementedTiers: SELECTION_TIERS.filter((t) => !IMPLEMENTED_TIERS.includes(t)),
    newItemsSuppressedByBurden,
  };
}

/**
 * §8: `review_burden = estimated_due_minutes_next_7_days + overdue_minutes`.
 *
 * Overdue is counted separately and not double-counted in the seven-day window, because a
 * card that came due four days ago is not also due again in the next seven.
 */
export function reviewBurdenMinutes(input: {
  now: number;
  /** One entry per active, unsuspended card with a due date. */
  cards: Array<{ cardType: CardType; dueAt: number }>;
  secondsByCardType?: Partial<Record<CardType, number>> | undefined;
}): { totalMinutes: number; overdueMinutes: number; upcomingMinutes: number } {
  const seconds = { ...SEEDED_CARD_SECONDS, ...(input.secondsByCardType ?? {}) };
  const horizon = input.now + 7 * 24 * 60 * 60 * 1000;
  let overdue = 0;
  let upcoming = 0;
  for (const card of input.cards) {
    const cost = seconds[card.cardType];
    if (card.dueAt <= input.now) overdue += cost;
    else if (card.dueAt <= horizon) upcoming += cost;
  }
  return {
    totalMinutes: (overdue + upcoming) / 60,
    overdueMinutes: overdue / 60,
    upcomingMinutes: upcoming / 60,
  };
}

/** The rolling median §8 asks for. Median rather than mean because one card left open
 *  while the learner answered the door would otherwise move the estimate for every card
 *  of that type. */
export function medianSeconds(latenciesMs: number[]): number | null {
  const usable = latenciesMs.filter((ms) => Number.isFinite(ms) && ms > 0).sort((a, b) => a - b);
  // Below this many samples the median is noise and the seed is the better estimate.
  if (usable.length < 5) return null;
  const mid = Math.floor(usable.length / 2);
  const ms =
    usable.length % 2 === 1
      ? (usable[mid] as number)
      : ((usable[mid - 1] as number) + (usable[mid] as number)) / 2;
  return ms / 1000;
}
