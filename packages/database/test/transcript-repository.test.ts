import { afterEach, describe, expect, it } from 'vitest';
import { newId } from '@p80/core';
import { enqueueJob, getJob } from '../src/repositories/jobs.js';
import { ensureProfile } from '../src/repositories/profile.js';
import { createVideo } from '../src/repositories/videos.js';
import {
  countCorrections,
  deleteTranscript,
  getSegment,
  insertCorrection,
  insertTranscriptFile,
  listSegmentsWithCorrections,
  replaceSegments,
  type SegmentInput,
} from '../src/repositories/transcripts.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * Stage 2 steps 10, 13 and 15, and exit criteria 2, 4, 7 and 9.
 *
 * The invariant under test throughout: `transcript_segments` is written once and never
 * mutated. Everything else here follows from that.
 */

let temp: TempDatabase;
afterEach(() => temp?.dispose());

function setup() {
  temp = createTempDatabase();
  const profile = ensureProfile(temp);
  const video = createVideo(temp, {
    profileId: profile.id,
    sourceType: 'local_media',
    externalVideoId: 'dQw4w9WgXcQ',
    url: 'german/folge-1.mp4',
    title: 'Folge 1',
    targetLanguage: 'de',
  });
  return { profile, video };
}

const seg = (i: number, startMs: number, endMs: number, text: string): SegmentInput => ({
  startMs,
  endMs,
  speakerLabel: null,
  rawText: text,
  normalizedText: text,
  sequenceIndex: i,
});

const THREE = [
  seg(0, 1_000, 3_000, 'Erste Zeile.'),
  seg(1, 3_000, 5_000, 'Zweite Zeile.'),
  seg(2, 5_000, 7_000, 'Dritte Zeile.'),
];

describe('replaceSegments', () => {
  it('is idempotent — running it twice leaves exactly one segment set', () => {
    // `UNIQUE (video_id, sequence_index)` means an insert-only handler trips on every
    // retry, so the delete inside the transaction is what makes PARSE_TRANSCRIPT
    // re-runnable at all.
    const { video } = setup();
    replaceSegments(temp, video.id, THREE);
    const first = listSegmentsWithCorrections(temp, video.id).segments;

    replaceSegments(temp, video.id, THREE);
    const second = listSegmentsWithCorrections(temp, video.id).segments;

    expect(second).toHaveLength(3);
    // Ids are fresh ULIDs on every run, so the assertion is on content, not identity.
    const shape = (rows: typeof first) =>
      rows.map((r) => [r.sequenceIndex, r.startMs, r.endMs, r.rawText, r.normalizedText]);
    expect(shape(second)).toEqual(shape(first));
  });

  it('leaves no rows behind if the insert throws partway', () => {
    const { video } = setup();
    replaceSegments(temp, video.id, THREE);
    const broken = [
      seg(0, 1_000, 3_000, 'Neu.'),
      // Duplicate sequence index — trips the unique constraint mid-loop.
      seg(0, 3_000, 5_000, 'Auch neu.'),
    ];
    expect(() => replaceSegments(temp, video.id, broken)).toThrow();
    // The transaction rolled back, so the previous set is intact rather than half-deleted.
    expect(listSegmentsWithCorrections(temp, video.id).segments).toHaveLength(3);
  });
});

describe('read ordering', () => {
  it('returns segments in timestamp order while sequence_index keeps file order', () => {
    // Exit criterion 2. The parser stores file order and warns; the reader sorts by time.
    const { video } = setup();
    replaceSegments(temp, video.id, [
      seg(0, 5_000, 7_000, 'Dritte'),
      seg(1, 1_000, 3_000, 'Erste'),
      seg(2, 3_000, 5_000, 'Zweite'),
    ]);
    const { segments } = listSegmentsWithCorrections(temp, video.id);
    expect(segments.map((s) => s.rawText)).toEqual(['Erste', 'Zweite', 'Dritte']);
    expect(segments.map((s) => s.sequenceIndex)).toEqual([1, 2, 0]);
  });

  it('pages by sequence index', () => {
    const { video } = setup();
    replaceSegments(temp, video.id, THREE);
    const first = listSegmentsWithCorrections(temp, video.id, { limit: 2 });
    expect(first.segments).toHaveLength(2);
    expect(first.nextCursor).toBe(1);
    const second = listSegmentsWithCorrections(temp, video.id, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.segments).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });
});

