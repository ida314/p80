import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * Browsing the media library, and removing what P80 put in it (ADR 0024 §§5, 8).
 *
 * Two halves with opposite risk profiles. Browsing is read-only and its job is to be
 * *honest* — show what is there, mark what P80 already knows about, and never present a
 * file outside the root as though it were inside it. Deleting is the first code path in
 * P80 that destroys a user's media, and its job is to be *narrow*.
 */

let api: TestApi;
afterEach(async () => {
  await api?.dispose();
});

function browse(path = '') {
  return api.server.app.inject({ url: `/api/library?path=${encodeURIComponent(path)}` });
}

async function uploadFile(filename: string, contents = 'bytes'): Promise<string> {
  const created = await api.server.app.inject({
    method: 'POST',
    url: '/api/uploads',
    payload: { filename, sizeBytes: contents.length },
  });
  const { id } = created.json();
  await api.server.app.inject({
    method: 'PUT',
    url: `/api/uploads/${id}/chunk?offset=0`,
    headers: { 'content-type': 'application/octet-stream' },
    payload: Buffer.from(contents),
  });
  const done = await api.server.app.inject({
    method: 'POST',
    url: `/api/uploads/${id}/complete`,
  });
  return done.json().video.id;
}

describe('the listing tells the truth about the library', () => {
  it('lists one directory level, folders first', async () => {
    api = await createTestApi();
    api.writeMedia('german/lektion-3.mp4');
    api.writeMedia('zebra.mp4');
    api.writeMedia('alpha.mp4');

    const res = await browse();
    expect(res.statusCode).toBe(200);
    const { entries, path, parent } = res.json();
    expect(path).toBe('');
    expect(parent).toBeNull();
    expect(entries.map((e: { name: string }) => e.name)).toEqual([
      'german',
      'alpha.mp4',
      'zebra.mp4',
    ]);
    // Not recursive — the nested file is behind its directory, not flattened into the root.
    expect(entries.map((e: { name: string }) => e.name)).not.toContain('lektion-3.mp4');
  });

  it('walks into a subdirectory and back out', async () => {
    api = await createTestApi();
    api.writeMedia('german/lektionen/drei.mp4');

    const res = await browse('german/lektionen');
    expect(res.json().parent).toBe('german');
    expect(res.json().entries[0]).toMatchObject({
      name: 'drei.mp4',
      path: 'german/lektionen/drei.mp4',
      supported: true,
      canAdd: true,
    });
  });

  it('marks a file that is already a video, and stops offering to add it', async () => {
    api = await createTestApi();
    const media = api.writeMedia('lektion-3.mp4');
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: media, title: 'Lektion 3' },
    });

    const entry = browse().then((r) =>
      r.json().entries.find((e: { name: string }) => e.name === 'lektion-3.mp4'),
    );
    expect(await entry).toMatchObject({
      canAdd: false,
      video: { id: created.json().video.id, title: 'Lektion 3', mediaMissing: false },
    });
  });

  it('shows an unplayable file rather than hiding it', async () => {
    api = await createTestApi();
    api.writeMedia('lektion-3.mp4');
    writeFileSync(join(api.config.P80_MEDIA_ROOT, 'old-recording.avi'), 'bytes');

    const entries = (await browse()).json().entries as Array<Record<string, unknown>>;
    const avi = entries.find((e) => e.name === 'old-recording.avi');
    // Hiding it produces "where did my file go". Showing it greyed out explains itself.
    expect(avi).toMatchObject({ supported: false, canAdd: false });
  });

  it('hides dotfiles, which is what keeps a half-received upload out of sight', async () => {
    api = await createTestApi();
    await api.server.app.inject({
      method: 'POST',
      url: '/api/uploads',
      payload: { filename: 'in-flight.mp4', sizeBytes: 10 },
    });

    const uploads = (await browse('uploads')).json().entries as Array<{ name: string }>;
    expect(uploads.map((e) => e.name)).not.toContain('.p80-partial');
  });

  it('reports a symlink as a symlink and does not follow it', async () => {
    api = await createTestApi();
    const outside = join(api.config.P80_STORAGE_PATH, '..', 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.mp4'), 'not yours');
    symlinkSync(join(outside, 'secret.mp4'), join(api.config.P80_MEDIA_ROOT, 'innocent.mp4'));

    const entries = (await browse()).json().entries as Array<Record<string, unknown>>;
    const link = entries.find((e) => e.name === 'innocent.mp4');
    // Following it would present a file outside the root as an ordinary library entry —
    // the same hole `realPathEscapesRoot` closes on the read side.
    expect(link).toMatchObject({ kind: 'symlink', canAdd: false, deletable: false });
  });

  it('refuses to list outside the root', async () => {
    api = await createTestApi();
    for (const attempt of ['../', '../../etc', 'german/../../outside']) {
      const res = await browse(attempt);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_MEDIA_PATH');
    }
  });

  it('says so when a folder does not exist, rather than showing an empty one', async () => {
    api = await createTestApi();
    const res = await browse('nowhere');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEDIA_FILE_NOT_FOUND');
  });

  it('pages, and admits when it has cut the listing short', async () => {
    api = await createTestApi();
    for (let i = 0; i < 5; i += 1) api.writeMedia(`clip-${i}.mp4`);

    const first = await api.server.app.inject({ url: '/api/library?limit=2' });
    expect(first.json().entries).toHaveLength(2);
    expect(first.json().truncated).toBe(true);

    const next = await api.server.app.inject({
      url: `/api/library?limit=2&cursor=${first.json().nextCursor}`,
    });
    expect(next.json().entries.map((e: { name: string }) => e.name)).toEqual([
      'clip-2.mp4',
      'clip-3.mp4',
    ]);
  });
});

