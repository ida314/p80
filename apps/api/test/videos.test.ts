import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * Stage 2 exit criteria 1 and 6, and steps 1-3 and 16.
 *
 * Rewritten for ADR 0015. Adding a video is now pointing P80 at a file rather than pasting
 * a URL, and it returns `202` with a job rather than `201` with a finished row: identity,
 * duration, and transcription all happen in `INGEST_MEDIA`, because reading a
 * multi-gigabyte file does not belong on a request.
 */

let api: TestApi;
afterEach(async () => api?.dispose());

const PATH = 'german/folge-1.mp4';

async function addVideo(body: Record<string, unknown> = {}, path = PATH) {
  api.writeMedia(path);
  return api.server.app.inject({
    method: 'POST',
    url: '/api/videos',
    payload: { path, title: 'Folge 1', ...body },
  });
}

describe('POST /api/videos', () => {
  it('stores the video and returns everything a client needs to render it', async () => {
    api = await createTestApi();
    const res = await addVideo();

    expect(res.statusCode).toBe(202);
    const { video, jobId, status } = res.json();

    expect(video).toMatchObject({
      title: 'Folge 1',
      // From the profile, not from the request — ADR 0001 ships one pair.
      targetLanguage: 'de',
      sourceType: 'local_media',
      transcriptStatus: 'none',
      processingStatus: 'none',
      segmentCount: 0,
      mediaMissing: false,
      // ADR 0007: the client renders this rather than building a player from a path.
      media: { kind: 'local_media', mediaUrl: `/api/videos/${video.id}/media`, missing: false },
    });

    // §1: work that starts a pipeline returns a job reference, not a result.
    expect(jobId).toBeTruthy();
    expect(status).toBe('pending');
  });

  it('leaves identity pending until the job has read the file', async () => {
    api = await createTestApi();
    const res = await addVideo();

    // ADR 0018: identity is the content hash, and hashing is the worker's job. A
    // placeholder that is unique per row rather than shared, so several videos can await
    // ingest at once without colliding on the UNIQUE constraint.
    expect(res.json().video.externalVideoId).toBe(`pending:${res.json().video.id}`);
  });

  it('stores the normalised relative path, not the string as typed', async () => {
    api = await createTestApi();
    api.writeMedia('german/folge-1.mp4');
    const res = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: 'german//./folge-1.mp4' },
    });

    // Two spellings of one file must not become two videos. The content hash would catch
    // it eventually, but only after paying for a full ingest.
    expect(res.json().video.url).toBe('german/folge-1.mp4');
  });

  it('rejects a path that escapes the media root, with a reason the user can act on', async () => {
    api = await createTestApi();
    const res = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: '../../etc/passwd.mp4' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatchObject({
      code: 'INVALID_MEDIA_PATH',
      details: { reason: 'escapes_root' },
    });
  });

  it('distinguishes the ways a path can be unusable', async () => {
    api = await createTestApi();
    const reason = async (path: string) => {
      const res = await api.server.app.inject({
        method: 'POST',
        url: '/api/videos',
        payload: { path },
      });
      return res.json().error.details?.reason;
    };

    // Each is a different mistake and deserves a different message. Collapsing them into
    // "bad path" makes the rejection log useless and the UI unhelpful.
    expect(await reason('/media/library/x.mp4')).toBe('absolute');
    expect(await reason('notes.txt')).toBe('unsupported_extension');
    expect(await reason('../x.mp4')).toBe('escapes_root');
  });

  it('404s a path inside the root with no file behind it', async () => {
    api = await createTestApi();
    const res = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: 'german/never-recorded.mp4' },
    });

    // Existence is worth one stat: a typo should be caught now, not four minutes into a
    // job. Reading the file is still the job's business.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEDIA_FILE_NOT_FOUND');
  });

  it('refuses the same path twice and names the video already there', async () => {
    api = await createTestApi();
    const first = await addVideo();
    const second = await addVideo({ title: 'Same file, different title' });

    // Before ingest runs, both rows would carry the same path. The unique constraint
    // catches this on the `pending:` identity only when it is genuinely the same row, so
    // the API checks the path — a second video for a file already added is a mistake, and
    // the content-hash duplicate check in the worker is for the *renamed* case.
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      code: 'DUPLICATE_VIDEO',
      details: { videoId: first.json().video.id },
    });
  });
});

