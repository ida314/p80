import { afterEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * The chunk route needs a raw-bytes body parser, and Fastify's parsers are **per instance
 * and inherited downward**. Registering `application/octet-stream` on the root app would
 * therefore change how *every* route in P80 reads a body — and the failure would not look
 * like a configuration mistake. A handler expecting a validated object would silently
 * receive a `Buffer`, and only for requests that happened to carry that content type.
 *
 * So the parser is registered inside an encapsulated `app.register` scope. That is a claim
 * about a framework behaviour rather than about P80's own code, which is exactly the kind
 * of claim that is worth pinning down rather than assuming — it is invisible in review, it
 * would survive a refactor that flattened the scope, and nothing else in the suite would
 * notice.
 *
 * These four tests are the whole of that claim.
 */

let api: TestApi;
afterEach(async () => {
  await api?.dispose();
});

describe('the octet-stream parser reaches the chunk route and nothing else', () => {
  it('leaves the JSON routes reading JSON, after the upload routes are registered', async () => {
    api = await createTestApi();
    const media = api.writeMedia('german/lektion-3.mp4');

    // The ordinary path still works. If the parser had leaked, this body would arrive as
    // a Buffer and fail validation in a thoroughly confusing way.
    const res = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: media },
    });
    expect(res.statusCode).toBe(202);
  });

  it('refuses octet-stream on a JSON route rather than accepting raw bytes', async () => {
    api = await createTestApi();
    const res = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('raw bytes, not a video'),
    });
    // 415: the route has no parser for this type, which is the encapsulation holding.
    expect(res.statusCode).toBe(415);
  });

  it('refuses JSON on the chunk route, which takes bytes and only bytes', async () => {
    api = await createTestApi();
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/uploads',
      payload: { filename: 'clip.mp4', sizeBytes: 4 },
    });

    const res = await api.server.app.inject({
      method: 'PUT',
      url: `/api/uploads/${created.json().id}/chunk?offset=0`,
      payload: { pretending: 'to be a chunk' },
    });
    // 400 rather than 415, and correctly so: the scope *inherits* the parent's JSON
    // parser, so the body parses fine and the handler's own type check is what refuses it.
    // Encapsulation is one-directional — a child gains a parser without the parent losing
    // one — which is exactly the property the other three tests are pinning down.
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/octet-stream/);
  });

  it('still refuses a settings write sent as octet-stream', async () => {
    api = await createTestApi();
    // A second JSON route, because the first could pass for an unrelated reason. Settings
    // is the one that matters most: it can re-point the media root.
    const res = await api.server.app.inject({
      method: 'PUT',
      url: '/api/settings',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('{"settings":{"P80_MEDIA_ROOT":"/"}}'),
    });
    expect(res.statusCode).toBe(415);
  });
});

/**
 * Fastify refuses an over-limit body itself, before any handler runs, and its error is not
 * a `P80Error` — so `toEnvelope` reported it as `500 INTERNAL_ERROR`.
 *
 * This was already true of the transcript route's 4 MB limit and had simply never fired.
 * The chunk route would hit it routinely, and "the server broke" is a very different thing
 * to tell a user than "that was too big".
 */
describe('an over-limit body is a 413, not a 500', () => {
  it('reports the transcript route’s own limit correctly', async () => {
    api = await createTestApi();
    const media = api.writeMedia('german/lektion-3.mp4');
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: media },
    });

    const res = await api.server.app.inject({
      method: 'POST',
      url: `/api/videos/${created.json().video.id}/transcript`,
      payload: { content: 'x'.repeat(5 * 1024 * 1024) },
    });

    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe('UPLOAD_TOO_LARGE');
  });
});
