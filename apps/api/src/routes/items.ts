import { z } from 'zod';
import {
  CARD_TYPES,
  ERROR_CODES,
  ITEM_STATUSES,
  LEARNING_ITEM_TYPES,
  MANUAL_ITEM_SCORES,
  P80Error,
  charSpanToWordOffsets,
  createItemRequest,
  deriveSenseKey,
  emptySkillState,
  itemHistoryResponse,
  itemListResponse,
  itemResponse,
  newSchedule,
  normalizeItemForm,
  now,
  parseSnapshot,
  planCards,
  projectSkillState,
  resolveSpanTiming,
  type CardType,
  type ItemPayload,
  type SkillState,
} from '@p80/core';
import {
  createManualItem,
  ensureProfile,
  getItem,
  getLatestTranscriptFile,
  getVideo,
  lastRatingsByCard,
  listCardsForItem,
  listDefinitions,
  listItemReviews,
  listItems,
  listOccurrences,
  listSegmentsWithCorrections,
  listTranslations,
  listWords,
  setItemStarred,
  setItemSuspended,
  updateItem,
  type DatabaseHandle,
  type ItemRow,
  type SelectedSegment,
} from '@p80/database';
import type { App } from '../app.js';

/**
 * Learning items — `03-api.md` §5, plus `POST /api/items` from ADR 0020.
 *
 * The create endpoint is the interesting one. Its body carries a **selection**, not a
 * timing: segment ids and character offsets, exactly what a browser can produce from a
 * `Selection` object. The server joins the segments, resolves the offsets onto the word
 * array, and derives the clip window. A client that could send its own `startMs` would be
 * holding domain logic (ADR 0007), and one that could send arbitrary sentence ids would be
 * addressing another video's rows.
 */

/** Segments are joined by a single space to form the selection's context text. The client
 *  builds the same string to compute its offsets, so the two must agree exactly — hence a
 *  named constant rather than a literal in two files. */
const SEGMENT_JOINER = ' ';

interface ResolvedSelection {
  segments: SelectedSegment[];
  contextText: string;
  surfaceForm: string;
  spanStart: number;
  spanEnd: number;
  precedingText: string | null;
  followingText: string | null;
  startMs: number;
  endMs: number;
  timingPrecision: 'word' | 'cue';
}

/**
 * Turn a client selection into times and text, or refuse it.
 *
 * Every failure here is `INVALID_SELECTION` rather than a silent repair. A selection that
 * does not resolve is a selection the user did not make — clamping it would produce an
 * item anchored to text nobody highlighted, and the anchor is the whole value of the
 * occurrence.
 */
