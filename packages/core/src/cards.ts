/**
 * Which cards an item gets, and what goes on their two faces.
 *
 * `05-cards-and-review.md` §2 and §3. Two rules there are explicitly judgement calls —
 * "when a useful source sentence exists" for a word's cloze, and "only when the source
 * realization is clear and reusable" for a construction's audio card. Stage 3 is the
 * manual prototype, so the judgement is the user's: each is a heuristic default the
 * creation form can override. The heuristic is here rather than in the client because
 * clients hold no domain logic (ADR 0007), and it is a *default* rather than a gate
 * because §2's wording is about usefulness, which no token count actually measures.
 */

import { CARD_TYPES, type CardType, type LearningItemType } from './domain.js';

/**
 * Below this many words outside the target span, a cloze is a guessing game rather than a
 * retrieval: `____ ihn.` constrains nothing. Four is chosen to be visibly arbitrary and
 * easy to change — it is a default for a checkbox, not a tuned parameter, and the labelled
 * corpus that could tune it (ADR 0006) does not carry cloze solvability labels.
 */
export const MIN_CLOZE_CONTEXT_WORDS = 4;

export interface CardPlanInput {
  itemType: LearningItemType;
  /** The reconstructed source sentence the occurrence sits in. */
  sentenceText: string;
  /** The span of the item within `sentenceText`, as character offsets. */
  spanStart: number;
  spanEnd: number;
  /** User overrides from the creation form. Undefined means "use the heuristic". */
  includeCloze?: boolean | undefined;
  includeAudio?: boolean | undefined;
}

export function contextWordCount(input: {
  sentenceText: string;
  spanStart: number;
  spanEnd: number;
}): number {
  const before = input.sentenceText.slice(0, Math.max(0, input.spanStart));
  const after = input.sentenceText.slice(Math.min(input.sentenceText.length, input.spanEnd));
  return `${before} ${after}`.split(/\s+/u).filter((w) => w.length > 0).length;
}

/**
 * §2's table, with the two optional cells resolved.
 *
 * Productive recall is unconditional for all three types, and audio recognition is
 * unconditional for the two lexical types — a word and an expression are both things a
 * speaker says, so there is always something to hear.
 */
export function planCards(input: CardPlanInput): CardType[] {
  const contextWords = contextWordCount(input);
  const clozeIsUseful = contextWords >= MIN_CLOZE_CONTEXT_WORDS;

  const audio =
    input.includeAudio ??
    // A construction's realization in one sentence is often incidental to the pattern,
    // so §2 makes its audio card optional. Default off; the form turns it on.
    (input.itemType === 'construction' ? false : true);

  // §2 makes the cloze conditional for a word and unconditional for the other two. The
  // heuristic is applied to all three anyway: a cloze with no context left is unanswerable
  // whatever the item type, and offering one is a worse answer than offering none. The
  // difference §2 draws survives as a default the form can flip, not as a gate.
  const cloze = input.includeCloze ?? clozeIsUseful;

  const planned: CardType[] = [];
  if (audio) planned.push('audio_recognition');
  if (cloze) planned.push('contextual_cloze');
  planned.push('productive_recall');
  // Return in the canonical enum order so a card list is stable across calls.
  return CARD_TYPES.filter((t) => planned.includes(t));
}

/** The character used for a cloze gap. Four em-dashes would be prettier and would also be
 *  selectable-and-copyable as text that looks like content; underscores read as a blank in
 *  every font P80 might be rendered in. */
export const CLOZE_BLANK = '____';

/**
 * §3.2's front face: the source sentence with the target span replaced by a blank.
 *
 * Built from offsets rather than by string replacement, because replacing the surface form
 * textually would also blank an unrelated second occurrence of the same word in the same
 * sentence — which turns one retrieval into two and measures neither (§1, rule 1).
 */
export function renderCloze(input: {
  sentenceText: string;
  spanStart: number;
  spanEnd: number;
}): string {
  const start = Math.max(0, Math.min(input.spanStart, input.sentenceText.length));
  const end = Math.max(start, Math.min(input.spanEnd, input.sentenceText.length));
  return (
    input.sentenceText.slice(0, start) + CLOZE_BLANK + input.sentenceText.slice(end)
  );
}

/** Playback window defaults for §3.1. Adjustable per §11 — the review request may carry
 *  its own values — so these are the starting point, not a policy. */
export const DEFAULT_PRE_ROLL_MS = 1500;
export const DEFAULT_POST_ROLL_MS = 800;

export interface ClipWindow {
  startMs: number;
  endMs: number;
  /** What the caller asked to hear, before roll was added. The player highlights this. */
  itemStartMs: number;
  itemEndMs: number;
}

export function clipWindow(input: {
  startMs: number;
  endMs: number;
  preRollMs?: number | undefined;
  postRollMs?: number | undefined;
  durationMs?: number | null | undefined;
}): ClipWindow {
  const pre = input.preRollMs ?? DEFAULT_PRE_ROLL_MS;
  const post = input.postRollMs ?? DEFAULT_POST_ROLL_MS;
  const end = input.endMs + post;
  return {
    startMs: Math.max(0, input.startMs - pre),
    endMs:
      typeof input.durationMs === 'number' && input.durationMs > 0
        ? Math.min(end, input.durationMs)
        : end,
    itemStartMs: input.startMs,
    itemEndMs: input.endMs,
  };
}
