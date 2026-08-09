import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApi, type TestApi } from './helpers.js';

/**
 * Stage 2 steps 8, 10 and 15, and exit criteria 1, 10 and 14.
 *
 * The split under test: the route accepts and enqueues, the worker parses. That is
 * `03-api.md` §1's 202-plus-jobId rule and spec §12.1 step 9's *"ingestion job begins"*,
 * and it is what stops a pathological file holding a request open.
 */

let api: TestApi;
afterEach(async () => api?.dispose());

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
Guten Tag.

00:00:03.000 --> 00:00:05.000
Wie geht es Ihnen?
`;

async function setup() {
  api = await createTestApi();
  const created = await api.server.app.inject({
    method: 'POST',
    url: '/api/videos',
    payload: { path: api.writeMedia('german/folge-1.mp4'), title: 'Folge 1' },
  });
  return created.json().video.id as string;
}

const upload = (videoId: string, payload: Record<string, unknown>) =>
  api.server.app.inject({
    method: 'POST',
    url: `/api/videos/${videoId}/transcript`,
    payload,
  });

const rows = (table: string) =>
  (
    api.server.handle.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
      n: number;
    }
  ).n;

describe('POST /api/videos/:id/transcript', () => {
  it('accepts, enqueues, and does NOT parse inline', async () => {
    const videoId = await setup();
    const res = await upload(videoId, { content: VTT, filename: 'folge-1.vtt' });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ status: 'pending' });
    expect(res.json().jobId).toBeTruthy();
    expect(res.json().transcriptFileId).toBeTruthy();

    // The file row and the status exist immediately...
    expect(rows('transcript_files')).toBe(1);
    const video = await api.server.app.inject({ url: `/api/videos/${videoId}` });
    expect(video.json().transcriptStatus).toBe('parsing');

    // ...and the segments do not. This is the assertion that pins the decision: if
    // someone later parses inline "because it is faster", this fails.
    expect(rows('transcript_segments')).toBe(0);
  });

  it('writes the uploaded file to disk under the storage root', async () => {
    const videoId = await setup();
    const res = await upload(videoId, { content: VTT, filename: 'folge-1.vtt' });

    const stored = api.server.handle.sqlite
      .prepare('SELECT storage_path AS p, checksum AS c FROM transcript_files')
      .get() as { p: string; c: string };

    expect(existsSync(stored.p)).toBe(true);
    expect(stored.p.startsWith(api.config.P80_STORAGE_PATH)).toBe(true);
    // The path is built from ids, never from the filename.
    expect(stored.p).toContain(videoId);
    expect(stored.p).toContain(res.json().transcriptFileId);
    expect(stored.c).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never lets a filename influence where the file lands', async () => {
    const videoId = await setup();
    await upload(videoId, {
      content: VTT,
      filename: '../../../../home/user/.ssh/authorized_keys',
    });

    const stored = api.server.handle.sqlite
      .prepare('SELECT storage_path AS p, original_filename AS f FROM transcript_files')
      .get() as { p: string; f: string | null };

    expect(stored.p.startsWith(api.config.P80_STORAGE_PATH)).toBe(true);
    expect(stored.p).not.toContain('..');
    expect(stored.p).not.toContain('.ssh');
    // The name is kept for display only, sanitised down to its basename.
    expect(stored.f).toBe('authorized_keys');
    expect(readdirSync(join(api.config.P80_STORAGE_PATH, 'transcripts'))).toEqual([videoId]);
  });

  it('refuses a second transcript unless replace is explicit', async () => {
    const videoId = await setup();
    await upload(videoId, { content: VTT });
    const second = await upload(videoId, { content: `${VTT}\n00:00:05.000 --> 00:00:07.000\nNoch etwas.\n` });

    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('TRANSCRIPT_ALREADY_EXISTS');
    // The message states the cost, because the client shows it before re-sending.
    expect(second.json().error.message).toMatch(/still being parsed|discard any corrections/);
  });

  it('refuses the identical file even under replace', async () => {
    const videoId = await setup();
    await upload(videoId, { content: VTT });
    const same = await upload(videoId, { content: VTT, replace: true });

    // §14.1's "duplicate upload". Re-uploading identical bytes is a no-op the user should
    // be told about rather than a silent rewrite.
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('TRANSCRIPT_DUPLICATE_UPLOAD');
  });

  it('replaces when told to, leaving exactly one queued parse', async () => {
    const videoId = await setup();
    await upload(videoId, { content: VTT });
    const replaced = await upload(videoId, {
      content: `${VTT}\n00:00:05.000 --> 00:00:07.000\nNoch etwas.\n`,
      replace: true,
    });

    expect(replaced.statusCode).toBe(202);
    expect(rows('transcript_files')).toBe(1);
    // Scoped to the job type. Adding a video enqueues `INGEST_MEDIA` (ADR 0015), so a bare
    // count of pending jobs would be counting two unrelated things and would need editing
    // every time ingestion grows a step. The claim here is about the *parse*: replacing a
    // transcript must supersede the queued parse rather than adding a second one.
    const pending = api.server.handle.sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE status = 'pending' AND job_type = 'PARSE_TRANSCRIPT'",
      )
      .get() as { n: number };
    expect(pending.n).toBe(1);
  });

  it('rejects an unrecognized format before anything touches disk', async () => {
    const videoId = await setup();
    const res = await upload(videoId, { content: 'just some prose with no timestamps' });

    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('TRANSCRIPT_FORMAT_UNRECOGNIZED');
    expect(rows('transcript_files')).toBe(0);
    // No *parse* job. The `INGEST_MEDIA` job from adding the video is unrelated and is
    // still there, which is why this is scoped rather than a bare count of `jobs`.
    const parses = api.server.handle.sqlite
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE job_type = 'PARSE_TRANSCRIPT'")
      .get() as { n: number };
    expect(parses.n).toBe(0);
    expect(existsSync(join(api.config.P80_STORAGE_PATH, 'transcripts'))).toBe(false);
  });

  it('names the stage when handed a JSON transcript', async () => {
    const videoId = await setup();
    const res = await upload(videoId, { content: '{"segments":[]}' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/Stage 13/);
  });

  it('refuses content past the size limit', async () => {
    const videoId = await setup();
    const res = await upload(videoId, { content: 'a'.repeat(2_000_001) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_FAILED');
  });

  it('404s an unknown video', async () => {
    await setup();
    const res = await upload('nope', { content: VTT });
    expect(res.statusCode).toBe(404);
  });
});

describe('exit criterion 10 — no filesystem path leaves the API', () => {
  it('keeps the storage root out of every response, including the job payload', async () => {
    const videoId = await setup();
    const accepted = await upload(videoId, { content: VTT, filename: 'folge-1.vtt' });
    const root = api.config.P80_STORAGE_PATH;

    // `GET /api/jobs/:id` returns `inputJson` and `outputJson` verbatim, so a path in the
    // job payload is a published path. That is the easy miss, and it is why the payload
    // carries `transcriptFileId` and the handler resolves the path itself.
    const job = await api.server.app.inject({ url: `/api/jobs/${accepted.json().jobId}` });
    const transcript = await api.server.app.inject({
      url: `/api/videos/${videoId}/transcript`,
    });

    for (const payload of [accepted.payload, job.payload, transcript.payload]) {
      expect(payload).not.toContain(root);
      expect(payload).not.toContain('storagePath');
      expect(payload).not.toContain('storage_path');
    }
  });
});

describe('DELETE /api/videos/:id/transcript', () => {
  it('reports what it removed and cancels the queued parse', async () => {
    const videoId = await setup();
    const accepted = await upload(videoId, { content: VTT });

    const res = await api.server.app.inject({
      method: 'DELETE',
      url: `/api/videos/${videoId}/transcript`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ deletedFiles: 1, cancelledJobs: 1 });

    // Without the cancellation a queued job would resurrect the segments seconds after
    // the user deleted them.
    const job = await api.server.app.inject({ url: `/api/jobs/${accepted.json().jobId}` });
    expect(job.json().status).toBe('cancelled');

    const video = await api.server.app.inject({ url: `/api/videos/${videoId}` });
    expect(video.json().transcriptStatus).toBe('none');
  });

  it('leaves the uploaded file on disk, so the source stays recoverable', async () => {
    const videoId = await setup();
    await upload(videoId, { content: VTT });
    const stored = api.server.handle.sqlite
      .prepare('SELECT storage_path AS p FROM transcript_files')
      .get() as { p: string };

    await api.server.app.inject({
      method: 'DELETE',
      url: `/api/videos/${videoId}/transcript`,
    });

    // Encoded as a test rather than a comment: corrections are gone for good, the source
    // is not.
    expect(existsSync(stored.p)).toBe(true);
  });

  it('allows a fresh upload afterwards', async () => {
    const videoId = await setup();
    await upload(videoId, { content: VTT });
    await api.server.app.inject({
      method: 'DELETE',
      url: `/api/videos/${videoId}/transcript`,
    });
    const again = await upload(videoId, { content: VTT });
    expect(again.statusCode).toBe(202);
  });
});
