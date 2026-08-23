import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * Stage 2b exit criteria 2–7 (ADR 0019).
 *
 * Four properties this file exists to hold:
 *
 * - A boot-tier key is **refused**, not accepted and ignored.
 * - The media-root refusal list holds, with a distinguishable reason for each case.
 * - A root change that would orphan videos states its cost and needs a second act.
 * - The change is **live**: the very next request resolves against the new root, with no
 *   restart and no cached value anywhere in the API.
 */
describe('GET /api/settings', () => {
  let api: TestApi | null = null;
  afterEach(async () => {
    await api?.dispose();
    api = null;
  });

  it('returns both tiers, with the source of each value', async () => {
    api = await createTestApi();
    const response = await api.server.app.inject({ url: '/api/settings' });
    expect(response.statusCode).toBe(200);

    const { settings } = response.json<{ settings: Array<Record<string, unknown>> }>();
    const byKey = Object.fromEntries(settings.map((s) => [s.key as string, s]));

    expect(byKey.P80_MEDIA_ROOT).toMatchObject({
      tier: 'live',
      editable: true,
      source: 'environment',
      value: api.config.P80_MEDIA_ROOT,
    });
    // Included rather than hidden: a settings page that omits the port it is served on is
    // one the user will not trust.
    expect(byKey.P80_API_PORT).toMatchObject({ tier: 'boot', editable: false });
  });

  it('exposes nothing credential-shaped', async () => {
    // §32.3 and `03-api.md` §10: no endpoint returns an API key and none accepts one.
    // Under ADR 0005 there are none to return; this keeps that true as the surface grows.
    api = await createTestApi();
    const response = await api.server.app.inject({ url: '/api/settings' });
    const keys = response
      .json<{ settings: Array<{ key: string }> }>()
      .settings.map((s) => s.key);
    expect(keys.filter((k) => /_KEY$|_SECRET$|_TOKEN$|_PASSWORD$/.test(k))).toEqual([]);
  });
});

