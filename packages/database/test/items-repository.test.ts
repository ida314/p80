import { newId, newSchedule } from '@p80/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualItem, getPrimaryOccurrence, listOccurrences } from '../src/repositories/items.js';
import { ensureProfile } from '../src/repositories/profile.js';
import { createVideo, setProcessingStatus } from '../src/repositories/videos.js';
import { insertTranscriptFile, replaceSegments } from '../src/repositories/transcripts.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * The invariants Stage 3 is the first stage able to break — exit criterion 7, and the
 * ADR 0020 §2 anchoring decision that Stage 4 has to respect.
 *
 * These are repository-level rather than HTTP-level on purpose: what is being asserted is
 * what the *database* enforces, and a test that goes through a route would pass just as
 * well if the guarantee lived in a handler instead of in the schema.
 */

let temp: TempDatabase;
let fixture: ReturnType<typeof seed>;

beforeEach(() => {
  fixture = seed();
});
afterEach(() => temp?.dispose());

function seed() {
  temp = createTempDatabase();
  const profile = ensureProfile(temp);
  const video = createVideo(temp, {
    profileId: profile.id,
    sourceType: 'local_media',
    externalVideoId: `hash-${newId()}`,
    url: 'german/folge-1.mp4',
    title: 'Folge 1',
    targetLanguage: profile.targetLanguage,
    mediaPath: 'german/folge-1.mp4',
  });
  insertTranscriptFile(temp, {
    id: newId(),
    videoId: video.id,
    format: 'vtt',
    originalFilename: 'folge-1.vtt',
    storagePath: '/tmp/folge-1.vtt',
    checksum: 'abc',
    parserVersion: '1',
  });
  replaceSegments(temp, video.id, [
    {
      startMs: 0,
      endMs: 3_000,
      speakerLabel: null,
      rawText: 'Ich habe ihn gestern zufaellig getroffen.',
      normalizedText: 'Ich habe ihn gestern zufaellig getroffen.',
      sequenceIndex: 0,
    },
  ]);
  setProcessingStatus(temp, video.id, 'transcript_ready');

  const segment = temp.sqlite
    .prepare('SELECT * FROM transcript_segments WHERE video_id = ?')
    .get(video.id) as {
    id: string;
    sequence_index: number;
    start_ms: number;
    end_ms: number;
    raw_text: string;
    normalized_text: string;
  };

  return { profile, video, segment };
}

function create(
  overrides: Partial<Parameters<typeof createManualItem>[1]> = {},
): ReturnType<typeof createManualItem> {
  const { profile, video, segment } = fixture;
  const at = Date.now();
  const schedule = newSchedule(at);
  return createManualItem(temp, {
    profileId: profile.id,
    videoId: video.id,
    targetLanguage: profile.targetLanguage,
    nativeLanguage: profile.nativeLanguage,
    canonicalForm: 'zufällig',
    normalizedForm: 'zufällig',
    itemType: 'word',
    senseKey: 'by-chance',
    meaning: 'by chance',
    translation: 'by chance',
    register: 'neutral',
    lemma: null,
    partOfSpeech: null,
    dialectRegion: null,
    offensiveOrSensitive: false,
    segments: [
      {
        id: segment.id,
        sequenceIndex: segment.sequence_index,
        startMs: segment.start_ms,
        endMs: segment.end_ms,
        text: segment.raw_text,
        normalizedText: segment.normalized_text,
      },
    ],
    surfaceForm: 'zufaellig',
    sentenceText: segment.raw_text,
    precedingText: 'Ich habe ihn gestern',
    followingText: 'getroffen.',
    startMs: 1_200,
    endMs: 1_900,
    cardTypes: ['audio_recognition', 'contextual_cloze', 'productive_recall'],
    initialFsrsStateJson: JSON.stringify(schedule),
    initialDueAt: schedule.due,
    ...overrides,
  });
}