describe('corrections', () => {
  it('leaves the original segment row byte-identical', () => {
    // Exit criterion 7, and the most important assertion in this file. Everything
    // downstream — quality scoring, source replay, Stage 3 occurrences — depends on the
    // stored row not moving.
    const { video } = setup();
    replaceSegments(temp, video.id, THREE);
    const before = temp.sqlite
      .prepare('SELECT * FROM transcript_segments ORDER BY sequence_index')
      .all();

    const target = listSegmentsWithCorrections(temp, video.id).segments[0]!;
    insertCorrection(temp, {
      videoId: video.id,
      segmentId: target.id,
      beforeText: target.text,
      afterText: 'Erste Zeile, korrigiert.',
      beforeStartMs: target.startMs,
      afterStartMs: 500,
      beforeEndMs: target.endMs,
      afterEndMs: target.endMs,
    });

    const after = temp.sqlite
      .prepare('SELECT * FROM transcript_segments ORDER BY sequence_index')
      .all();
    expect(after).toEqual(before);
  });

  it('projects the latest correction over the original', () => {
    const { video } = setup();
    replaceSegments(temp, video.id, THREE);
    const target = listSegmentsWithCorrections(temp, video.id).segments[0]!;

    insertCorrection(temp, {
      videoId: video.id,
      segmentId: target.id,
      beforeText: target.text,
      afterText: 'Erste Fassung.',
      beforeStartMs: target.startMs,
      afterStartMs: target.startMs,
      beforeEndMs: target.endMs,
      afterEndMs: target.endMs,
    });
    const second = insertCorrection(temp, {
      videoId: video.id,
      segmentId: target.id,
      beforeText: 'Erste Fassung.',
      afterText: 'Zweite Fassung.',
      beforeStartMs: target.startMs,
      afterStartMs: 500,
      beforeEndMs: target.endMs,
      afterEndMs: 2_900,
    });

    const projected = listSegmentsWithCorrections(temp, video.id).segments[0]!;
    expect(projected).toMatchObject({
      text: 'Zweite Fassung.',
      startMs: 500,
      endMs: 2_900,
      corrected: true,
      correctionId: second,
    });
    // The original survives beside the correction — this is what the row's disclosure
    // shows, and what a Stage 3 item cut from this line must remain traceable to.
    expect(projected.rawText).toBe('Erste Zeile.');
    // Both correction rows are kept. History is evidence, not scratch space.
    expect(countCorrections(temp, video.id)).toBe(2);
  });

  it('resolves a same-millisecond tie to the correction written second', () => {
    // This is not hypothetical: nudging a timestamp with the keyboard produces two
    // corrections inside one millisecond routinely, and it is how this bug was found —
    // the test above passed alone and failed under full-suite load, because plain `ulid()`
    // randomises its entropy and the older correction won about half the time.
    //
    // The tie is forced here rather than raced for, so the guarantee is pinned instead of
    // incidental.
    const { video } = setup();
    replaceSegments(temp, video.id, THREE);
    const target = listSegmentsWithCorrections(temp, video.id).segments[0]!;

    const write = (afterText: string) =>
      insertCorrection(temp, {
        videoId: video.id,
        segmentId: target.id,
        beforeText: target.text,
        afterText,
        beforeStartMs: target.startMs,
        afterStartMs: target.startMs,
        beforeEndMs: target.endMs,
        afterEndMs: target.endMs,
      });

    const first = write('Erste Fassung.');
    const second = write('Zweite Fassung.');
    temp.sqlite.prepare('UPDATE transcript_corrections SET created_at = 1700000000000').run();

    expect(listSegmentsWithCorrections(temp, video.id).segments[0]).toMatchObject({
      text: 'Zweite Fassung.',
      correctionId: second,
    });
    expect(getSegment(temp, video.id, target.id)).toMatchObject({
      text: 'Zweite Fassung.',
      correctionId: second,
    });
    expect(first).not.toBe(second);
  });

  it('scopes a segment lookup by video, so one video cannot address another’s rows', () => {
    const { profile, video } = setup();
    const other = createVideo(temp, {
      profileId: profile.id,
      sourceType: 'local_media',
      externalVideoId: 'abcdefghijk',
      url: 'german/folge-1.mp4',
      title: 'Folge 2',
      targetLanguage: 'de',
    });
    replaceSegments(temp, video.id, THREE);
    const target = listSegmentsWithCorrections(temp, video.id).segments[0]!;

    expect(getSegment(temp, video.id, target.id)).not.toBeNull();
    expect(getSegment(temp, other.id, target.id)).toBeNull();
  });
});

describe('deleteTranscript', () => {
  it('reports what it removed and cancels a queued parse', () => {
    const { video } = setup();
    insertTranscriptFile(temp, {
      id: newId(),
      videoId: video.id,
      format: 'vtt',
      originalFilename: 'folge-1.vtt',
      storagePath: '/srv/storage/transcripts/x/y.vtt',
      checksum: 'abc',
      parserVersion: '1',
    });
    replaceSegments(temp, video.id, THREE);
    const target = listSegmentsWithCorrections(temp, video.id).segments[0]!;
    insertCorrection(temp, {
      videoId: video.id,
      segmentId: target.id,
      beforeText: target.text,
      afterText: 'Korrigiert.',
      beforeStartMs: target.startMs,
      afterStartMs: target.startMs,
      beforeEndMs: target.endMs,
      afterEndMs: target.endMs,
    });
    const queued = enqueueJob(temp, 'PARSE_TRANSCRIPT', {
      entityType: 'video',
      entityId: video.id,
    });

    const counts = deleteTranscript(temp, video.id);

    expect(counts).toEqual({
      deletedSegments: 3,
      deletedCorrections: 1,
      deletedFiles: 1,
      cancelledJobs: 1,
    });
    // Without the cancellation, a queued job would resurrect the segments seconds after
    // the user deleted them.
    expect(getJob(temp, queued.id)?.status).toBe('cancelled');
    expect(listSegmentsWithCorrections(temp, video.id).segments).toHaveLength(0);
  });

  it('does not cancel a job for a different video', () => {
    const { profile, video } = setup();
    const other = createVideo(temp, {
      profileId: profile.id,
      sourceType: 'local_media',
      externalVideoId: 'abcdefghijk',
      url: 'german/folge-1.mp4',
      title: 'Folge 2',
      targetLanguage: 'de',
    });
    const otherJob = enqueueJob(temp, 'PARSE_TRANSCRIPT', {
      entityType: 'video',
      entityId: other.id,
    });
    deleteTranscript(temp, video.id);
    expect(getJob(temp, otherJob.id)?.status).toBe('pending');
  });
});
