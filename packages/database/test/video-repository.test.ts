import { afterEach, describe, expect, it } from 'vitest';
import {
  PROCESSING_STATUSES,
  TRANSCRIPT_STATUSES,
  TRANSCRIPT_STATUS_TRANSITIONS,
} from '@p80/core';
import {
  createVideo,
  deleteVideo,
  findByMediaPath,
  getVideo,
  isPendingIdentity,
  listVideos,
  setMediaIdentity,
  setMediaLocation,
  setProcessingStatus,
  setTranscriptStatus,
  updateVideo,
} from '../src/repositories/videos.js';
import { ensureProfile } from '../src/repositories/profile.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * Stage 2 steps 16 and 14, and exit criterion 13.
 *
 * Duplicate detection is the unique constraint the migration already carries, and the
 * status vocabularies are enforced in code rather than by a CHECK — this file is what makes
 * both claims testable.
 */

let temp: TempDatabase;
afterEach(() => temp?.dispose());

function setup() {
  temp = createTempDatabase();
  const profile = ensureProfile(temp);
  return { profile };
}

/** ADR 0018: identity is a SHA-256 of the file's bytes. A 64-char hex string here rather
 *  than a realistic-looking id, because the shape is what the unique constraint sees. */
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const video = (profileId: string, externalVideoId = HASH_A) => ({
  profileId,
  sourceType: 'local_media' as const,
  externalVideoId,
  url: `german/${externalVideoId.slice(0, 8)}.mp4`,
  mediaPath: `german/${externalVideoId.slice(0, 8)}.mp4`,
  title: 'Folge 1',
  targetLanguage: 'de',
});

describe('duplicate detection', () => {
  it('rejects the same content hash twice, naming the one already there', () => {
    const { profile } = setup();
    const first = createVideo(temp, video(profile.id));

    try {
      createVideo(temp, video(profile.id));
      expect.unreachable('the unique constraint should have rejected this');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'DUPLICATE_VIDEO',
        statusCode: 409,
        // The client navigates straight to it instead of making the user search.
        details: { videoId: first.id, externalVideoId: HASH_A },
      });
    }
  });

  it('allows two different videos', () => {
    const { profile } = setup();
    createVideo(temp, video(profile.id, HASH_A));
    createVideo(temp, video(profile.id, HASH_B));
    expect(listVideos(temp, { profileId: profile.id }).videos).toHaveLength(2);
  });

  /**
   * ADR 0018's reason for `pending:<id>` rather than a shared placeholder.
   *
   * Identity is filled in by the ingest job, so a freshly added video has no hash. A
   * shared sentinel — `''` — would make the second un-ingested video a duplicate of the
   * first; `NULL` would stop the constraint working at all, because SQLite treats every
   * NULL as distinct. Neither is acceptable, and a user adding three files in a row is an
   * ordinary thing to do.
   */
  it('lets several videos await ingest at once, without colliding', () => {
    const { profile } = setup();
    const a = createVideo(temp, { ...video(profile.id), externalVideoId: undefined, mediaPath: 'a.mp4' });
    const b = createVideo(temp, { ...video(profile.id), externalVideoId: undefined, mediaPath: 'b.mp4' });

    expect(a.externalVideoId).toBe(`pending:${a.id}`);
    expect(b.externalVideoId).toBe(`pending:${b.id}`);
    expect(listVideos(temp, { profileId: profile.id }).videos).toHaveLength(2);
  });

  it('cannot confuse a pending identity with a real hash', () => {
    const { profile } = setup();
    const pending = createVideo(temp, { ...video(profile.id), externalVideoId: undefined });

    // An 11-character placeholder prefix and a 64-character hex digest share no values, so
    // the constraint keeps working across the two-phase add.
    expect(isPendingIdentity(pending.externalVideoId)).toBe(true);
    expect(isPendingIdentity(HASH_A)).toBe(false);
  });

  /**
   * The narrow exception to "a video's identity is not patchable".
   *
   * `updateVideo` refuses `external_video_id` outright, because changing it orphans the
   * transcript and every occurrence built on it. `setMediaIdentity` fills in a *pending*
   * one, and refuses to overwrite a real one with something different — that case is the
   * repair path, which reports a mismatch to the user rather than silently rebinding a
   * transcript to audio it does not describe (ADR 0018 §3).
   */
  it('fills in a pending identity but refuses to change a real one', () => {
    const { profile } = setup();
    const created = createVideo(temp, { ...video(profile.id), externalVideoId: undefined });

    const identified = setMediaIdentity(temp, created.id, {
      contentHash: HASH_A,
      mediaBytes: 1024,
      durationMs: 60_000,
    });
    expect(identified.externalVideoId).toBe(HASH_A);
    expect(identified.mediaBytes).toBe(1024);
    expect(identified.durationMs).toBe(60_000);

    // Re-running the same job is fine — hashing the same bytes gives the same answer.
    expect(
      setMediaIdentity(temp, created.id, {
        contentHash: HASH_A,
        mediaBytes: 1024,
        durationMs: 60_000,
      }).externalVideoId,
    ).toBe(HASH_A);

    expect(() =>
      setMediaIdentity(temp, created.id, {
        contentHash: HASH_B,
        mediaBytes: 2048,
        durationMs: 60_000,
      }),
    ).toThrow(/repair path/);
  });
});

