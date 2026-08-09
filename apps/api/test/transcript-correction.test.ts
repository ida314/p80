import { afterEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';
import { seedReadyTranscript, segment } from './transcript-fixture.js';

/**
 * Stage 2 step 13, and exit criteria 4 and 7.
 *
 * The assertion that matters most is that the original row is byte-identical afterwards.
 * `06-scoring.md` §4.2 counts corrections as a transcript-quality signal, which needs them
 * to be rows; §38.4's mitigation for bad captions is source replay, which needs the
 * original text to still be there; and Stage 3 will cut items from these lines, which needs
 * a stable thing to reference.
 */

let api: TestApi;
afterEach(async () => api?.dispose());

const THREE = [
  segment(0, 1_000, 3_000, 'Ich habe kein Ahnung.'),
  segment(1, 3_000, 5_000, 'Wie geht es Ihnen?'),
  segment(2, 5_000, 7_000, 'Danke, gut.'),
];

async function setup() {
  api = await createTestApi();
  const videoId = await seedReadyTranscript(api, THREE);
  const transcript = await api.server.app.inject({
    url: `/api/videos/${videoId}/transcript`,
  });
  return { videoId, segments: transcript.json().segments as Array<{ id: string }> };
}

const correct = (videoId: string, segmentId: string, payload: Record<string, unknown>) =>
  api.server.app.inject({
    method: 'PUT',
    url: `/api/videos/${videoId}/transcript/segments/${segmentId}`,
    payload,
  });

const storedSegments = () =>
  api.server.handle.sqlite
    .prepare('SELECT * FROM transcript_segments ORDER BY sequence_index')
    .all();

describe('PUT .../transcript/segments/:segmentId', () => {
  it('records the correction and leaves the original row byte-identical', async () => {
    const { videoId, segments } = await setup();
    const before = storedSegments();

    const res = await correct(videoId, segments[0]!.id, {
      text: 'Ich habe keine Ahnung.',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      text: 'Ich habe keine Ahnung.',
      corrected: true,
      // The original travels with the correction, so the row's disclosure can show both.
      rawText: 'Ich habe kein Ahnung.',
    });
    expect(res.json().correctionId).toBeTruthy();

    // The load-bearing assertion of this whole file.
    expect(storedSegments()).toEqual(before);
  });

  it('corrects timings without touching the text', async () => {
    const { videoId, segments } = await setup();
    const res = await correct(videoId, segments[0]!.id, { startMs: 500, endMs: 2_800 });
    expect(res.json()).toMatchObject({
      startMs: 500,
      endMs: 2_800,
      text: 'Ich habe kein Ahnung.',
      corrected: true,
    });
  });

  it('judges a partial edit against the current effective values', async () => {
    const { videoId, segments } = await setup();
    await correct(videoId, segments[0]!.id, { endMs: 2_000 });
    // The stored segment still ends at 3_000, but the effective one ends at 2_000, and a
    // start of 2_500 is incoherent against *that*. Merging against the stored row would
    // wrongly accept this.
    const res = await correct(videoId, segments[0]!.id, { startMs: 2_500 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/cannot end before it starts/);
  });

  it('supersedes an earlier correction while keeping both rows', async () => {
    const { videoId, segments } = await setup();
    await correct(videoId, segments[0]!.id, { text: 'Erste Fassung.' });
    const second = await correct(videoId, segments[0]!.id, { text: 'Zweite Fassung.' });

    expect(second.json().text).toBe('Zweite Fassung.');
    const rows = api.server.handle.sqlite
      .prepare('SELECT COUNT(*) AS n FROM transcript_corrections')
      .get() as { n: number };
    // History is evidence, not scratch space — §22.5 counts corrections as a quality
    // signal, and overwriting would erase the count.
    expect(rows.n).toBe(2);
  });

  it('shows the correction on the next read', async () => {
    const { videoId, segments } = await setup();
    await correct(videoId, segments[0]!.id, { text: 'Ich habe keine Ahnung.', startMs: 900 });

    const res = await api.server.app.inject({ url: `/api/videos/${videoId}/transcript` });
    expect(res.json().segments[0]).toMatchObject({
      text: 'Ich habe keine Ahnung.',
      startMs: 900,
      corrected: true,
      rawText: 'Ich habe kein Ahnung.',
    });
    // Uncorrected siblings are unaffected.
    expect(res.json().segments[1]).toMatchObject({ corrected: false });
  });

  it('refuses a segment belonging to another video', async () => {
    const { segments } = await setup();
    const other = await seedReadyTranscript(api, THREE, {
      mediaPath: 'german/folge-2.mp4',
      title: 'Folge 2',
    });
    // Looking a segment up by id alone would let one video's URL address another's rows.
    const res = await correct(other, segments[0]!.id, { text: 'Fremd.' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses an empty edit', async () => {
    const { videoId, segments } = await setup();
    const res = await correct(videoId, segments[0]!.id, {});
    expect(res.statusCode).toBe(400);
  });

  it('refuses an end before the start', async () => {
    const { videoId, segments } = await setup();
    const res = await correct(videoId, segments[0]!.id, { startMs: 4_000 });
    expect(res.statusCode).toBe(400);
  });

  it('refuses a correction while the transcript is still parsing', async () => {
    api = await createTestApi();
    const created = await api.server.app.inject({
      method: 'POST',
      url: '/api/videos',
      payload: { path: api.writeMedia('german/other.mp4') },
    });
    const videoId = created.json().video.id;
    await api.server.app.inject({
      method: 'POST',
      url: `/api/videos/${videoId}/transcript`,
      payload: { content: 'WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nGuten Tag.\n' },
    });

    const res = await correct(videoId, 'anything', { text: 'Zu früh.' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('TRANSCRIPT_NOT_READY');
  });

  it('404s an unknown segment', async () => {
    const { videoId } = await setup();
    const res = await correct(videoId, 'no-such-segment', { text: 'x' });
    expect(res.statusCode).toBe(404);
  });
});