describe('P80 deletes what P80 wrote, and nothing else', () => {
  it('removes an uploaded file nothing references', async () => {
    api = await createTestApi();
    await uploadFile('spare.mp4');
    // Detach it so the in-use guard is not what is being tested here.
    const videos = await api.server.app.inject({ url: '/api/videos' });
    await api.server.app.inject({
      method: 'DELETE',
      url: `/api/videos/${videos.json().videos[0].id}`,
    });

    const res = await api.server.app.inject({
      method: 'DELETE',
      url: '/api/library/file?path=uploads%2Fspare.mp4',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deleted: true, markedMissing: 0 });
    expect(existsSync(join(api.config.P80_MEDIA_ROOT, 'uploads', 'spare.mp4'))).toBe(false);
  });

  it('refuses a file the user put there themselves', async () => {
    api = await createTestApi();
    api.writeMedia('german/lektion-3.mp4');

    const res = await api.server.app.inject({
      method: 'DELETE',
      url: '/api/library/file?path=german%2Flektion-3.mp4',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MEDIA_DELETE_REFUSED');
    // And it is still there.
    expect(existsSync(join(api.config.P80_MEDIA_ROOT, 'german', 'lektion-3.mp4'))).toBe(true);
  });

  it('refuses to escape the root, using the same check as adding a video', async () => {
    api = await createTestApi();
    const res = await api.server.app.inject({
      method: 'DELETE',
      url: '/api/library/file?path=..%2F..%2Fetc%2Fpasswd.mp4',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_MEDIA_PATH');
  });

  it('refuses a directory outright', async () => {
    api = await createTestApi();
    mkdirSync(join(api.config.P80_MEDIA_ROOT, 'uploads', 'nested'), { recursive: true });
    const res = await api.server.app.inject({
      method: 'DELETE',
      url: '/api/library/file?path=uploads%2Fnested',
    });
    // `resolveMediaPath` wants a media extension, so this never reaches the unlink.
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(api.config.P80_MEDIA_ROOT, 'uploads', 'nested'))).toBe(true);
  });

  /**
   * The two-step refusal, and what happens after it — this is the case that matters most,
   * because it is where a delete could plausibly have cascaded.
   */
  it('refuses first when a video uses the file, naming the video', async () => {
    api = await createTestApi();
    const videoId = await uploadFile('lektion-3.mp4');

    const refused = await api.server.app.inject({
      method: 'DELETE',
      url: '/api/library/file?path=uploads%2Flektion-3.mp4',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('MEDIA_FILE_IN_USE');
    // An untitled video falls back to its filename. The message is the whole basis on
    // which the user decides whether to proceed, and "a video" with a blank name is not
    // something anyone can act on.
    expect(refused.json().error.details.videos).toEqual([
      { id: videoId, title: 'lektion-3.mp4' },
    ]);
    expect(existsSync(join(api.config.P80_MEDIA_ROOT, 'uploads', 'lektion-3.mp4'))).toBe(true);
  });

  it('proceeds when acknowledged, and leaves a repairable video rather than a cascade', async () => {
    api = await createTestApi();
    const videoId = await uploadFile('lektion-3.mp4');

    const res = await api.server.app.inject({
      method: 'DELETE',
      url: '/api/library/file?path=uploads%2Flektion-3.mp4&acknowledgeVideos=true',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ markedMissing: 1 });

    // The video survives. This is ADR 0018 §3's repairable dangling link: everything built
    // on the transcript is intact and only playback is gone.
    const video = await api.server.app.inject({ url: `/api/videos/${videoId}` });
    expect(video.statusCode).toBe(200);
    expect(video.json().media.missing).toBe(true);
    // The stale path is deliberately kept, so the UI can say *which* file is missing.
    expect(video.json().mediaPath ?? video.json().url).toContain('lektion-3.mp4');

    // And the media route reports it honestly rather than serving something stale.
    const media = await api.server.app.inject({ url: `/api/videos/${videoId}/media` });
    expect(media.statusCode).toBe(404);
  });
});
