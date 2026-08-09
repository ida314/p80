import { afterEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';
import { seedReadyTranscript, segment } from './transcript-fixture.js';

/**
 * Stage 2 exit criteria 2 and 3 — the server-side halves.
 *
 * Criterion 3 ("clicking a segment seeks to the expected region") is verified in three
 * places, because no single one of them can carry it: the pure seek arithmetic in
 * `packages/core/test/transcript-seek.test.ts`, the exact timings and embed descriptor
 * here, and manual check M1 for the player itself.
 */

let api: TestApi;
afterEach(async () => api?.dispose());

describe('GET /api/videos/:id/transcript', () => {
  it('returns segments in timestamp order while keeping file order visible', async () => {
    // Exit criterion 2. The parser stores file order and warns about the discrepancy;
    // reordering the file itself is a decision that belongs to the user through
    // `transcript_corrections`, not to the parser or the reader.
    api = await createTestApi();
    const videoId = await seedReadyTranscript(api, [
      segment(0, 5_000, 7_000, 'Dritte'),
      segment(1, 1_000, 3_000, 'Erste'),
      segment(2, 3_000, 5_000, 'Zweite'),
    ]);

    const res = await api.server.app.inject({ url: `/api/videos/${videoId}/transcript` });
    expect(res.statusCode).toBe(200);
    expect(res.json().segments.map((s: { text: string }) => s.text)).toEqual([
      'Erste',
      'Zweite',
      'Dritte',
    ]);
    expect(res.json().segments.map((s: { sequenceIndex: number }) => s.sequenceIndex)).toEqual(
      [1, 2, 0],
    );
  });

  it('returns exact timings and the media descriptor click-to-seek needs', async () => {
    api = await createTestApi();
    const videoId = await seedReadyTranscript(api, [
      segment(0, 1_000, 3_000, 'Guten Tag.'),
      segment(1, 72_500, 75_000, 'Wie geht es Ihnen?'),
    ]);

    const transcript = await api.server.app.inject({
      url: `/api/videos/${videoId}/transcript`,
    });
    const video = await api.server.app.inject({ url: `/api/videos/${videoId}` });

    // Timings survive the round trip unrounded — a client that seeks to `startMs` must be
    // aiming at the millisecond the file specified.
    expect(transcript.json().segments[1]).toMatchObject({
      startMs: 72_500,
      endMs: 75_000,
    });
    // And the client gets the descriptor from the server rather than building a player
    // from a path — which it does not have and must not learn (ADR 0015).
    expect(video.json().media).toEqual({
      kind: 'local_media',
      mediaUrl: `/api/videos/${videoId}/media`,
      missing: false,
    });
  });

  it('carries the file, its warnings, and the transcript status', async () => {
    api = await createTestApi();
    const videoId = await seedReadyTranscript(api, [segment(0, 0, 1_000, 'Eins.')]);

    const res = await api.server.app.inject({ url: `/api/videos/${videoId}/transcript` });
    expect(res.json()).toMatchObject({
      videoId,
      transcriptStatus: 'ready',
      file: {
        format: 'vtt',
        originalFilename: 'folge-1.vtt',
        parserVersion: '1',
        // ADR 0016/0017. An uploaded VTT is `upload` at `cue` granularity, always — it
        // carries no word timing and never will.
        source: 'upload',
        timingGranularity: 'cue',
      },
    });
  });

  it('reports a video with no transcript without failing', async () => {
    api = await createTestApi();
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: api.writeMedia('german/other.mp4') },
    });
    const res = await api.server.app.inject({
      url: `/api/videos/${created.json().video.id}/transcript`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      transcriptStatus: 'none',
      file: null,
      segments: [],
    });
  });

  it('pages long transcripts', async () => {
    api = await createTestApi();
    const many = Array.from({ length: 250 }, (_, i) =>
      segment(i, i * 1_000, i * 1_000 + 900, `Zeile ${i}.`),
    );
    const videoId = await seedReadyTranscript(api, many);

    const first = await api.server.app.inject({
      url: `/api/videos/${videoId}/transcript?limit=100`,
    });
    expect(first.json().segments).toHaveLength(100);
    expect(first.json().nextCursor).not.toBeNull();

    const second = await api.server.app.inject({
      url: `/api/videos/${videoId}/transcript?limit=100&cursor=${first.json().nextCursor}`,
    });
    expect(second.json().segments).toHaveLength(100);
    expect(second.json().segments[0].sequenceIndex).toBeGreaterThan(
      first.json().segments[99].sequenceIndex,
    );
  });

  it('404s a transcript for an unknown video', async () => {
    api = await createTestApi();
    const res = await api.server.app.inject({ url: '/api/videos/nope/transcript' });
    expect(res.statusCode).toBe(404);
  });
});

/**
 * `GET .../transcript/words` — ADR 0017.
 *
 * The route exists so a client can highlight the word being spoken. What is asserted here
 * is mostly the *refusal*: an uploaded subtitle file has no word timing and never will, and
 * an empty array would read as "this transcript has no words" — false, and it would send a
 * caller looking for a parsing bug.
 */
describe('GET /api/videos/:id/transcript/words', () => {
  it('refuses a cue-tier transcript rather than returning an empty array', async () => {
    api = await createTestApi();
    const videoId = await seedReadyTranscript(api, [segment(0, 0, 1_000, 'Eins.')]);

    const res = await api.server.app.inject({ url: `/api/videos/${videoId}/transcript/words` });

    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TRANSCRIPT_TIMING_UNAVAILABLE');
    // The message says why, and says it is a property of the source rather than a failure.
    expect(res.json().error.message).toMatch(/line boundaries/);
  });

  it('404s a video with no transcript at all, which is a different thing', async () => {
    api = await createTestApi();
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: api.writeMedia('german/untranscribed.mp4') },
    });

    const res = await api.server.app.inject({
      url: `/api/videos/${created.json().video.id}/transcript/words`,
    });
    // "No transcript yet" and "this transcript cannot have word timing" are different
    // states and lead the user to different next steps.
    expect(res.statusCode).toBe(404);
  });
});