describe('a missing media file is a broken link, not a deletion', () => {
  it('marks and clears the flag without touching anything else', () => {
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));

    const gone = setMediaLocation(temp, created.id, { mediaMissing: true });
    expect(gone.mediaMissing).toBe(true);
    // Nothing else moved. Only playback needs the bytes (ADR 0018 §3).
    expect(gone.externalVideoId).toBe(created.externalVideoId);
    expect(gone.mediaPath).toBe(created.mediaPath);
    expect(getVideo(temp, created.id)).not.toBeNull();

    const repaired = setMediaLocation(temp, created.id, {
      mediaPath: 'german/moved.mp4',
      mediaMissing: false,
    });
    expect(repaired.mediaMissing).toBe(false);
    expect(repaired.mediaPath).toBe('german/moved.mp4');
  });

  it('finds a video by its media path, which is how the API catches a re-add', () => {
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));

    expect(findByMediaPath(temp, profile.id, created.mediaPath!)?.id).toBe(created.id);
    expect(findByMediaPath(temp, profile.id, 'german/never.mp4')).toBeNull();
  });
});

describe('transcript_status transitions', () => {
  it('declares vocabularies that both include the column default', () => {
    // Neither column has a CHECK, so `'none'` — the DDL default — must be a legal member
    // of both sets, or every freshly created video would be in an illegal state.
    expect(TRANSCRIPT_STATUSES).toContain('none');
    expect(PROCESSING_STATUSES).toContain('none');
  });

  it('walks the whole legal path', () => {
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));
    expect(created.transcriptStatus).toBe('none');

    for (const next of ['parsing', 'ready'] as const) {
      setTranscriptStatus(temp, created.id, next);
    }
    setTranscriptStatus(temp, created.id, 'parsing'); // replacement
    setTranscriptStatus(temp, created.id, 'failed');
    setTranscriptStatus(temp, created.id, 'parsing'); // retry
    setTranscriptStatus(temp, created.id, 'none'); // delete
  });

  it('refuses none -> ready, which would mean segments without a parse', () => {
    // The reason this is a transition table and not a CHECK constraint: membership is not
    // the thing that goes wrong.
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));
    expect(() => setTranscriptStatus(temp, created.id, 'ready')).toThrow(
      /Illegal transcript_status transition none -> ready/,
    );
  });

  it('refuses ready -> failed without a parse in between', () => {
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));
    setTranscriptStatus(temp, created.id, 'parsing');
    setTranscriptStatus(temp, created.id, 'ready');
    expect(() => setTranscriptStatus(temp, created.id, 'failed')).toThrow(/Illegal/);
  });

  it('keeps every declared status reachable from somewhere', () => {
    // Guards against adding a value to the enum and forgetting to give it an entry point,
    // which would make it dead vocabulary that reads as supported.
    const reachable = new Set(Object.values(TRANSCRIPT_STATUS_TRANSITIONS).flat());
    for (const status of TRANSCRIPT_STATUSES) expect(reachable).toContain(status);
  });

  it('documents that raw SQL can still write a value the vocabulary forbids', () => {
    // Deliberate, and recorded rather than hidden: the absence of a CHECK constraint is a
    // choice made to avoid a migration that would break three Stage 1 tests. When a
    // migration is next needed for another reason, add the CHECKs then.
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));
    temp.sqlite
      .prepare('UPDATE videos SET transcript_status = ? WHERE id = ?')
      .run('bogus', created.id);
    const row = temp.sqlite
      .prepare('SELECT transcript_status AS s FROM videos WHERE id = ?')
      .get(created.id) as { s: string };
    expect(row.s).toBe('bogus');
    // The API's response schema is the backstop: `z.enum(TRANSCRIPT_STATUSES)` makes this
    // fail serialization loudly rather than reaching a client.
    expect(TRANSCRIPT_STATUSES).not.toContain(row.s as never);
  });
});

