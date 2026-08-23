import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INGEST_MEDIA_JOB_VERSION,
  createLogger,
  loadConfig,
  type Config,
  type JobRecord,
} from '@p80/core';
import {
  createVideo,
  ensureProfile,
  enqueueJob,
  getVideo,
  listVideos,
  migrate,
  openDatabase,
  type DatabaseHandle,
} from '@p80/database';
import { createIngestMediaHandler } from '../src/handlers/ingest-media.js';

/**
 * `INGEST_MEDIA` — ADR 0015 and 0018.
 *
 * The job that turns a path into an identity. Its interesting behaviour is all in the
 * cases where something has changed underneath it: the file moved, the file is the same
 * one under a new name, or the file is a *different* one being offered as a repair. The
 * last is the one that matters most — accepting it would silently rebind a transcript to
 * audio it does not describe.
 */

interface Fixture {
  handle: DatabaseHandle;
  config: Config;
  mediaRoot: string;
  videoId: string;
  dispose(): void;
}

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});

const CONTENT = 'pretend this is an mp4';

function setup(options: { content?: string; mediaPath?: string | null } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'p80-ingest-'));
  const config = loadConfig({
    P80_DB_PATH: join(dir, 'p80.db'),
    P80_STORAGE_PATH: join(dir, 'storage'),
    P80_MEDIA_ROOT: join(dir, 'media'),
    P80_LOG_LEVEL: 'silent',
  });
  const handle = openDatabase(config.P80_DB_PATH);
  migrate(handle.sqlite);

  const relative = options.mediaPath === undefined ? 'german/folge-1.mp4' : options.mediaPath;
  if (relative !== null) {
    writeMedia(config.P80_MEDIA_ROOT, relative, options.content ?? CONTENT);
  }

  const profile = ensureProfile(handle);
  const video = createVideo(handle, {
    profileId: profile.id,
    sourceType: 'local_media',
    url: relative ?? '',
    mediaPath: relative,
    title: 'Folge 1',
    targetLanguage: 'de',
  });

  return {
    handle,
    config,
    mediaRoot: config.P80_MEDIA_ROOT,
    videoId: video.id,
    dispose() {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function writeMedia(root: string, relative: string, content: string): string {
  const full = join(root, relative);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

const sha = (content: string) => createHash('sha256').update(content).digest('hex');

async function run(f: Fixture, overrides: Record<string, unknown> = {}) {
  const handler = createIngestMediaHandler({ config: f.config });
  const job = enqueueJob(f.handle, 'INGEST_MEDIA', {
    entityType: 'video',
    entityId: f.videoId,
    input: {
      jobVersion: INGEST_MEDIA_JOB_VERSION,
      videoId: f.videoId,
      transcribe: true,
      ...overrides,
    },
  });
  return (await handler({
    handle: f.handle,
    logger: createLogger('worker-test', 'silent'),
    job: job as JobRecord,
    isCancelled: () => false,
  })) as Record<string, unknown>;
}

describe('happy path', () => {
  it('records the content hash as the video identity', async () => {
    fixture = setup();
    const result = await run(fixture);

    expect(result.contentHash).toBe(sha(CONTENT));
    expect(getVideo(fixture.handle, fixture.videoId)!.externalVideoId).toBe(sha(CONTENT));
  });

  it('records the byte size and clears the missing flag', async () => {
    fixture = setup();
    await run(fixture);

    const video = getVideo(fixture.handle, fixture.videoId)!;
    expect(video.mediaBytes).toBe(CONTENT.length);
    expect(video.mediaMissing).toBe(false);
  });

  it('enqueues transcription, pinning the language from the profile', async () => {
    fixture = setup();
    const result = await run(fixture);

    expect(result.transcribeJobId).toBeTruthy();
    const job = fixture.handle.sqlite
      .prepare('SELECT job_type, input_json FROM jobs WHERE id = ?')
      .get(result.transcribeJobId) as { job_type: string; input_json: string };

    expect(job.job_type).toBe('TRANSCRIBE');
    // Pinned at enqueue, not read at run time: a profile edited while the job waits must
    // not change what language the audio is decoded as.
    expect(JSON.parse(job.input_json).language).toBe('de');
  });

  it('does not enqueue transcription on the repair path', async () => {
    // Re-pointing a video at a moved file must not re-transcribe: the transcript survived
    // the move, and re-running would destroy the user's corrections to it.
    fixture = setup();
    const result = await run(fixture, { transcribe: false });
    expect(result.transcribeJobId).toBeNull();
  });

  it('never writes into the media root', async () => {
    fixture = setup();
    await run(fixture);

    // `CLAUDE.md` rule 3, from the other side: not "no copy into storage" but "nothing new
    // beside the user's file". No hash cache, no sidecar, no thumbnail.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(fixture.mediaRoot, 'german'))).toEqual(['folge-1.mp4']);
  });
});

describe('the file is not where it was', () => {
  it('marks the video for repair rather than failing the job', async () => {
    fixture = setup({ mediaPath: 'german/folge-1.mp4' });
    rmSync(join(fixture.mediaRoot, 'german/folge-1.mp4'));

    const result = await run(fixture);

    // A moved file is the repairable broken link ADR 0018 §3 designs for. A red job with a
    // stack trace tells the user less than a video that says "point me at this again".
    expect(result.skipped).toBe('media_missing');
    expect(getVideo(fixture.handle, fixture.videoId)!.mediaMissing).toBe(true);
  });

  it('leaves the video and everything on it intact', async () => {
    fixture = setup();
    rmSync(join(fixture.mediaRoot, 'german/folge-1.mp4'));
    await run(fixture);

    // Nothing cascades. Only playback needs the bytes.
    expect(getVideo(fixture.handle, fixture.videoId)).not.toBeNull();
  });

  it('succeeds as a no-op when the video was deleted under it', async () => {
    fixture = setup();
    fixture.handle.sqlite.prepare('DELETE FROM videos WHERE id = ?').run(fixture.videoId);

    const result = await run(fixture);
    // There is no failure here to report — the user deleted the video, and resurrecting it
    // would be the bug.
    expect(result.skipped).toBe('video_deleted');
  });
});

describe('the same file under two names', () => {
  it('re-points the original and drops the duplicate row', async () => {
    fixture = setup();
    await run(fixture);
    const originalId = fixture.videoId;

    // The user renames the file and adds it again — the ordinary consequence of
    // reorganising a library.
    writeMedia(fixture.mediaRoot, 'german/renamed.mp4', CONTENT);
    const profile = ensureProfile(fixture.handle);
    const second = createVideo(fixture.handle, {
      profileId: profile.id,
      sourceType: 'local_media',
      url: 'german/renamed.mp4',
      mediaPath: 'german/renamed.mp4',
      targetLanguage: 'de',
    });

    fixture.videoId = second.id;
    const result = await run(fixture);

    expect(result.duplicateOfVideoId).toBe(originalId);
    // One video, pointed at where the file actually is now. A rename must not become a
    // second library entry, and must not orphan the first.
    expect(listVideos(fixture.handle, { profileId: profile.id }).videos).toHaveLength(1);
    expect(getVideo(fixture.handle, originalId)!.mediaPath).toBe('german/renamed.mp4');
    expect(getVideo(fixture.handle, second.id)).toBeNull();
    // And the name the clients show follows it. `url` is the display fallback for a video
    // with no title, so leaving it behind makes `/videos` name one file while `/library`
    // names another — which is how somebody tidying up duplicates deletes the wrong one.
    expect(getVideo(fixture.handle, originalId)!.url).toBe('german/renamed.mp4');
  });
});

describe('repair verification', () => {
  it('refuses a different file, naming both hashes', async () => {
    fixture = setup();
    await run(fixture);

    // The user points the video at something else — a re-encode, or the wrong file.
    writeMedia(fixture.mediaRoot, 'german/folge-1.mp4', 'entirely different bytes');

    await expect(run(fixture, { transcribe: false })).rejects.toMatchObject({
      code: 'MEDIA_CONTENT_MISMATCH',
      statusCode: 409,
      details: { expected: sha(CONTENT), actual: sha('entirely different bytes') },
    });
  });

  it('leaves the video as it was, rather than half-repaired', async () => {
    fixture = setup();
    await run(fixture);
    writeMedia(fixture.mediaRoot, 'german/folge-1.mp4', 'entirely different bytes');

    await run(fixture, { transcribe: false }).catch(() => undefined);

    const video = getVideo(fixture.handle, fixture.videoId)!;
    // The state after a refused repair is the state before it: still missing, still
    // pointing nowhere, still holding its identity and its transcript.
    expect(video.mediaMissing).toBe(true);
    expect(video.mediaPath).toBeNull();
    expect(video.externalVideoId).toBe(sha(CONTENT));
  });

  it('accepts the identical file, because re-running the job is not a repair', async () => {
    fixture = setup();
    await run(fixture);
    // Idempotency: hashing the same bytes gives the same answer, so a retry after a crash
    // must not look like someone swapping the file.
    const again = await run(fixture);
    expect(again.contentHash).toBe(sha(CONTENT));
  });
});
