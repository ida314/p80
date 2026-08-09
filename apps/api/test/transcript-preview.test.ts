import { afterEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * Stage 2 step 8 and exit criterion 14 — §12.1 step 7 requires the user to see the parsed
 * segments *before* confirming, which the contract's endpoint list had no way to express.
 */

let api: TestApi;
afterEach(async () => api?.dispose());

async function setup() {
  api = await createTestApi();
  const created = await api.server.app.inject({
    method: 'POST',
    url: '/api/videos',
    payload: { path: api.writeMedia('german/folge-1.mp4'), title: 'Folge 1' },
  });
  return created.json().video.id as string;
}

const preview = (videoId: string, payload: Record<string, unknown>) =>
  api.server.app.inject({
    method: 'POST',
    url: `/api/videos/${videoId}/transcript/preview`,
    payload,
  });

const counts = () => ({
  files: (
    api.server.handle.sqlite
      .prepare('SELECT COUNT(*) AS n FROM transcript_files')
      .get() as { n: number }
  ).n,
  segments: (
    api.server.handle.sqlite
      .prepare('SELECT COUNT(*) AS n FROM transcript_segments')
      .get() as { n: number }
  ).n,
  jobs: (api.server.handle.sqlite.prepare('SELECT COUNT(*) AS n FROM jobs').get() as {
    n: number;
  }).n,
});

describe('POST /api/videos/:id/transcript/preview', () => {
  it('parses and persists nothing at all', async () => {
    const videoId = await setup();
    const before = counts();
    const res = await preview(videoId, {
      content: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nGuten Tag.\n',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      format: 'vtt',
      segmentCount: 1,
      truncated: false,
      lastEndMs: 3_000,
      validation: { fatal: null },
    });
    expect(res.json().segments[0]).toMatchObject({
      startMs: 1_000,
      endMs: 3_000,
      rawText: 'Guten Tag.',
      normalizedText: 'Guten Tag.',
    });
    expect(counts()).toEqual(before);
  });

  it('returns a validation failure inside a 200, not as an error status', async () => {
    // This is the whole reason the endpoint exists. A 4xx would leave the preview screen
    // with nothing to render, when what the user needs is to see exactly what is wrong.
    const videoId = await setup();
    const res = await preview(videoId, {
      content: 'WEBVTT\n\n00:00:05.000 --> 00:00:02.000\nRückwärts.\n',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().validation.fatal).toMatchObject({
      code: 'TRANSCRIPT_INVALID_TIMESTAMPS',
      details: { segmentIndex: 0, startMs: 5_000, endMs: 2_000 },
    });
    expect(counts().files).toBe(0);
  });

  it('returns 400 only when there is nothing to preview', async () => {
    const videoId = await setup();
    const res = await preview(videoId, { content: 'prose with no timestamps at all' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TRANSCRIPT_FORMAT_UNRECOGNIZED');
  });

  it('surfaces the warnings and their counts, so the screen can group them', async () => {
    const videoId = await setup();
    const res = await preview(videoId, {
      content: `WEBVTT

00:00:01.000 --> 00:00:03.000
Please subscribe to the channel.

00:00:03.000 --> 00:00:05.000
Subtitles by the Amara.org community

00:00:05.000 --> 00:00:07.000
Guten Tag.
`,
    });

    // ADR 0013's own wording: "The user sees '3 cues look like subtitle boilerplate' on the
    // transcript-preview screen and decides."
    expect(res.json().warningsByKind.subtitle_boilerplate).toBe(2);
    // And the matching cues are still in the preview, exactly as they will be stored.
    expect(res.json().segmentCount).toBe(3);
    expect(res.json().warnings.some((w: { kind: string }) => w.kind === 'subtitle_boilerplate')).toBe(
      true,
    );
  });

  it('truncates a long preview but reports the real count', async () => {
    const videoId = await setup();
    const cues: string[] = [];
    for (let i = 0; i < 300; i += 1) {
      const mm = String(Math.floor(i / 60)).padStart(2, '0');
      const ss = String(i % 60).padStart(2, '0');
      cues.push(`00:${mm}:${ss}.000 --> 00:${mm}:${ss}.900\nZeile ${i}.`);
    }
    const res = await preview(videoId, { content: `WEBVTT\n\n${cues.join('\n\n')}\n` });

    expect(res.json().segmentCount).toBe(300);
    expect(res.json().segments).toHaveLength(200);
    expect(res.json().truncated).toBe(true);
  });

  it('404s an unknown video', async () => {
    await setup();
    const res = await preview('nope', { content: 'WEBVTT\n' });
    expect(res.statusCode).toBe(404);
  });
});
