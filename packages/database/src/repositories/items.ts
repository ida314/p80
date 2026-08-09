import {
  ERROR_CODES,
  MANUAL_ITEM_SCORES,
  P80Error,
  USER_DEFINITION_PROVIDER,
  newId,
  now,
  type CardType,
  type ItemStatus,
  type LearningItemType,
  type Register,
  type SchedulerRating,
} from '@p80/core';
import type { DatabaseHandle } from '../client.js';

/**
 * Learning items, their occurrences, and their cards.
 *
 * Creating one is a single transaction across seven tables, because a half-created item is
 * worse than none: `01-domain-model.md` §7 invariant 2 says an active item has at least one
 * occurrence and one stored meaning, and a partial insert produces exactly the row that
 * violates it.
 *
 * **The sentence rows are the subtle part** (ADR 0020 §2). `item_occurrences.sentence_id` is
 * `NOT NULL REFERENCES sentences(id) ON DELETE CASCADE`, and `sentences` is Stage 4's
 * output. So creation materialises one sentence per touched transcript segment, keyed by
 * the segment's own `sequence_index`, which makes the write idempotent — a second selection
 * in the same segment finds the row rather than colliding with it.
 *
 * Stage 4 must reconcile with those rows and relink, never delete and rebuild. A
 * `DELETE FROM sentences WHERE video_id = ?` cascades into `item_occurrences` and destroys
 * every hand-made item's anchor. The ADR says so at length; this comment is here because
 * the person about to write that DELETE will be reading this file, not the ADR.
 */

export interface ItemRow {
  id: string;
  profileId: string;
  targetLanguage: string;
  canonicalForm: string;
  normalizedForm: string;
  lemma: string | null;
  itemType: LearningItemType;
  senseKey: string;
  partOfSpeech: string | null;
  meaning: string;
  register: Register;
  dialectRegion: string | null;
  offensiveOrSensitive: boolean;
  generalFrequencyRank: number | null;
  domainFrequencyScore: number;
  contextualDiversityScore: number;
  reusePotentialScore: number;
  extractionConfidence: number;
  definitionConfidence: number;
  status: ItemStatus;
  createdAt: number;
  updatedAt: number;
}

interface RawItem {
  id: string;
  profile_id: string;
  target_language: string;
  canonical_form: string;
  normalized_form: string;
  lemma: string | null;
  item_type: string;
  sense_key: string;
  part_of_speech: string | null;
  meaning: string;
  register: string;
  dialect_region: string | null;
  offensive_or_sensitive: number;
  general_frequency_rank: number | null;
  domain_frequency_score: number;
  contextual_diversity_score: number;
  reuse_potential_score: number;
  extraction_confidence: number;
  definition_confidence: number;
  status: string;
  created_at: number;
  updated_at: number;
}

function toItem(row: RawItem): ItemRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    targetLanguage: row.target_language,
    canonicalForm: row.canonical_form,
    normalizedForm: row.normalized_form,
    lemma: row.lemma,
    itemType: row.item_type as LearningItemType,
    senseKey: row.sense_key,
    partOfSpeech: row.part_of_speech,
    meaning: row.meaning,
    register: row.register as Register,
    dialectRegion: row.dialect_region,
    offensiveOrSensitive: row.offensive_or_sensitive === 1,
    generalFrequencyRank: row.general_frequency_rank,
    domainFrequencyScore: row.domain_frequency_score,
    contextualDiversityScore: row.contextual_diversity_score,
    reusePotentialScore: row.reuse_potential_score,
    extractionConfidence: row.extraction_confidence,
    definitionConfidence: row.definition_confidence,
    status: row.status as ItemStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface OccurrenceRow {
  id: string;
  itemId: string;
  videoId: string;
  sentenceId: string;
  startMs: number;
  endMs: number;
  surfaceForm: string;
  sentenceText: string;
  precedingText: string | null;
  followingText: string | null;
  extractionConfidence: number | null;
  isPrimaryOccurrence: boolean;
}