describe('creating an item', () => {
  it('writes the item, its meaning, its form, its occurrence, and its cards together', () => {
    const created = create();

    expect(created.item.status).toBe('active');
    expect(created.cards).toHaveLength(3);
    expect(created.occurrence.isPrimaryOccurrence).toBe(true);

    const definitions = temp.sqlite
      .prepare('SELECT COUNT(*) AS n FROM definitions WHERE item_id = ?')
      .get(created.item.id) as { n: number };
    expect(definitions.n).toBe(1);

    // §4: forms are never collapsed into the canonical form, so the observed surface is
    // stored even when it differs from the label.
    const form = temp.sqlite
      .prepare('SELECT surface_form FROM item_forms WHERE item_id = ?')
      .get(created.item.id) as { surface_form: string };
    expect(form.surface_form).toBe('zufaellig');

    const learnerState = temp.sqlite
      .prepare('SELECT COUNT(*) AS n FROM learner_item_states WHERE item_id = ?')
      .get(created.item.id) as { n: number };
    expect(learnerState.n).toBe(1);
  });

  it('leaves nothing behind when the identity constraint rejects it', () => {
    const first = create();
    expect(() => create()).toThrow();

    // The whole insert is one transaction. A rejected second attempt must not leave an
    // orphan sentence, definition, or card — an item with no occurrence is invariant 2's
    // failure mode and nothing else would catch it.
    const items = temp.sqlite
      .prepare('SELECT COUNT(*) AS n FROM learning_items')
      .get() as { n: number };
    expect(items.n).toBe(1);
    const cards = temp.sqlite.prepare('SELECT COUNT(*) AS n FROM cards').get() as { n: number };
    expect(cards.n).toBe(3);
    const definitions = temp.sqlite
      .prepare('SELECT COUNT(*) AS n FROM definitions')
      .get() as { n: number };
    expect(definitions.n).toBe(1);
    expect(getPrimaryOccurrence(temp, first.item.id)).not.toBeNull();
  });

  it('gives every card the (target, native) direction ADR 0010 fixes for MVP', () => {
    const { profile } = fixture;
    const created = create();
    for (const card of created.cards) {
      expect(card.promptLanguage).toBe(profile.targetLanguage);
      expect(card.answerLanguage).toBe(profile.nativeLanguage);
    }
  });
});

describe('the primary-occurrence invariant', () => {
  it('allows exactly one primary occurrence per item', () => {
    const created = create();
    expect(listOccurrences(temp, created.item.id)).toHaveLength(1);

    // The partial unique index, not application logic. Stage 11 will add second
    // occurrences from other videos, and this is what stops two of them both claiming to
    // be the default clip.
    expect(() =>
      temp.sqlite
        .prepare(
          `INSERT INTO item_occurrences
             (id, item_id, video_id, sentence_id, start_ms, end_ms, surface_form,
              sentence_text, is_primary_occurrence)
           VALUES (?, ?, ?, ?, 0, 100, 'x', 'x', 1)`,
        )
        .run(
          newId(),
          created.item.id,
          created.occurrence.videoId,
          created.occurrence.sentenceId,
        ),
    ).toThrow(/UNIQUE/i);
  });
});

describe('ADR 0020 §2 — what an occurrence anchors to', () => {
  it('creates a sentence row keyed by the segment’s own sequence index', () => {
    const { segment, video } = fixture;
    const created = create();

    const sentence = temp.sqlite
      .prepare('SELECT * FROM sentences WHERE id = ?')
      .get(created.occurrence.sentenceId) as {
      video_id: string;
      sequence_index: number;
      text: string;
    };
    expect(sentence.video_id).toBe(video.id);
    expect(sentence.sequence_index).toBe(segment.sequence_index);
    expect(sentence.text).toBe(segment.raw_text);
  });

  it('is what Stage 4 must not delete — a cascade would take the item’s anchor', () => {
    // Not a test of behaviour P80 has; a test that documents the hazard the ADR names, so
    // that a future delete-and-rebuild reconstruction fails here first.
    const created = create();
    temp.sqlite.prepare('DELETE FROM sentences WHERE id = ?').run(created.occurrence.sentenceId);

    expect(listOccurrences(temp, created.item.id)).toHaveLength(0);
    // The item survives the cascade and is now in the state invariant 2 forbids: active
    // with no occurrence. Nothing detects it, which is exactly why the ADR forbids the
    // delete rather than relying on a check.
    const item = temp.sqlite
      .prepare('SELECT status FROM learning_items WHERE id = ?')
      .get(created.item.id) as { status: string };
    expect(item.status).toBe('active');
  });
});