function resolveSelection(
  handle: DatabaseHandle,
  videoId: string,
  selection: { segmentIds: string[]; spanStart: number; spanEnd: number },
): ResolvedSelection {
  const { segments: all } = listSegmentsWithCorrections(handle, videoId, { limit: 100_000 });
  const byId = new Map(all.map((s) => [s.id, s]));

  const chosen = selection.segmentIds.map((id) => {
    const segment = byId.get(id);
    if (!segment) {
      // Scoped by video: a segment id from another video is not found, not forbidden.
      throw new P80Error(
        ERROR_CODES.INVALID_SELECTION,
        'That selection does not belong to this video.',
        { statusCode: 400, details: { segmentId: id } },
      );
    }
    return segment;
  });

  // Reading order, whatever order the client sent them in.
  chosen.sort((a, b) => a.startMs - b.startMs || a.sequenceIndex - b.sequenceIndex);

  const contextText = chosen.map((s) => s.text).join(SEGMENT_JOINER);
  const spanStart = selection.spanStart;
  const spanEnd = selection.spanEnd;
  if (spanEnd <= spanStart || spanEnd > contextText.length) {
    throw new P80Error(
      ERROR_CODES.INVALID_SELECTION,
      'That selection does not line up with the transcript. Try selecting it again.',
      { statusCode: 400, details: { spanStart, spanEnd, contextLength: contextText.length } },
    );
  }

  const surfaceForm = contextText.slice(spanStart, spanEnd).trim();
  if (surfaceForm.length === 0) {
    throw new P80Error(ERROR_CODES.INVALID_SELECTION, 'That selection is only whitespace.', {
      statusCode: 400,
    });
  }

  // Which segment the span starts in, and where inside it. The occurrence anchors there.
  let cursor = 0;
  let anchorIndex = 0;
  let offsetInAnchor = spanStart;
  for (let i = 0; i < chosen.length; i += 1) {
    const segment = chosen[i]!;
    const end = cursor + segment.text.length;
    if (spanStart < end || i === chosen.length - 1) {
      anchorIndex = i;
      offsetInAnchor = Math.max(0, spanStart - cursor);
      break;
    }
    cursor = end + SEGMENT_JOINER.length;
  }
  const anchor = chosen[anchorIndex]!;
  const spanEndInAnchor = Math.min(anchor.text.length, offsetInAnchor + (spanEnd - spanStart));

  // Word-level timing where ADR 0017 gives it, cue timing where it does not. The two are
  // distinguished in the response rather than absorbed.
  const file = getLatestTranscriptFile(handle, videoId);
  const words =
    file && file.timingGranularity === 'word' ? listWords(handle, file.id) : null;
  const segmentWords =
    words && anchor.wordStartIndex !== null && anchor.wordEndIndex !== null
      ? words.slice(anchor.wordStartIndex, anchor.wordEndIndex)
      : null;
  const wordSpan = segmentWords
    ? charSpanToWordOffsets(segmentWords, offsetInAnchor, spanEndInAnchor)
    : null;

  const timing = resolveSpanTiming({
    segment: {
      startMs: anchor.startMs,
      endMs: anchor.endMs,
      wordStartIndex: anchor.wordStartIndex,
      wordEndIndex: anchor.wordEndIndex,
      corrected: anchor.corrected,
    },
    words,
    ...(wordSpan ? { span: wordSpan } : {}),
  });

  const before = contextText.slice(0, spanStart).trim();
  const after = contextText.slice(spanEnd).trim();

  return {
    segments: chosen.map((s) => ({
      id: s.id,
      sequenceIndex: s.sequenceIndex,
      startMs: s.startMs,
      endMs: s.endMs,
      text: s.text,
      normalizedText: s.normalizedText,
    })),
    contextText,
    surfaceForm,
    spanStart,
    spanEnd,
    precedingText: before.length > 0 ? before : null,
    followingText: after.length > 0 ? after : null,
    startMs: timing.startMs,
    endMs: timing.endMs,
    timingPrecision: timing.precision,
  };
}

/**
 * The full item payload, including the `SkillState` projection.
 *
 * `01-domain-model.md` §2.1: `SkillState` is derived on read and never stored. Every card
 * type appears in `skills`, including the ones with no card — `not_started` is the answer
 * to "how is production going" for an item that never got a production card, and omitting
 * the key would make the client guess.
 */