interface RawOccurrence {
  id: string;
  item_id: string;
  video_id: string;
  sentence_id: string;
  start_ms: number;
  end_ms: number;
  surface_form: string;
  sentence_text: string;
  preceding_text: string | null;
  following_text: string | null;
  extraction_confidence: number | null;
  is_primary_occurrence: number;
}

function toOccurrence(row: RawOccurrence): OccurrenceRow {
  return {
    id: row.id,
    itemId: row.item_id,
    videoId: row.video_id,
    sentenceId: row.sentence_id,
    startMs: row.start_ms,
    endMs: row.end_ms,
    surfaceForm: row.surface_form,
    sentenceText: row.sentence_text,
    precedingText: row.preceding_text,
    followingText: row.following_text,
    extractionConfidence: row.extraction_confidence,
    isPrimaryOccurrence: row.is_primary_occurrence === 1,
  };
}

export interface DefinitionRow {
  id: string;
  itemId: string;
  provider: string;
  definition: string;
  translation: string | null;
  /** Null means no dictionary evidence, which is what makes a definition unverified. */
  evidenceJson: string | null;
  confidence: number | null;
  isUserEdited: boolean;
  createdAt: number;
}

export interface CardRow {
  id: string;
  profileId: string;
  itemId: string;
  cardType: CardType;
  promptLanguage: string;
  answerLanguage: string;
  status: string;
  fsrsStateJson: string | null;
  dueAt: number | null;
  lastReviewedAt: number | null;
  suspendedAt: number | null;
  createdAt: number;
}

interface RawCard {
  id: string;
  profile_id: string;
  item_id: string;
  card_type: string;
  prompt_language: string;
  answer_language: string;
  status: string;
  fsrs_state_json: string | null;
  due_at: number | null;
  last_reviewed_at: number | null;
  suspended_at: number | null;
  created_at: number;
}

function toCard(row: RawCard): CardRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    itemId: row.item_id,
    cardType: row.card_type as CardType,
    promptLanguage: row.prompt_language,
    answerLanguage: row.answer_language,
    status: row.status,
    fsrsStateJson: row.fsrs_state_json,
    dueAt: row.due_at,
    lastReviewedAt: row.last_reviewed_at,
    suspendedAt: row.suspended_at,
    createdAt: row.created_at,
  };
}

/** One touched transcript segment, already projected through its corrections. */
export interface SelectedSegment {
  id: string;
  sequenceIndex: number;
  startMs: number;
  endMs: number;
  /** The effective text — the correction if there is one, else the raw cue. */
  text: string;
  normalizedText: string;
}

export interface CreateItemInput {
  profileId: string;
  videoId: string;
  targetLanguage: string;
  nativeLanguage: string;
  canonicalForm: string;
  normalizedForm: string;
  itemType: LearningItemType;
  senseKey: string;
  meaning: string;
  translation: string | null;
  register: Register;
  lemma: string | null;
  partOfSpeech: string | null;
  dialectRegion: string | null;
  offensiveOrSensitive: boolean;
  /** In reading order. The occurrence anchors to the first (ADR 0020 §2). */
  segments: SelectedSegment[];
  surfaceForm: string;
  /** The full selected context, which may span more than one segment. */
  sentenceText: string;
  precedingText: string | null;
  followingText: string | null;
  startMs: number;
  endMs: number;
  cardTypes: CardType[];
  /** `newSchedule(now)` serialized, applied to every card this item creates. */
  initialFsrsStateJson: string;
  initialDueAt: number;
}

export interface CreateItemResult {
  item: ItemRow;
  occurrence: OccurrenceRow;
  cards: CardRow[];
}

/**
 * Find or create the `sentences` row for one transcript segment (ADR 0020 §2).
 *
 * Keyed by `(video_id, sequence_index)`, which is the table's own unique constraint, so
 * two selections in the same segment reuse one row and the third does not fail.
 */