describe('GET /api/videos', () => {
  it('lists, filters and pages', async () => {
    api = await createTestApi();
    await addVideo();
    await addVideo({ title: 'Folge 2' }, 'german/folge-2.mp4');

    const all = await api.server.app.inject({ url: '/api/videos' });
    expect(all.json().videos).toHaveLength(2);
    expect(all.json().nextCursor).toBeNull();

    const searched = await api.server.app.inject({ url: '/api/videos?q=Folge%202' });
    expect(searched.json().videos).toHaveLength(1);

    const filtered = await api.server.app.inject({
      url: '/api/videos?transcriptStatus=ready',
    });
    expect(filtered.json().videos).toHaveLength(0);

    const paged = await api.server.app.inject({ url: '/api/videos?limit=1' });
    expect(paged.json().videos).toHaveLength(1);
    expect(paged.json().nextCursor).not.toBeNull();
  });

  it('404s an unknown video rather than returning an empty success', async () => {
    api = await createTestApi();
    const res = await api.server.app.inject({ url: '/api/videos/does-not-exist' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('PUT and DELETE /api/videos/:id', () => {
  it('updates the editable fields', async () => {
    api = await createTestApi();
    const created = await addVideo();
    const res = await api.server.app.inject({
      method: 'PUT',
      url: `/api/videos/${created.json().video.id}`,
      payload: { title: 'Neuer Titel', speakerLabel: 'Anna', durationMs: 600_000 },
    });
    expect(res.json()).toMatchObject({
      title: 'Neuer Titel',
      speakerLabel: 'Anna',
      durationMs: 600_000,
    });
  });

  it('ignores an attempt to change the video identity or its media path', async () => {
    api = await createTestApi();
    const created = await addVideo();
    const before = created.json().video;

    const res = await api.server.app.inject({
      method: 'PUT',
      url: `/api/videos/${before.id}`,
      payload: {
        title: 'Neu',
        url: 'elsewhere/other.mp4',
        externalVideoId: 'x',
        mediaPath: '../escape.mp4',
      },
    });

    // Not in the body schema, so they are stripped rather than applied. Changing identity
    // would orphan the transcript and every occurrence built on it; changing the path
    // outside the repair route would skip the hash verification that keeps a transcript
    // bound to the audio it describes (ADR 0018 §3).
    expect(res.json().externalVideoId).toBe(before.externalVideoId);
    expect(res.json().url).toBe(before.url);
  });

  it('reports what a delete removed', async () => {
    api = await createTestApi();
    const created = await addVideo();
    const id = created.json().video.id;

    const res = await api.server.app.inject({ method: 'DELETE', url: `/api/videos/${id}` });
    expect(res.json()).toMatchObject({ deleted: true, deletedSegments: 0 });
    expect((await api.server.app.inject({ url: `/api/videos/${id}` })).statusCode).toBe(404);
  });

  it('does not delete the media file it was pointed at', async () => {
    api = await createTestApi();
    const created = await addVideo();
    await api.server.app.inject({
      method: 'DELETE',
      url: `/api/videos/${created.json().video.id}`,
    });

    // P80 was shown this file; it does not own it. Deleting a video removes P80's record,
    // not the user's library.
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(existsSync(join(api.config.P80_MEDIA_ROOT, PATH))).toBe(true);
  });
});

describe('endpoints that arrive in later stages', () => {
  it('answers 501 naming the stage, not 404', async () => {
    // A 404 from an unregistered route and a 404 for "no such video" read identically to a
    // client, which turns "this arrives in Stage 4" into "your video is missing".
    api = await createTestApi();
    const created = await addVideo();
    const res = await api.server.app.inject({
      method: 'POST',
      url: `/api/videos/${created.json().video.id}/process`,
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toMatchObject({ code: 'NOT_IMPLEMENTED' });
    expect(res.json().error.message).toMatch(/Stage 4/);
  });
});

describe('interests', () => {
  it('creates interests and binds them to a video with a relevance', async () => {
    api = await createTestApi();
    const interest = await api.server.app.inject({
      method: 'POST',
      url: '/api/interests',
      payload: { name: 'Kochen', weight: 4 },
    });
    expect(interest.statusCode).toBe(201);

    const created = await addVideo({
      interests: [{ interestId: interest.json().id, relevance: 0.8 }],
    });
    expect(created.json().video.interests).toEqual([
      { interestId: interest.json().id, name: 'Kochen', relevance: 0.8 },
    ]);
  });
});

describe('exit criterion 6 — refreshing preserves the source', () => {
  it('survives a full server restart against the same database file', async () => {
    // The honest server-side reading: close everything, build a new server over the same
    // file, and find the video unchanged. The browser half is manual check M4.
    api = await createTestApi();
    const created = await addVideo();
    const { id, externalVideoId } = created.json().video;

    await api.server.close();
    const reopened = await buildServer(api.config);
    try {
      const res = await reopened.app.inject({ url: `/api/videos/${id}` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        id,
        externalVideoId,
        title: 'Folge 1',
        url: PATH,
      });
    } finally {
      await reopened.close();
    }
  });
});
