import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalMediaSource } from '@p80/providers';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * Stage 2 exit criterion 5 — **P80 never acquires media, and never copies it** (ADR 0015).
 *
 * The dynamic half. `test/media-policy.test.ts` at the repository root proves nothing in
 * the tree *can* fetch media; this proves that running the real ingestion flow does not.
 * Both are needed: a static scan passes happily against code that builds a URL at runtime,
 * and a runtime check passes against a dependency nothing happened to call today.
 */

let api: TestApi;
afterEach(async () => api?.dispose());

describe('ingestion makes no outbound request', () => {
  it('adds a video and accepts a transcript with the network stubbed to throw', async () => {
    // Not "we found no forbidden import" but "the code that ran could not have reached the
    // network if it tried". `CLAUDE.md` rule 15 says P80 makes no outbound request at
    // runtime — since ADR 0015 removed the embedded player, that list is empty rather than
    // short, and this is the claim as a test.
    api = await createTestApi();
    const path = api.writeMedia('folge-1.mp4');

    const realFetch = globalThis.fetch;
    const attempts: string[] = [];
    globalThis.fetch = ((input: unknown) => {
      attempts.push(String(input));
      throw new Error('P80 must not make an outbound request during ingestion');
    }) as typeof fetch;

    try {
      const created = await api.server.app.inject({
        method: 'POST',
        url: '/api/videos',
        payload: { path, title: 'Folge 1' },
      });
      expect(created.statusCode).toBe(202);

      const uploaded = await api.server.app.inject({
        method: 'POST',
        url: `/api/videos/${created.json().video.id}/transcript`,
        payload: {
          content: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nGuten Tag.\n',
          filename: 'folge-1.vtt',
        },
      });
      expect(uploaded.statusCode).toBe(202);

      // A path outside the root is refused, and refused without touching the filesystem
      // beyond the containment arithmetic.
      const escaping = await api.server.app.inject({
        method: 'POST',
        url: '/api/videos',
        payload: { path: '../../etc/passwd.mp4' },
      });
      expect(escaping.statusCode).toBe(400);
      expect(escaping.json().error.code).toBe('INVALID_MEDIA_PATH');
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(attempts).toEqual([]);
  });

  it('refuses a path inside the root that has no file, without inventing one', async () => {
    api = await createTestApi();
    const res = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: 'german/never-existed.mp4' },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEDIA_FILE_NOT_FOUND');
  });

  it('never discloses the media root to a client that supplied a relative path', async () => {
    api = await createTestApi();
    const res = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: 'german/never-existed.mp4' },
    });

    // The caller sent a relative path and has no business learning where the root lives.
    const body = res.body;
    expect(body).not.toContain(api.config.P80_MEDIA_ROOT);
    expect(body).toContain('german/never-existed.mp4');
  });
});

describe('the media route serves bytes and copies nothing', () => {
  it('serves a descriptor that is a route, never a filesystem path', async () => {
    api = await createTestApi();
    const path = api.writeMedia('german/lektion-3.mp4');
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path },
    });
    const video = created.json().video;

    expect(video.media.kind).toBe('local_media');
    expect(video.media.mediaUrl).toBe(`/api/videos/${video.id}/media`);
    // The client must not learn where media lives — that is the media route's business
    // and nobody else's.
    expect(JSON.stringify(video)).not.toContain(api.config.P80_MEDIA_ROOT);
  });

  it('returns the bytes it was given, and writes no copy into storage', async () => {
    api = await createTestApi();
    const contents = 'the exact bytes on disk';
    const path = api.writeMedia('clip.mp4', contents);
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path },
    });

    const res = await api.server.app.inject({
      url: `/api/videos/${created.json().video.id}/media`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(contents);
    expect(res.headers['accept-ranges']).toBe('bytes');

    // Rule 3. The storage root holds transcripts and derived artifacts; a media file
    // appearing under it is the read-through reference having quietly become a copy.
    expect(mediaFilesUnder(api.config.P80_STORAGE_PATH)).toEqual([]);
  });

  it('honours a byte range, because a <video> element cannot seek without one', async () => {
    api = await createTestApi();
    const path = api.writeMedia('clip.mp4', '0123456789');
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path },
    });

    const res = await api.server.app.inject({
      url: `/api/videos/${created.json().video.id}/media`,
      headers: { range: 'bytes=2-5' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('2345');
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
  });

  it('reads the last bytes for a suffix range', async () => {
    api = await createTestApi();
    const path = api.writeMedia('clip.mp4', '0123456789');
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path },
    });

    // `bytes=-3` is the *last* three bytes, not the first three. Getting this backwards
    // produces a player that works until someone seeks to the end.
    const res = await api.server.app.inject({
      url: `/api/videos/${created.json().video.id}/media`,
      headers: { range: 'bytes=-3' },
    });

    expect(res.statusCode).toBe(206);
    expect(res.body).toBe('789');
  });

  it('416s a range past the end rather than clamping it', async () => {
    api = await createTestApi();
    const path = api.writeMedia('clip.mp4', '0123456789');
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path },
    });

    const res = await api.server.app.inject({
      url: `/api/videos/${created.json().video.id}/media`,
      headers: { range: 'bytes=50-60' },
    });

    // Clamping would make a seek past the end look like a seek to the end.
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */10');
  });

  it('404s and marks the video for repair when the file has gone', async () => {
    api = await createTestApi();
    const path = api.writeMedia('gone.mp4');
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path },
    });
    const videoId = created.json().video.id;

    rmSync(join(api.config.P80_MEDIA_ROOT, path));

    const res = await api.server.app.inject({ url: `/api/videos/${videoId}/media` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEDIA_FILE_NOT_FOUND');

    // Nothing cascades. The video is still there, still listable, still holds whatever was
    // built from it — it is a broken link, not a deletion (ADR 0018 §3).
    const video = await api.server.app.inject({ url: `/api/videos/${videoId}` });
    expect(video.statusCode).toBe(200);
    expect(video.json().mediaMissing).toBe(true);
    expect(video.json().media.missing).toBe(true);
  });
});

describe('adapter capabilities', () => {
  it('supports local media and local transcription, and says so', () => {
    // Both flipped with ADR 0015/0016, and both are assertions rather than just fields
    // because changing either is a policy decision needing a review in `docs/decisions/`.
    const adapter = createLocalMediaSource('/media/library');
    expect(adapter.kind).toBe('local_media');
    expect(adapter.supportsLocalMedia).toBe(true);
    expect(adapter.supportsAutomaticTranscriptAccess).toBe(true);
  });

  it('validates a path without opening it', async () => {
    const adapter = createLocalMediaSource('/media/library');
    // `/media/library` does not exist in the test environment, which is the point: a
    // validator that touched the disk would fail here.
    const result = await adapter.validate({ path: 'german/lektion-3.mp4' });
    expect(result.valid).toBe(true);
    expect(result.relativePath).toBe('german/lektion-3.mp4');
    // Identity is the ingest job's business (ADR 0018) — validate has read no bytes.
    expect(result.externalVideoId).toBeNull();
  });
});

/** Any file under `dir` with a media or audio extension, recursively. */
function mediaFilesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string) => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return; // the storage root may not exist yet, which is itself a pass
    }
    for (const entry of entries) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(mp4|m4v|mkv|webm|mov|wav|mp3|m4a|flac|opus|aac|ogg)$/i.test(entry)) {
        found.push(full);
      }
    }
  };
  walk(dir);
  return found;
}
