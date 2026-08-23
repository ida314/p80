import { afterEach, describe, expect, it } from 'vitest';
import { ERROR_CODES, P80Error } from '@p80/core';
import { claimNextJob, enqueueJob, failJob } from '@p80/database';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * `GET /api/jobs` as a lookup, not just a list (`03-api.md` §8).
 *
 * The browser reaches a chained job through this route and nowhere else. `INGEST_MEDIA`
 * enqueues `TRANSCRIBE` from inside the worker, well after the `202 { video, jobId }` has
 * been sent, so the transcribe job's id can never appear in that response — and the client
 * that wants to say *why transcription failed* has only the video id to go on.
 *
 * That makes the `entityId` + `jobType` filters load-bearing for two UI surfaces rather
 * than a diagnostics convenience. `apps/worker/test/ingest-media.test.ts` already asserts
 * the worker enqueues the job; what was untested is that it can be found again from
 * outside, with its error intact.
 */

let api: TestApi;
afterEach(async () => api?.dispose());

const VIDEO = '01M0NDY0ZWAT8PCXQEF29MH14M';
const OTHER_VIDEO = '01M0NDY0ZWAT8PCXQEF29MH14Z';

/** The two jobs a video accumulates, in the order the pipeline produces them. */
function seedPipeline(api: TestApi, videoId: string) {
  const ingest = enqueueJob(api.server.handle, 'INGEST_MEDIA', {
    entityType: 'video',
    entityId: videoId,
    input: { jobVersion: 1, videoId, transcribe: true },
  });
  const transcribe = enqueueJob(api.server.handle, 'TRANSCRIBE', {
    entityType: 'video',
    entityId: videoId,
    input: { jobVersion: 1, videoId, language: 'de' },
  });
  return { ingest, transcribe };
}

describe('GET /api/jobs', () => {
  it('finds a video\'s transcribe job by entity and type', async () => {
    api = await createTestApi();
    const { transcribe } = seedPipeline(api, VIDEO);
    seedPipeline(api, OTHER_VIDEO);

    const res = await api.server.app.inject({
      method: 'GET',
      url: `/api/jobs?entityId=${VIDEO}&jobType=TRANSCRIBE&limit=1`,
    });

    expect(res.statusCode).toBe(200);
    const jobs = res.json();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      id: transcribe.id,
      jobType: 'TRANSCRIBE',
      entityType: 'video',
      entityId: VIDEO,
    });
  });

  it('carries the failure reason out to the client', async () => {
    api = await createTestApi();
    const { transcribe } = seedPipeline(api, VIDEO);

    // The real failure, in the shape the sidecar actually produces it: a 501 saying this
    // build cannot transcribe. One attempt, because ADR 0027 believes the flag — before
    // that it burned all three in 25 ms and reported a setup problem as a broken file.
    claimNextJob(api.server.handle, 'test-worker', ['TRANSCRIBE']);
    failJob(
      api.server.handle,
      transcribe.id,
      new P80Error(
        ERROR_CODES.ASR_UNAVAILABLE,
        'No ASR model is installed in the sidecar.',
        { statusCode: 501, retryable: false },
      ),
    );

    const res = await api.server.app.inject({
      method: 'GET',
      url: `/api/jobs?entityId=${VIDEO}&jobType=TRANSCRIBE&limit=1`,
    });

    const [job] = res.json();
    expect(job.status).toBe('failed');
    // The whole point of the lookup: `transcript_status` can only say `failed`, and this
    // is where the sentence explaining it comes from.
    expect(job.attemptCount).toBe(1);
    expect(job.errorJson).toMatchObject({
      message: 'No ASR model is installed in the sidecar.',
      code: ERROR_CODES.ASR_UNAVAILABLE,
      retryable: false,
    });
  });

  it('returns nothing for a video that never had one enqueued', async () => {
    api = await createTestApi();
    enqueueJob(api.server.handle, 'INGEST_MEDIA', {
      entityType: 'video',
      entityId: VIDEO,
      // The repair path, which deliberately does not transcribe.
      input: { jobVersion: 1, videoId: VIDEO, transcribe: false },
    });

    const res = await api.server.app.inject({
      method: 'GET',
      url: `/api/jobs?entityId=${VIDEO}&jobType=TRANSCRIBE&limit=1`,
    });

    // An empty list, not a 404. The client renders nothing for this — it is a legitimate
    // end state, not a job that has yet to appear.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('orders newest first, so limit=1 is the current attempt', async () => {
    api = await createTestApi();
    const first = enqueueJob(api.server.handle, 'TRANSCRIBE', {
      entityType: 'video',
      entityId: VIDEO,
      input: { jobVersion: 1, videoId: VIDEO, language: 'de' },
    });
    const second = enqueueJob(api.server.handle, 'TRANSCRIBE', {
      entityType: 'video',
      entityId: VIDEO,
      input: { jobVersion: 1, videoId: VIDEO, language: 'de' },
    });

    const res = await api.server.app.inject({
      method: 'GET',
      url: `/api/jobs?entityId=${VIDEO}&jobType=TRANSCRIBE`,
    });

    const ids = res.json().map((job: { id: string }) => job.id);
    expect(ids[0]).toBe(second.id);
    expect(ids).toContain(first.id);
  });
});