describe('PUT /api/settings', () => {
  let api: TestApi | null = null;
  afterEach(async () => {
    await api?.dispose();
    api = null;
  });

  const put = (app: TestApi, body: Record<string, unknown>) =>
    app.server.app.inject({ method: 'PUT', url: '/api/settings', payload: body });

  it('writes an editable key and reports it as overridden', async () => {
    api = await createTestApi();
    const response = await put(api, { settings: { P80_ASR_REQUIRE_GPU: false } });
    expect(response.statusCode).toBe(200);

    const { settings } = response.json<{ settings: Array<Record<string, unknown>> }>();
    expect(settings.find((s) => s.key === 'P80_ASR_REQUIRE_GPU')).toMatchObject({
      value: false,
      source: 'database',
      environmentValue: true,
    });
  });

  it('refuses a boot-tier key rather than accepting one that would do nothing', async () => {
    api = await createTestApi();
    const response = await put(api, { settings: { P80_API_PORT: 9999 } });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'SETTING_NOT_EDITABLE',
      details: { reason: 'boot_tier' },
    });
    // The message has to say what *does* change it, or the user has been told no with
    // nowhere to go.
    expect(response.json().error.message).toMatch(/\.env\.local/);
  });

  it('refuses LAN exposure specifically', async () => {
    // ADR 0019 §2: this one is not merely a restart problem. Spec §32.5 makes exposure an
    // explicit act with a warning, and a browser-reachable toggle is a weaker guarantee.
    api = await createTestApi();
    const response = await put(api, { settings: { P80_ALLOW_LAN: true } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('SETTING_NOT_EDITABLE');
  });

  it('distinguishes an unknown key from a read-only one', async () => {
    api = await createTestApi();
    const response = await put(api, { settings: { P80_NOT_A_SETTING: 'x' } });
    expect(response.json().error.details).toMatchObject({ reason: 'unknown_key' });
  });

  it('rejects a value that fails the setting’s own schema', async () => {
    api = await createTestApi();
    const response = await put(api, { settings: { P80_ASR_LANG_MIN_PROB: 5 } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('writes nothing when any key in the batch is invalid', async () => {
    // Validated first, then written: a request either fails before touching anything or
    // applies everything it named.
    api = await createTestApi();
    await put(api, {
      settings: { P80_ASR_MODEL: 'medium', P80_API_PORT: 1 },
    });

    const after = await api.server.app.inject({ url: '/api/settings' });
    expect(
      after.json<{ settings: Array<Record<string, unknown>> }>().settings.find(
        (s) => s.key === 'P80_ASR_MODEL',
      ),
    ).toMatchObject({ source: 'environment' });
  });

  it.each([
    ['/', 'filesystem_root'],
    ['/etc', 'system_directory'],
    ['relative/path', 'not_absolute'],
    ['/definitely/not/here', 'not_found'],
  ])('refuses %s as a media root', async (path, reason) => {
    api = await createTestApi();
    const response = await put(api, { settings: { P80_MEDIA_ROOT: path } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: 'INVALID_MEDIA_ROOT',
      details: { reason },
    });
  });

  it('changes what the very next request resolves, with no restart', async () => {
    // The live-tier property, end to end. Nothing in the API may cache the root: the same
    // server instance must serve from the new library on the next call.
    api = await createTestApi();
    api.writeMedia('old.mp4');

    const second = mkdtempSync(join(tmpdir(), 'p80-library-'));
    try {
      writeFileSync(join(second, 'new.mp4'), 'bytes');

      const before = await api.server.app.inject({
        method: 'POST',
        url: '/api/videos',
        payload: { path: 'new.mp4' },
      });
      expect(before.statusCode).toBe(404);

      const changed = await put(api, {
        settings: { P80_MEDIA_ROOT: second },
        acknowledgeOrphans: true,
      });
      expect(changed.statusCode).toBe(200);

      const after = await api.server.app.inject({
        method: 'POST',
        url: '/api/videos',
        payload: { path: 'new.mp4' },
      });
      expect(after.statusCode).toBe(202);
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('stores the normalised root so one directory cannot become two', async () => {
    api = await createTestApi();
    const dir = mkdtempSync(join(tmpdir(), 'p80-library-'));
    try {
      const response = await put(api, { settings: { P80_MEDIA_ROOT: `${dir}/` } });
      const { settings } = response.json<{ settings: Array<Record<string, unknown>> }>();
      expect(settings.find((s) => s.key === 'P80_MEDIA_ROOT')?.value).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('changing the media root when videos exist', () => {
  let api: TestApi | null = null;
  let library: string | null = null;

  afterEach(async () => {
    await api?.dispose();
    api = null;
    if (library) rmSync(library, { recursive: true, force: true });
    library = null;
  });

  /** One video whose file exists under the API's own media root, and an empty second
   *  library to move to. */
  async function withOneVideo() {
    const app = await createTestApi();
    app.writeMedia('lektion-3.mp4');
    const created = await app.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: 'lektion-3.mp4' },
    });
    expect(created.statusCode).toBe(202);
    return { app, videoId: created.json().video.id as string };
  }

  it('refuses a root that would orphan a video, and counts the cost', async () => {
    const { app } = await withOneVideo();
    api = app;
    library = mkdtempSync(join(tmpdir(), 'p80-empty-'));

    const response = await app.server.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { settings: { P80_MEDIA_ROOT: library } },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: 'MEDIA_ROOT_WOULD_ORPHAN',
      details: { videoCount: 1, resolved: 0, orphaned: 1 },
    });
    // The message has to say the change is reversible, because it is, and because
    // "1 video will stop working" reads as destruction without it.
    expect(response.json().error.message).toMatch(/nothing is deleted/i);
  });

  it('proceeds when the cost is acknowledged', async () => {
    const { app } = await withOneVideo();
    api = app;
    library = mkdtempSync(join(tmpdir(), 'p80-empty-'));

    const response = await app.server.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { settings: { P80_MEDIA_ROOT: library }, acknowledgeOrphans: true },
    });
    expect(response.statusCode).toBe(200);
  });

  it('recomputes media_missing for every video, both directions', async () => {
    // Without this the library list stays stale until each video is opened — and after a
    // root change *every* row is potentially wrong at once, not one at a time.
    const { app, videoId } = await withOneVideo();
    api = app;
    library = mkdtempSync(join(tmpdir(), 'p80-empty-'));

    const read = async () =>
      (await app.server.app.inject({ url: `/api/videos/${videoId}` })).json()
        .mediaMissing as boolean;

    expect(await read()).toBe(false);

    await app.server.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { settings: { P80_MEDIA_ROOT: library }, acknowledgeOrphans: true },
    });
    expect(await read()).toBe(true);

    // And back. Nothing was destroyed, so setting the root back restores playback exactly
    // — which is the claim the refusal message makes, so it had better be true.
    await app.server.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { settings: { P80_MEDIA_ROOT: app.config.P80_MEDIA_ROOT } },
    });
    expect(await read()).toBe(false);
  });

  it('does not gate a change that orphans nothing', async () => {
    const { app } = await withOneVideo();
    api = app;
    library = mkdtempSync(join(tmpdir(), 'p80-copy-'));
    // Same relative path present under the new root, so the video still resolves.
    writeFileSync(join(library, 'lektion-3.mp4'), 'bytes');

    const response = await app.server.app.inject({
      method: 'PUT',
      url: '/api/settings',
      payload: { settings: { P80_MEDIA_ROOT: library } },
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('POST /api/settings/media-root/preflight', () => {
  let api: TestApi | null = null;
  afterEach(async () => {
    await api?.dispose();
    api = null;
  });

  const preflight = (app: TestApi, path: string) =>
    app.server.app.inject({
      method: 'POST',
      url: '/api/settings/media-root/preflight',
      payload: { path },
    });

  it('reports a rejection inside a 200, because the field is still being typed', async () => {
    // Same reasoning as `POST .../transcript/preview`: a 4xx would leave the surface with
    // nothing to render, and showing what is wrong before committing is the whole point.
    api = await createTestApi();
    const response = await preflight(api, '/etc');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      valid: false,
      reason: 'system_directory',
      path: null,
    });
  });

  it('counts what would resolve and what would not', async () => {
    api = await createTestApi();
    api.writeMedia('a.mp4');
    await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: 'a.mp4', title: 'Lektion drei' },
    });

    const empty = mkdtempSync(join(tmpdir(), 'p80-empty-'));
    try {
      const response = await preflight(api, empty);
      expect(response.json()).toMatchObject({
        valid: true,
        path: empty,
        videoCount: 1,
        resolved: 0,
        orphaned: 1,
      });
      // Named, not merely counted — "1 video" is much harder to act on than a title.
      expect(response.json().orphanedSample).toEqual([
        { id: expect.any(String), title: 'Lektion drei' },
      ]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('persists nothing', async () => {
    api = await createTestApi();
    const dir = mkdtempSync(join(tmpdir(), 'p80-library-'));
    try {
      await preflight(api, dir);
      const settings = await api.server.app.inject({ url: '/api/settings' });
      expect(
        settings
          .json<{ settings: Array<Record<string, unknown>> }>()
          .settings.find((s) => s.key === 'P80_MEDIA_ROOT'),
      ).toMatchObject({ source: 'environment' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not count a stored path that escapes the proposed root as resolved', async () => {
    // The containment check runs here too, not just a string join. A path that escapes the
    // proposed root is not resolvable under it, and reporting it as fine would promise
    // playback that `GET .../media` will refuse.
    api = await createTestApi();
    const nested = join(api.config.P80_MEDIA_ROOT, 'deep');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'b.mp4'), 'bytes');
    await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: 'deep/b.mp4' },
    });

    const response = await preflight(api, nested);
    expect(response.json()).toMatchObject({ videoCount: 1, resolved: 0, orphaned: 1 });
  });
});

/**
 * ADR 0026 — `null` reverts a key to its environment value.
 *
 * The property that matters is the one that is easy to fake and wrong: reverting must leave
 * the key *tracking* `.env.local`, not holding a row that happens to contain the same
 * string. `source` is what tells those two apart, which is why every assertion here reads it
 * rather than `value`.
 */
describe('PUT /api/settings — reverting to the environment', () => {
  let api: TestApi | null = null;
  let library: string | null = null;

  afterEach(async () => {
    await api?.dispose();
    api = null;
    if (library) rmSync(library, { recursive: true, force: true });
    library = null;
  });

  const put = (app: TestApi, body: Record<string, unknown>) =>
    app.server.app.inject({ method: 'PUT', url: '/api/settings', payload: body });

  const view = (response: { json: <T>() => T }, key: string) =>
    response
      .json<{ settings: Array<Record<string, unknown>> }>()
      .settings.find((s) => s.key === key);

  it('drops an override and returns the key to the environment', async () => {
    api = await createTestApi();

    const written = await put(api, { settings: { P80_ASR_MODEL: 'medium' } });
    expect(view(written, 'P80_ASR_MODEL')).toMatchObject({
      value: 'medium',
      source: 'database',
    });

    const reverted = await put(api, { settings: { P80_ASR_MODEL: null } });
    expect(reverted.statusCode).toBe(200);
    expect(view(reverted, 'P80_ASR_MODEL')).toMatchObject({
      value: 'large-v3',
      source: 'environment',
    });
  });

  it('is a no-op on a key that was never overridden', async () => {
    // Not an error: this is the state the caller asked for. A 404 here would make an
    // idempotent restore impossible to write.
    api = await createTestApi();
    const response = await put(api, { settings: { P80_ASR_MODEL: null } });
    expect(response.statusCode).toBe(200);
    expect(view(response, 'P80_ASR_MODEL')).toMatchObject({ source: 'environment' });
  });

  it('applies a write and a revert named in the same batch', async () => {
    api = await createTestApi();
    await put(api, { settings: { P80_ASR_MODEL: 'medium', P80_ASR_ALIGN: false } });

    const response = await put(api, {
      settings: { P80_ASR_MODEL: null, P80_ASR_COMPUTE_TYPE: 'int8' },
    });
    expect(view(response, 'P80_ASR_MODEL')).toMatchObject({ source: 'environment' });
    expect(view(response, 'P80_ASR_COMPUTE_TYPE')).toMatchObject({
      value: 'int8',
      source: 'database',
    });
    // Untouched by this request, so still overridden.
    expect(view(response, 'P80_ASR_ALIGN')).toMatchObject({ source: 'database' });
  });

  it('refuses to revert a boot-tier key rather than silently doing nothing', async () => {
    api = await createTestApi();
    const response = await put(api, { settings: { P80_API_PORT: null } });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.details).toMatchObject({ reason: 'boot_tier' });
  });

  it('counts the cost of reverting the media root, and needs the same acknowledgement', async () => {
    // ADR 0026 §2: reverting is not the safe direction. Here the environment root is the one
    // holding no library, so going back to it is what orphans the video.
    api = await createTestApi();
    library = mkdtempSync(join(tmpdir(), 'p80-library-'));
    writeFileSync(join(library, 'lektion-3.mp4'), 'bytes');

    await put(api, { settings: { P80_MEDIA_ROOT: library } });
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: 'lektion-3.mp4' },
    });
    expect(created.statusCode).toBe(202);

    const refused = await put(api, { settings: { P80_MEDIA_ROOT: null } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatchObject({
      code: 'MEDIA_ROOT_WOULD_ORPHAN',
      details: { orphaned: 1 },
    });

    const acknowledged = await put(api, {
      settings: { P80_MEDIA_ROOT: null },
      acknowledgeOrphans: true,
    });
    expect(acknowledged.statusCode).toBe(200);
    expect(view(acknowledged, 'P80_MEDIA_ROOT')).toMatchObject({ source: 'environment' });

    // And the recompute ran on the way out, so the library list is truthful immediately
    // rather than one click at a time.
    const videos = await api.server.app.inject({ url: '/api/videos' });
    expect(videos.json().videos[0]).toMatchObject({ mediaMissing: true });
  });
});