function ensureSegmentSentence(
  handle: DatabaseHandle,
  videoId: string,
  segment: SelectedSegment,
): string {
  const existing = handle.sqlite
    .prepare('SELECT id FROM sentences WHERE video_id = ? AND sequence_index = ?')
    .get(videoId, segment.sequenceIndex) as { id: string } | undefined;
  if (existing) return existing.id;

  const id = newId();
  handle.sqlite
    .prepare(
      `INSERT INTO sentences
         (id, video_id, start_ms, end_ms, text, normalized_text, token_count, sequence_index)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      videoId,
      segment.startMs,
      segment.endMs,
      segment.text,
      segment.normalizedText,
      // Whitespace count, and deliberately not called tokenization. Stage 4 replaces it
      // with the sidecar's, and a wrong number here is visibly a placeholder where an
      // invented `tokens` row would not be.
      segment.text.split(/\s+/u).filter((w) => w.length > 0).length,
      segment.sequenceIndex,
    );
  handle.sqlite
    .prepare(
      `INSERT OR IGNORE INTO sentence_segments (sentence_id, transcript_segment_id, sequence_index)
       VALUES (?, ?, ?)`,
    )
    .run(id, segment.id, 0);
  return id;
}

export function createManualItem(
  handle: DatabaseHandle,
  input: CreateItemInput,
): CreateItemResult {
  const at = now();
  const first = input.segments[0];
  if (!first) throw P80Error.badRequest('A selection must touch at least one segment.');

  return handle.sqlite.transaction(() => {
    // Every touched segment gets a sentence row, so a selection spanning two cues leaves
    // both reachable through `sentence_segments`. The occurrence anchors to the first.
    const sentenceIds = input.segments.map((segment) =>
      ensureSegmentSentence(handle, input.videoId, segment),
    );
    const sentenceId = sentenceIds[0] as string;

    const itemId = newId();
    try {
      handle.sqlite
        .prepare(
          `INSERT INTO learning_items
             (id, profile_id, target_language, canonical_form, normalized_form, lemma,
              item_type, sense_key, part_of_speech, meaning, register, dialect_region,
              offensive_or_sensitive, domain_frequency_score, contextual_diversity_score,
              reuse_potential_score, extraction_confidence, definition_confidence,
              status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        )
        .run(
          itemId,
          input.profileId,
          input.targetLanguage,
          input.canonicalForm,
          input.normalizedForm,
          input.lemma,
          input.itemType,
          input.senseKey,
          input.partOfSpeech,
          input.meaning,
          input.register,
          input.dialectRegion,
          input.offensiveOrSensitive ? 1 : 0,
          MANUAL_ITEM_SCORES.domainFrequencyScore,
          MANUAL_ITEM_SCORES.contextualDiversityScore,
          MANUAL_ITEM_SCORES.reusePotentialScore,
          MANUAL_ITEM_SCORES.extractionConfidence,
          MANUAL_ITEM_SCORES.definitionConfidence,
          at,
          at,
        );
    } catch (err) {
      // The identity constraint from §3.1. Attempted rather than pre-checked, for the same
      // TOCTOU reason `videos` gives; the lookup afterwards exists only so the message can
      // name the item the user already has (ADR 0020 §1).
      if (String(err).includes('UNIQUE constraint failed')) {
        const existing = handle.sqlite
          .prepare(
            `SELECT id, canonical_form, meaning FROM learning_items
              WHERE profile_id = ? AND target_language = ? AND normalized_form = ?
                AND item_type = ? AND sense_key = ?`,
          )
          .get(
            input.profileId,
            input.targetLanguage,
            input.normalizedForm,
            input.itemType,
            input.senseKey,
          ) as { id: string; canonical_form: string; meaning: string } | undefined;
        throw P80Error.conflict(
          ERROR_CODES.ITEM_SENSE_EXISTS,
          `You already have "${input.canonicalForm}" with this sense. Describe the meaning differently to keep them apart, or edit the item you have.`,
          existing
            ? { itemId: existing.id, canonicalForm: existing.canonical_form, meaning: existing.meaning }
            : { senseKey: input.senseKey },
        );
      }
      throw err;
    }

    // §7 invariant 2: an active item has a stored meaning with provenance. `evidence_json`
    // is null because a user-authored gloss has no dictionary evidence, which is what makes
    // it render as unverified (hard rule 11).
    handle.sqlite
      .prepare(
        `INSERT INTO definitions
           (id, item_id, provider, definition, translation, evidence_json, confidence,
            is_user_edited, created_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 1, ?)`,
      )
      .run(
        newId(),
        itemId,
        USER_DEFINITION_PROVIDER,
        input.meaning,
        input.translation,
        MANUAL_ITEM_SCORES.definitionConfidence,
        at,
      );

    if (input.translation !== null && input.translation !== '') {
      handle.sqlite
        .prepare(
          `INSERT INTO item_translations
             (id, item_id, language, kind, text, source, is_user_edited, created_at)
           VALUES (?, ?, ?, 'natural', ?, ?, 1, ?)`,
        )
        .run(
          newId(),
          itemId,
          input.nativeLanguage,
          input.translation,
          USER_DEFINITION_PROVIDER,
          at,
        );
    }

    // §4: forms are never collapsed into the canonical form. The selected surface is the
    // first observed form even when it happens to equal the canonical one.
    handle.sqlite
      .prepare(
        `INSERT INTO item_forms (id, item_id, surface_form, normalized_form, occurrence_count)
         VALUES (?, ?, ?, ?, 1)`,
      )
      .run(newId(), itemId, input.surfaceForm, input.surfaceForm);

    const occurrenceId = newId();
    handle.sqlite
      .prepare(
        `INSERT INTO item_occurrences
           (id, item_id, video_id, sentence_id, start_ms, end_ms, surface_form,
            sentence_text, preceding_text, following_text, extraction_confidence,
            is_primary_occurrence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(
        occurrenceId,
        itemId,
        input.videoId,
        sentenceId,
        input.startMs,
        input.endMs,
        input.surfaceForm,
        input.sentenceText,
        input.precedingText,
        input.followingText,
        MANUAL_ITEM_SCORES.extractionConfidence,
      );

    handle.sqlite
      .prepare(
        `INSERT INTO learner_item_states (id, profile_id, item_id, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(newId(), input.profileId, itemId, at);

    const cards: CardRow[] = [];
    for (const cardType of input.cardTypes) {
      const cardId = newId();
      handle.sqlite
        .prepare(
          `INSERT INTO cards
             (id, profile_id, item_id, card_type, prompt_language, answer_language,
              status, fsrs_state_json, due_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        )
        .run(
          cardId,
          input.profileId,
          itemId,
          cardType,
          // ADR 0010: the pair is always (target, native) in MVP, and nothing varies it.
          input.targetLanguage,
          input.nativeLanguage,
          input.initialFsrsStateJson,
          input.initialDueAt,
          at,
        );
      cards.push(
        toCard(
          handle.sqlite.prepare('SELECT * FROM cards WHERE id = ?').get(cardId) as RawCard,
        ),
      );
    }

    return {
      item: toItem(
        handle.sqlite.prepare('SELECT * FROM learning_items WHERE id = ?').get(itemId) as RawItem,
      ),
      occurrence: toOccurrence(
        handle.sqlite
          .prepare('SELECT * FROM item_occurrences WHERE id = ?')
          .get(occurrenceId) as RawOccurrence,
      ),
      cards,
    };
  })();
}

export function getItem(handle: DatabaseHandle, id: string): ItemRow | null {
  const row = handle.sqlite
    .prepare('SELECT * FROM learning_items WHERE id = ?')
    .get(id) as RawItem | undefined;
  return row ? toItem(row) : null;
}

export interface ListItemsOptions {
  status?: ItemStatus;
  itemType?: LearningItemType;
  videoId?: string;
  cursor?: string;
  limit?: number;
}

export function listItems(
  handle: DatabaseHandle,
  profileId: string,
  options: ListItemsOptions = {},
): { items: ItemRow[]; nextCursor: string | null } {
  const limit = Math.min(options.limit ?? 50, 200);
  const where: string[] = ['i.profile_id = ?'];
  const params: unknown[] = [profileId];

  if (options.status) {
    where.push('i.status = ?');
    params.push(options.status);
  }
  if (options.itemType) {
    where.push('i.item_type = ?');
    params.push(options.itemType);
  }
  if (options.videoId) {
    where.push('EXISTS (SELECT 1 FROM item_occurrences o WHERE o.item_id = i.id AND o.video_id = ?)');
    params.push(options.videoId);
  }
  if (options.cursor) {
    // Ids are monotonic ULIDs, so id order is creation order and needs no second column.
    where.push('i.id < ?');
    params.push(options.cursor);
  }

  const rows = handle.sqlite
    .prepare(
      `SELECT i.* FROM learning_items i
        WHERE ${where.join(' AND ')}
        ORDER BY i.id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as RawItem[];

  const page = rows.slice(0, limit).map(toItem);
  const last = page[page.length - 1];
  return {
    items: page,
    nextCursor: rows.length > limit && last ? last.id : null,
  };
}

export function listOccurrences(handle: DatabaseHandle, itemId: string): OccurrenceRow[] {
  return (
    handle.sqlite
      .prepare(
        'SELECT * FROM item_occurrences WHERE item_id = ? ORDER BY is_primary_occurrence DESC, start_ms ASC',
      )
      .all(itemId) as RawOccurrence[]
  ).map(toOccurrence);
}

export function getPrimaryOccurrence(
  handle: DatabaseHandle,
  itemId: string,
): OccurrenceRow | null {
  const row = handle.sqlite
    .prepare('SELECT * FROM item_occurrences WHERE item_id = ? AND is_primary_occurrence = 1')
    .get(itemId) as RawOccurrence | undefined;
  return row ? toOccurrence(row) : null;
}

export function listDefinitions(handle: DatabaseHandle, itemId: string): DefinitionRow[] {
  const rows = handle.sqlite
    .prepare('SELECT * FROM definitions WHERE item_id = ? ORDER BY created_at DESC, rowid DESC')
    .all(itemId) as Array<{
    id: string;
    item_id: string;
    provider: string;
    definition: string;
    translation: string | null;
    evidence_json: string | null;
    confidence: number | null;
    is_user_edited: number;
    created_at: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    itemId: r.item_id,
    provider: r.provider,
    definition: r.definition,
    translation: r.translation,
    evidenceJson: r.evidence_json,
    confidence: r.confidence,
    isUserEdited: r.is_user_edited === 1,
    createdAt: r.created_at,
  }));
}

export function listTranslations(
  handle: DatabaseHandle,
  itemId: string,
): Array<{ language: string; kind: string; text: string }> {
  return handle.sqlite
    .prepare('SELECT language, kind, text FROM item_translations WHERE item_id = ?')
    .all(itemId) as Array<{ language: string; kind: string; text: string }>;
}

export function listCardsForItem(handle: DatabaseHandle, itemId: string): CardRow[] {
  return (
    handle.sqlite
      .prepare('SELECT * FROM cards WHERE item_id = ? ORDER BY card_type')
      .all(itemId) as RawCard[]
  ).map(toCard);
}

export function getCard(handle: DatabaseHandle, id: string): CardRow | null {
  const row = handle.sqlite.prepare('SELECT * FROM cards WHERE id = ?').get(id) as
    | RawCard
    | undefined;
  return row ? toCard(row) : null;
}

/** The most recent scheduler rating per card, for the `SkillState` projection. */
export function lastRatingsByCard(
  handle: DatabaseHandle,
  itemId: string,
): Map<string, SchedulerRating> {
  const rows = handle.sqlite
    .prepare(
      `SELECT card_id, scheduler_rating FROM reviews
        WHERE item_id = ? AND scheduler_rating IS NOT NULL AND card_id IS NOT NULL
        ORDER BY created_at ASC, rowid ASC`,
    )
    .all(itemId) as Array<{ card_id: string; scheduler_rating: string }>;
  const out = new Map<string, SchedulerRating>();
  // Ascending, so the last write per card wins and is the newest.
  for (const row of rows) out.set(row.card_id, row.scheduler_rating as SchedulerRating);
  return out;
}

/**
 * `status` and the learner flags are two different things (`01-domain-model.md` §2), so
 * suspension writes both: the item's lifecycle status and the card rows the scheduler
 * reads. `learner_item_states.suspended` is the learner-facing flag.
 */
export function setItemSuspended(
  handle: DatabaseHandle,
  profileId: string,
  itemId: string,
  suspended: boolean,
): ItemRow {
  const at = now();
  return handle.sqlite.transaction(() => {
    const item = getItem(handle, itemId);
    if (!item || item.profileId !== profileId) throw P80Error.notFound('Item');

    handle.sqlite
      .prepare('UPDATE learning_items SET status = ?, updated_at = ? WHERE id = ?')
      .run(suspended ? 'suspended' : 'active', at, itemId);
    handle.sqlite
      .prepare('UPDATE cards SET suspended_at = ? WHERE item_id = ?')
      .run(suspended ? at : null, itemId);
    handle.sqlite
      .prepare(
        'UPDATE learner_item_states SET suspended = ?, updated_at = ? WHERE item_id = ? AND profile_id = ?',
      )
      .run(suspended ? 1 : 0, at, itemId, profileId);

    return getItem(handle, itemId) as ItemRow;
  })();
}

export function setItemStarred(
  handle: DatabaseHandle,
  profileId: string,
  itemId: string,
  starred: boolean,
): void {
  const item = getItem(handle, itemId);
  if (!item || item.profileId !== profileId) throw P80Error.notFound('Item');
  handle.sqlite
    .prepare(
      'UPDATE learner_item_states SET starred = ?, updated_at = ? WHERE item_id = ? AND profile_id = ?',
    )
    .run(starred ? 1 : 0, now(), itemId, profileId);
}

export interface UpdateItemInput {
  canonicalForm?: string;
  normalizedForm?: string;
  meaning?: string;
  register?: Register;
  lemma?: string | null;
  partOfSpeech?: string | null;
  dialectRegion?: string | null;
  offensiveOrSensitive?: boolean;
}

export function updateItem(
  handle: DatabaseHandle,
  profileId: string,
  itemId: string,
  input: UpdateItemInput,
): ItemRow {
  const at = now();
  return handle.sqlite.transaction(() => {
    const item = getItem(handle, itemId);
    if (!item || item.profileId !== profileId) throw P80Error.notFound('Item');

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown) => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (input.canonicalForm !== undefined) push('canonical_form', input.canonicalForm);
    if (input.normalizedForm !== undefined) push('normalized_form', input.normalizedForm);
    if (input.meaning !== undefined) push('meaning', input.meaning);
    if (input.register !== undefined) push('register', input.register);
    if (input.lemma !== undefined) push('lemma', input.lemma);
    if (input.partOfSpeech !== undefined) push('part_of_speech', input.partOfSpeech);
    if (input.dialectRegion !== undefined) push('dialect_region', input.dialectRegion);
    if (input.offensiveOrSensitive !== undefined) {
      push('offensive_or_sensitive', input.offensiveOrSensitive ? 1 : 0);
    }

    if (sets.length > 0) {
      push('updated_at', at);
      handle.sqlite
        .prepare(`UPDATE learning_items SET ${sets.join(', ')} WHERE id = ?`)
        .run(...params, itemId);
    }

    // An edited meaning is a new definition row, not an overwrite. `03-api.md` §5 asks for
    // definition edits in the history, which is only possible if the old one is still there.
    if (input.meaning !== undefined && input.meaning !== item.meaning) {
      handle.sqlite
        .prepare(
          `INSERT INTO definitions
             (id, item_id, provider, definition, evidence_json, confidence, is_user_edited, created_at)
           VALUES (?, ?, ?, ?, NULL, ?, 1, ?)`,
        )
        .run(
          newId(),
          itemId,
          USER_DEFINITION_PROVIDER,
          input.meaning,
          MANUAL_ITEM_SCORES.definitionConfidence,
          at,
        );
    }

    return getItem(handle, itemId) as ItemRow;
  })();
}
