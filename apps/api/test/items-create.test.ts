import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';
import { seedReadyTranscript, segment } from './transcript-fixture.js';

/**
 * Stage 3 exit criterion 1 — a user can manually create an item — and the ADR 0020
 * decisions that make it possible.
 *
 * The selection resolution is the part worth testing hard. It is the boundary where an
 * untrusted client offset becomes a database row, and every way it can be wrong produces a
 * plausible-looking item anchored to text nobody highlighted.
 */

const SEGMENTS = [
  segment(0, 0, 3_000, 'Ich habe ihn gestern zufaellig getroffen.'),
  segment(1, 3_000, 6_500, 'Das war eine grosse Ueberraschung fuer mich.'),
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

function createItem(body: Record<string, unknown>) {
  return api.server.app.inject({ method: 'POST', url: '/api/items', payload: body });
}

/** The offsets a browser would compute for a word inside the first segment. */
function spanFor(text: string, needle: string) {
  const start = text.indexOf(needle);
  return { spanStart: start, spanEnd: start + needle.length };
}

describe('POST /api/items', () => {
  it('creates an item, its occurrence, and its cards from one selection', async () => {
    const response = await createItem({
      videoId,
      selection: {
        segmentIds: [segmentIds[0]],
        ...spanFor(SEGMENTS[0]!.rawText, 'zufaellig'),
      },
      canonicalForm: 'zufällig',
      itemType: 'word',
      meaning: 'by chance, coincidentally',
      translation: 'by chance',
    });

    expect(response.statusCode).toBe(201);
    const item = response.json();
    expect(item.canonicalForm).toBe('zufällig');
    expect(item.status).toBe('active');
    expect(item.senseKey).toBe('by-chance-coincidentally');

    // §7 invariant 2: an active item has an occurrence and a stored meaning.
    expect(item.occurrences).toHaveLength(1);
    expect(item.occurrences[0].surfaceForm).toBe('zufaellig');
    expect(item.occurrences[0].isPrimaryOccurrence).toBe(true);
    expect(item.definitions).toHaveLength(1);
    expect(item.definitions[0].definition).toBe('by chance, coincidentally');

    // §2's table for a word with a useful source sentence.
    expect(Object.keys(item.skills).sort()).toEqual([
      'audio_recognition',
      'contextual_cloze',
      'productive_recall',
    ]);
    for (const skill of Object.values(item.skills) as Array<{ cardId: string | null }>) {
      expect(skill.cardId).not.toBeNull();
    }
  });

  it('labels a user-authored gloss unverified, however confident the number', () => {
    // Hard rule 11 and ADR 0020 §3: confidence is about provenance, verification is about
    // dictionary evidence, and the two are not the same claim.
    return createItem({
      videoId,
      selection: { segmentIds: [segmentIds[0]], ...spanFor(SEGMENTS[0]!.rawText, 'gestern') },
      canonicalForm: 'gestern',
      itemType: 'word',
      meaning: 'yesterday',
    }).then((response) => {
      const item = response.json();
      expect(item.definitions[0].verified).toBe(false);
      expect(item.definitions[0].isUserEdited).toBe(true);
      expect(item.definitions[0].provider).toBe('user');
      expect(item.scores.definitionConfidence).toBe(1);
    });
  });

  it('reports the three ranking scores as unscored rather than as zero-valued', async () => {
    const response = await createItem({
      videoId,
      selection: { segmentIds: [segmentIds[0]], ...spanFor(SEGMENTS[0]!.rawText, 'getroffen') },
      canonicalForm: 'treffen',
      itemType: 'word',
      meaning: 'to meet',
    });
    const item = response.json();
    expect(item.unscored).toBe(true);
    expect(item.scores.domainFrequency).toBe(0);
    // The distinction the flag exists for: extraction confidence is a real 1.0, because a
    // person selected the span.
    expect(item.scores.extractionConfidence).toBe(1);
  });

  it('refuses a second item with the same form and the same described sense', async () => {
    const body = {
      videoId,
      selection: { segmentIds: [segmentIds[0]], ...spanFor(SEGMENTS[0]!.rawText, 'gestern') },
      canonicalForm: 'gestern',
      itemType: 'word',
      meaning: 'yesterday',
    };
    const first = await createItem(body);
    expect(first.statusCode).toBe(201);

    const second = await createItem(body);
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('ITEM_SENSE_EXISTS');
    // ADR 0020 §1: it names the item the user already has rather than auto-suffixing a
    // second sense into existence.
    expect(second.json().error.details.itemId).toBe(first.json().id);
  });

  it('keeps two genuinely different senses of one form apart', async () => {
    const selection = {
      segmentIds: [segmentIds[0]],
      ...spanFor(SEGMENTS[0]!.rawText, 'gestern'),
    };
    const a = await createItem({
      videoId,
      selection,
      canonicalForm: 'Bank',
      itemType: 'word',
      meaning: 'financial institution',
    });
    const b = await createItem({
      videoId,
      selection,
      canonicalForm: 'Bank',
      itemType: 'word',
      meaning: 'bench, seat',
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json().senseKey).not.toBe(b.json().senseKey);
  });

  it('anchors the occurrence to a sentence derived from the segment', async () => {
    // ADR 0020 §2. Without a `sentences` row the insert cannot happen at all, so this
    // asserts the row exists and links back to the segment it came from.
    const response = await createItem({
      videoId,
      selection: { segmentIds: [segmentIds[0]], ...spanFor(SEGMENTS[0]!.rawText, 'zufaellig') },
      canonicalForm: 'zufällig',
      itemType: 'word',
      meaning: 'by chance',
    });
    const sentenceId = response.json().occurrences[0].sentenceId;

    const link = api.server.handle.sqlite
      .prepare('SELECT transcript_segment_id FROM sentence_segments WHERE sentence_id = ?')
      .get(sentenceId) as { transcript_segment_id: string } | undefined;
    expect(link?.transcript_segment_id).toBe(segmentIds[0]);
  });

  it('reuses one sentence row for two selections in the same segment', async () => {
    const first = await createItem({
      videoId,
      selection: { segmentIds: [segmentIds[0]], ...spanFor(SEGMENTS[0]!.rawText, 'gestern') },
      canonicalForm: 'gestern',
      itemType: 'word',
      meaning: 'yesterday',
    });
    const second = await createItem({
      videoId,
      selection: { segmentIds: [segmentIds[0]], ...spanFor(SEGMENTS[0]!.rawText, 'zufaellig') },
      canonicalForm: 'zufällig',
      itemType: 'word',
      meaning: 'by chance',
    });

    // Keyed by `(video_id, sequence_index)`, so the second selection finds the row rather
    // than colliding with the unique constraint.
    expect(second.statusCode).toBe(201);
    expect(second.json().occurrences[0].sentenceId).toBe(
      first.json().occurrences[0].sentenceId,
    );
  });

  it('spans a selection across two segments and keeps the whole context', async () => {
    const joined = `${SEGMENTS[0]!.rawText} ${SEGMENTS[1]!.rawText}`;
    const start = joined.indexOf('getroffen');
    const response = await createItem({
      videoId,
      selection: { segmentIds, spanStart: start, spanEnd: joined.indexOf('war') + 3 },
      canonicalForm: 'getroffen. Das war',
      itemType: 'multiword_expression',
      meaning: 'a stretch spanning two cues',
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().occurrences[0].sentenceText).toBe(joined);
  });
});

describe('a selection that does not resolve', () => {
  const base = {
    canonicalForm: 'x',
    itemType: 'word' as const,
    meaning: 'placeholder',
  };

  it('refuses a segment from another video', async () => {
    const otherVideoId = await seedReadyTranscript(api, SEGMENTS, {
      mediaPath: 'german/andere.mp4',
    });
    const other = await api.server.app.inject({
      method: 'GET',
      url: `/api/videos/${otherVideoId}/transcript`,
    });
    const foreignId = other.json().segments[0].id as string;

    const response = await createItem({
      ...base,
      videoId,
      selection: { segmentIds: [foreignId], spanStart: 0, spanEnd: 3 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_SELECTION');
  });

  it('refuses offsets past the end of the joined text rather than clamping them', async () => {
    // Clamping would produce an item anchored to text nobody highlighted, and the anchor
    // is the whole value of an occurrence.
    const response = await createItem({
      ...base,
      videoId,
      selection: { segmentIds: [segmentIds[0]], spanStart: 0, spanEnd: 9_999 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_SELECTION');
  });

  it('refuses an empty span', async () => {
    const response = await createItem({
      ...base,
      videoId,
      selection: { segmentIds: [segmentIds[0]], spanStart: 4, spanEnd: 4 },
    });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a selection of nothing but whitespace', async () => {
    const spaceAt = SEGMENTS[0]!.rawText.indexOf(' ');
    const response = await createItem({
      ...base,
      videoId,
      selection: { segmentIds: [segmentIds[0]], spanStart: spaceAt, spanEnd: spaceAt + 1 },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('INVALID_SELECTION');
  });
});

describe('card generation through the API', () => {
  it('omits the cloze when the sentence leaves no usable context', async () => {
    const shortVideo = await seedReadyTranscript(api, [segment(0, 0, 900, 'Genau.')], {
      mediaPath: 'german/kurz.mp4',
    });
    const transcript = await api.server.app.inject({
      method: 'GET',
      url: `/api/videos/${shortVideo}/transcript`,
    });
    const id = transcript.json().segments[0].id as string;

    const response = await createItem({
      videoId: shortVideo,
      selection: { segmentIds: [id], spanStart: 0, spanEnd: 5 },
      canonicalForm: 'genau',
      itemType: 'word',
      meaning: 'exactly',
    });
    const item = response.json();
    expect(item.skills.contextual_cloze.cardId).toBeNull();
    expect(item.skills.contextual_cloze.phase).toBe('not_started');
    expect(item.skills.audio_recognition.cardId).not.toBeNull();
  });

  it('honours an explicit override of the heuristic', async () => {
    const shortVideo = await seedReadyTranscript(api, [segment(0, 0, 900, 'Genau.')], {
      mediaPath: 'german/kurz-2.mp4',
    });
    const transcript = await api.server.app.inject({
      method: 'GET',
      url: `/api/videos/${shortVideo}/transcript`,
    });
    const id = transcript.json().segments[0].id as string;

    const response = await createItem({
      videoId: shortVideo,
      selection: { segmentIds: [id], spanStart: 0, spanEnd: 5 },
      canonicalForm: 'genau',
      itemType: 'word',
      meaning: 'exactly',
      includeClozeCard: true,
    });
    expect(response.json().skills.contextual_cloze.cardId).not.toBeNull();
  });
});

describe('deleting the video an item came from', () => {
  /**
   * `01-domain-model.md` §7 invariant 5. Found by the first live smoke run that created an
   * item and then deleted its video — the cascade took the occurrence and left the item
   * `active` with nothing to play, which is invariant 2's forbidden state reachable through
   * the ordinary Delete button.
   *
   * Nothing could have caught it before this stage, because there were no items.
   */
  it('archives the item rather than deleting it, and says how many', async () => {
    const created = await createItem({
      videoId,
      selection: { segmentIds: [segmentIds[0]], ...spanFor(SEGMENTS[0]!.rawText, 'zufaellig') },
      canonicalForm: 'zufällig',
      itemType: 'word',
      meaning: 'by chance',
    });
    const itemId = created.json().id as string;

    const deleted = await api.server.app.inject({
      method: 'DELETE',
      url: `/api/videos/${videoId}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json().archivedItems).toBe(1);

    const item = await api.server.app.inject({ method: 'GET', url: `/api/items/${itemId}` });
    expect(item.statusCode).toBe(200);
    // Survives, so the review history stays interpretable...
    expect(item.json().status).toBe('archived');
    expect(item.json().occurrences).toHaveLength(0);
  });

  it('keeps an archived item out of the next session', async () => {
    await createItem({
      videoId,
      selection: { segmentIds: [segmentIds[0]], ...spanFor(SEGMENTS[0]!.rawText, 'gestern') },
      canonicalForm: 'gestern',
      itemType: 'word',
      meaning: 'yesterday',
    });
    await api.server.app.inject({ method: 'DELETE', url: `/api/videos/${videoId}` });

    // `status = 'archived'` is enough — every session query filters on `active` — so the
    // cards keep their history rather than being deleted alongside.
    const session = await api.server.app.inject({
      method: 'POST',
      url: '/api/review/session',
      payload: { desiredMinutes: 30 },
    });
    expect(session.json().plan.cards).toHaveLength(0);
  });

  it('reports zero when the video had no items', async () => {
    const deleted = await api.server.app.inject({
      method: 'DELETE',
      url: `/api/videos/${videoId}`,
    });
    expect(deleted.json().archivedItems).toBe(0);
  });
});