function toItemPayload(handle: DatabaseHandle, item: ItemRow): ItemPayload {
  // Memoised for this call only. An item's occurrences usually share a video, and a
  // longer-lived cache would go stale the moment a transcript is replaced with one of a
  // different timing tier — which is a supported operation, not a rare one.
  const precisionByVideo = new Map<string, 'word' | 'cue'>();
  const precisionOf = (videoId: string): 'word' | 'cue' => {
    const hit = precisionByVideo.get(videoId);
    if (hit) return hit;
    const file = getLatestTranscriptFile(handle, videoId);
    const value = file?.timingGranularity === 'word' ? 'word' : 'cue';
    precisionByVideo.set(videoId, value);
    return value;
  };

  const cards = listCardsForItem(handle, item.id);
  const lastRatings = lastRatingsByCard(handle, item.id);
  const definitions = listDefinitions(handle, item.id);

  const skills = {} as Record<CardType, SkillState>;
  for (const cardType of CARD_TYPES) {
    const card = cards.find((c) => c.cardType === cardType);
    skills[cardType] = card
      ? projectSkillState({
          cardId: card.id,
          snapshot: parseSnapshot(card.fsrsStateJson),
          suspendedAt: card.suspendedAt,
          lastRating: lastRatings.get(card.id) ?? null,
        })
      : emptySkillState();
  }

  return {
    id: item.id,
    profileId: item.profileId,
    targetLanguage: item.targetLanguage,
    canonicalForm: item.canonicalForm,
    normalizedForm: item.normalizedForm,
    lemma: item.lemma,
    itemType: item.itemType,
    senseKey: item.senseKey,
    partOfSpeech: item.partOfSpeech,
    meaning: item.meaning,
    register: item.register,
    dialectRegion: item.dialectRegion,
    offensiveOrSensitive: item.offensiveOrSensitive,
    status: item.status,
    scores: {
      domainFrequency: item.domainFrequencyScore,
      contextualDiversity: item.contextualDiversityScore,
      reusePotential: item.reusePotentialScore,
      extractionConfidence: item.extractionConfidence,
      definitionConfidence: item.definitionConfidence,
    },
    // ADR 0020 §3. Computed rather than stored, because there is no `scored_at` column and
    // a client must not infer "worthless" from three zeros.
    unscored:
      item.domainFrequencyScore === MANUAL_ITEM_SCORES.domainFrequencyScore &&
      item.contextualDiversityScore === MANUAL_ITEM_SCORES.contextualDiversityScore &&
      item.reusePotentialScore === MANUAL_ITEM_SCORES.reusePotentialScore,
    translations: listTranslations(handle, item.id),
    definitions: definitions.map((d) => ({
      id: d.id,
      provider: d.provider,
      definition: d.definition,
      translation: d.translation,
      // Hard rule 11. No dictionary evidence, no verified label — computed here so the two
      // clients cannot disagree about what counts.
      verified: d.evidenceJson !== null,
      confidence: d.confidence,
      isUserEdited: d.isUserEdited,
      createdAt: d.createdAt,
    })),
    skills,
    occurrences: listOccurrences(handle, item.id).map((o) => ({
      id: o.id,
      itemId: o.itemId,
      videoId: o.videoId,
      sentenceId: o.sentenceId,
      startMs: o.startMs,
      endMs: o.endMs,
      // Stage 3 stores no per-occurrence precision column, and re-deriving it here would
      // mean re-reading the word array on every list. Word timing is what the creation
      // path produces whenever the transcript has it, so the honest report is the
      // transcript's own tier.
      timingPrecision: precisionOf(o.videoId),
      surfaceForm: o.surfaceForm,
      sentenceText: o.sentenceText,
      precedingText: o.precedingText,
      followingText: o.followingText,
      isPrimaryOccurrence: o.isPrimaryOccurrence,
    })),
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

export async function registerItemRoutes(
  app: App,
  deps: { handle: DatabaseHandle },
): Promise<void> {
  const { handle } = deps;

  /**
   * Create a learning item from a transcript selection (ADR 0020 §1).
   *
   * Not a back door around hard rule 6. That rule keeps the *pipeline* from admitting its
   * own output; every field of this body was typed by a person.
   */
  app.post(
    '/api/items',
    { schema: { body: createItemRequest, response: { 201: itemResponse } } },
    async (request, reply) => {
      const body = request.body;
      const profile = ensureProfile(handle);

      const video = getVideo(handle, body.videoId);
      if (!video || video.profileId !== profile.id) throw P80Error.notFound('Video');

      const selection = resolveSelection(handle, body.videoId, body.selection);

      const canonicalForm = body.canonicalForm.trim();
      const meaning = body.meaning.trim();
      const cardTypes = planCards({
        itemType: body.itemType,
        sentenceText: selection.contextText,
        spanStart: selection.spanStart,
        spanEnd: selection.spanEnd,
        includeAudio: body.includeAudioCard,
        includeCloze: body.includeClozeCard,
      });

      const at = now();
      const schedule = newSchedule(at);
      const created = createManualItem(handle, {
        profileId: profile.id,
        videoId: body.videoId,
        targetLanguage: video.targetLanguage,
        nativeLanguage: profile.nativeLanguage,
        canonicalForm,
        normalizedForm: normalizeItemForm(canonicalForm),
        itemType: body.itemType,
        senseKey: deriveSenseKey(meaning),
        meaning,
        translation: body.translation?.trim() || null,
        register: body.register,
        lemma: body.lemma?.trim() || null,
        partOfSpeech: body.partOfSpeech?.trim() || null,
        dialectRegion: body.dialectRegion?.trim() || null,
        offensiveOrSensitive: body.offensiveOrSensitive,
        segments: selection.segments,
        surfaceForm: selection.surfaceForm,
        sentenceText: selection.contextText,
        precedingText: selection.precedingText,
        followingText: selection.followingText,
        startMs: selection.startMs,
        endMs: selection.endMs,
        cardTypes,
        initialFsrsStateJson: JSON.stringify(schedule),
        initialDueAt: schedule.due,
      });

      reply.code(201);
      return toItemPayload(handle, created.item);
    },
  );

  app.get(
    '/api/items',
    {
      schema: {
        querystring: z.object({
          status: z.enum(ITEM_STATUSES).optional(),
          itemType: z.enum(LEARNING_ITEM_TYPES).optional(),
          videoId: z.string().optional(),
          cursor: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
        }),
        response: { 200: itemListResponse },
      },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const page = listItems(handle, profile.id, request.query);
      return {
        items: page.items.map((item) => toItemPayload(handle, item)),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/api/items/:id',
    {
      schema: { params: z.object({ id: z.string() }), response: { 200: itemResponse } },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const item = getItem(handle, request.params.id);
      if (!item || item.profileId !== profile.id) throw P80Error.notFound('Item');
      return toItemPayload(handle, item);
    },
  );

  app.put(
    '/api/items/:id',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: createItemRequest
          .pick({
            canonicalForm: true,
            meaning: true,
            register: true,
            lemma: true,
            partOfSpeech: true,
            dialectRegion: true,
            offensiveOrSensitive: true,
          })
          .partial(),
        response: { 200: itemResponse },
      },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const patch = request.body;
      const item = updateItem(handle, profile.id, request.params.id, {
        ...patch,
        ...(patch.canonicalForm !== undefined
          ? { normalizedForm: normalizeItemForm(patch.canonicalForm) }
          : {}),
      });
      return toItemPayload(handle, item);
    },
  );

  for (const [path, suspended] of [
    ['/api/items/:id/suspend', true],
    ['/api/items/:id/unsuspend', false],
  ] as const) {
    app.post(
      path,
      { schema: { params: z.object({ id: z.string() }), response: { 200: itemResponse } } },
      async (request) => {
        const profile = ensureProfile(handle);
        return toItemPayload(
          handle,
          setItemSuspended(handle, profile.id, request.params.id, suspended),
        );
      },
    );
  }

  app.post(
    '/api/items/:id/star',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ starred: z.boolean().default(true) }),
        response: { 200: itemResponse },
      },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      setItemStarred(handle, profile.id, request.params.id, request.body.starred);
      const item = getItem(handle, request.params.id);
      if (!item) throw P80Error.notFound('Item');
      return toItemPayload(handle, item);
    },
  );

  app.get(
    '/api/items/:id/occurrences',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: itemResponse.pick({ occurrences: true }) },
      },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const item = getItem(handle, request.params.id);
      if (!item || item.profileId !== profile.id) throw P80Error.notFound('Item');
      return { occurrences: toItemPayload(handle, item).occurrences };
    },
  );

  /** §5: "reviews + definition edits + provenance". Stage 3 exit criterion 6. */
  app.get(
    '/api/items/:id/history',
    {
      schema: { params: z.object({ id: z.string() }), response: { 200: itemHistoryResponse } },
    },
    async (request) => {
      const profile = ensureProfile(handle);
      const item = getItem(handle, request.params.id);
      if (!item || item.profileId !== profile.id) throw P80Error.notFound('Item');

      return {
        itemId: item.id,
        reviews: listItemReviews(handle, item.id).map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          cardId: r.cardId,
          cardType: r.cardType,
          contextMode: r.contextMode,
          shownAt: r.shownAt,
          answeredAt: r.answeredAt,
          responseText: r.responseText,
          responseLatencyMs: r.responseLatencyMs,
          machineClassification: r.machineClassification,
          schedulerRating: r.schedulerRating,
          hintCount: r.hintCount,
          sourceContextUsed: r.sourceContextUsed,
          occurrenceId: r.occurrenceId,
        })),
        definitions: listDefinitions(handle, item.id).map((d) => ({
          id: d.id,
          provider: d.provider,
          definition: d.definition,
          translation: d.translation,
          verified: d.evidenceJson !== null,
          confidence: d.confidence,
          isUserEdited: d.isUserEdited,
          createdAt: d.createdAt,
        })),
      };
    },
  );
}