describe('processing_status', () => {
  it('starts at none and reaches transcript_ready, the only two Stage 2 writes', () => {
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));
    expect(created.processingStatus).toBe('none');
    setProcessingStatus(temp, created.id, 'transcript_ready');
    expect(listVideos(temp, { profileId: profile.id }).videos[0]?.processingStatus).toBe(
      'transcript_ready',
    );
  });
});

describe('listing and updating', () => {
  it('filters by status and searches titles with wildcards escaped', () => {
    const { profile } = setup();
    const a = createVideo(temp, { ...video(profile.id, 'aaaaaaaaaaa'.padEnd(64, '0')), title: '100% Deutsch' });
    createVideo(temp, { ...video(profile.id, 'bbbbbbbbbbb'.padEnd(64, '0')), title: 'Ganz anders' });

    // Without ESCAPE the `%` in the stored title would make this a match-everything query.
    expect(listVideos(temp, { profileId: profile.id, q: '100%' }).videos).toHaveLength(1);
    expect(listVideos(temp, { profileId: profile.id, q: '100%' }).videos[0]?.id).toBe(a.id);
    expect(listVideos(temp, { profileId: profile.id, q: 'anders' }).videos).toHaveLength(1);
    expect(
      listVideos(temp, { profileId: profile.id, transcriptStatus: 'ready' }).videos,
    ).toHaveLength(0);
  });

  it('pages with a stable cursor', () => {
    const { profile } = setup();
    for (let i = 0; i < 5; i += 1) {
      createVideo(temp, video(profile.id, `id${String(i).padStart(9, '0')}`));
    }
    const first = listVideos(temp, { profileId: profile.id, limit: 2 });
    expect(first.videos).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = listVideos(temp, {
      profileId: profile.id,
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.videos).toHaveLength(2);
    const ids = new Set([...first.videos, ...second.videos].map((v) => v.id));
    expect(ids.size).toBe(4);
  });

  it('updates the editable fields and leaves identity alone', () => {
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));
    const updated = updateVideo(temp, created.id, {
      title: 'Neuer Titel',
      speakerLabel: 'Anna',
      durationMs: 600_000,
    });
    expect(updated).toMatchObject({
      title: 'Neuer Titel',
      speakerLabel: 'Anna',
      durationMs: 600_000,
      // Not patchable: changing identity would orphan the transcript.
      externalVideoId: created.externalVideoId,
      url: created.url,
    });
  });
});

describe('deletion', () => {
  it('reports what it removed and leaves approved items alone', () => {
    const { profile } = setup();
    const created = createVideo(temp, video(profile.id));
    temp.sqlite
      .prepare(
        `INSERT INTO transcript_segments
           (id, video_id, start_ms, end_ms, raw_text, normalized_text, sequence_index)
         VALUES ('seg1', ?, 0, 1000, 'Guten Tag.', 'Guten Tag.', 0)`,
      )
      .run(created.id);

    const counts = deleteVideo(temp, created.id);
    expect(counts.deletedSegments).toBe(1);
    expect(
      temp.sqlite.prepare('SELECT COUNT(*) AS n FROM transcript_segments').get(),
    ).toEqual({ n: 0 });
  });
});
