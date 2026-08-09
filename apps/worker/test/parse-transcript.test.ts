import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createLogger,
  loadConfig,
  newId,
  transcriptStoragePath,
  type Config,
  type JobRecord,
} from '@p80/core';
import {
  countSegments,
  createVideo,
  deleteTranscript,
  ensureProfile,
  enqueueJob,
  getTranscriptFile,
  getVideo,
  insertCorrection,
  insertTranscriptFile,
  listSegmentsWithCorrections,
  migrate,
  openDatabase,
  setTranscriptStatus,
  type DatabaseHandle,
} from '@p80/database';
import { TRANSCRIPT_PARSER_VERSION } from '@p80/providers';
import { createParseTranscriptHandler } from '../src/handlers/parse-transcript.js';

/**
 * Stage 2 step 10 and exit criteria 1 and 9.
 *
 * The properties under test are the ones §27.3 demands of every job: idempotent, retryable,
 * inspectable, versioned. Idempotency is the one with teeth here, because
 * `UNIQUE (video_id, sequence_index)` turns a naive handler into a job that fails on every
 * retry.
 */

const VTT = `WEBVTT

00:00:01.000 --> 00:00:03.000
Guten Tag.

00:00:03.000 --> 00:00:05.000
Wie geht es Ihnen?
`;

interface Fixture {
  handle: DatabaseHandle;
  config: Config;
  dir: string;
  videoId: string;
  transcriptFileId: string;
  storagePath: string;
  dispose(): void;
}

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});

function setup(content = VTT, options: { corruptChecksum?: boolean } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'p80-worker-'));
  const config = loadConfig({
    P80_DB_PATH: join(dir, 'p80.db'),
    P80_STORAGE_PATH: join(dir, 'storage'),
    P80_MEDIA_ROOT: join(dir, 'media'),
    P80_LOG_LEVEL: 'silent',
  });
  const handle = openDatabase(config.P80_DB_PATH);
  migrate(handle.sqlite);

  const profile = ensureProfile(handle);
  const video = createVideo(handle, {
    profileId: profile.id,
    sourceType: 'local_media',
    externalVideoId: 'a'.repeat(64),
    url: 'german/folge-1.mp4',
    mediaPath: 'german/folge-1.mp4',
    title: 'Folge 1',
    targetLanguage: 'de',
  });

  const transcriptFileId = newId();
  const storagePath = transcriptStoragePath({
    storageRoot: config.P80_STORAGE_PATH,
    videoId: video.id,
    transcriptFileId,
    format: 'vtt',
  });
  mkdirSync(dirname(storagePath), { recursive: true });
  writeFileSync(storagePath, content, 'utf8');

  insertTranscriptFile(handle, {
    id: transcriptFileId,
    videoId: video.id,
    format: 'vtt',
    originalFilename: 'folge-1.vtt',
    storagePath,
    checksum: options.corruptChecksum
      ? 'f'.repeat(64)
      : createHash('sha256').update(content, 'utf8').digest('hex'),
    parserVersion: TRANSCRIPT_PARSER_VERSION,
  });
  setTranscriptStatus(handle, video.id, 'parsing');

  return {
    handle,
    config,
    dir,
    videoId: video.id,
    transcriptFileId,
    storagePath,
    dispose() {
      handle.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function run(
  f: Fixture,
  overrides: Partial<{ allowDiscardCorrections: boolean; transcriptFileId: string }> = {},
  hooks: { isCancelled?: () => boolean } = {},
) {
  const job: JobRecord = enqueueJob(f.handle, 'PARSE_TRANSCRIPT', {
    entityType: 'video',
    entityId: f.videoId,
    maxAttempts: 1,
    input: {
      jobVersion: 1,
      videoId: f.videoId,
      transcriptFileId: overrides.transcriptFileId ?? f.transcriptFileId,
      parserVersion: TRANSCRIPT_PARSER_VERSION,
      allowDiscardCorrections: overrides.allowDiscardCorrections ?? false,
    },
  });

  const handler = createParseTranscriptHandler({ config: f.config });
  return handler({
    handle: f.handle,
    logger: createLogger('worker-test', 'silent'),
    job,
    isCancelled: hooks.isCancelled ?? (() => false),
  });
}

describe('happy path', () => {
  it('writes segments, warnings and both statuses', async () => {
    fixture = setup();
    const output = (await run(fixture)) as Record<string, unknown>;

    expect(output).toMatchObject({
      jobVersion: 1,
      format: 'vtt',
      segmentCount: 2,
      lastEndMs: 5_000,
      skipped: null,
    });

    const video = getVideo(fixture.handle, fixture.videoId);
    expect(video).toMatchObject({
      transcriptStatus: 'ready',
      processingStatus: 'transcript_ready',
      // The transcript's last timestamp is not the video's duration, so this stays null.
      durationMs: null,
    });

    const { segments } = listSegmentsWithCorrections(fixture.handle, fixture.videoId);
    expect(segments.map((s) => [s.startMs, s.endMs, s.rawText])).toEqual([
      [1_000, 3_000, 'Guten Tag.'],
      [3_000, 5_000, 'Wie geht es Ihnen?'],
    ]);
    // Normalization happens here, between parse and insert.
    expect(segments[0]?.normalizedText).toBe('Guten Tag.');

    const file = getTranscriptFile(fixture.handle, fixture.transcriptFileId);
    expect(file?.warnings).toBeInstanceOf(Array);
  });

  it('never puts a filesystem path in the job output', async () => {
    // `GET /api/jobs/:id` returns `outputJson` verbatim, so anything here is published.
    fixture = setup();
    const output = await run(fixture);
    const serialized = JSON.stringify(output);
    expect(serialized).not.toContain(fixture.config.P80_STORAGE_PATH);
    expect(serialized).not.toContain('storagePath');
  });
});

describe('idempotency', () => {
  it('produces an identical segment set when run twice', async () => {
    // A crash after COMMIT but before the job is marked done leaves it `running`;
    // `reclaimStaleJobs` returns it to `pending` and it runs again. An insert-only handler
    // would trip `UNIQUE (video_id, sequence_index)` here on every retry.
    fixture = setup();
    await run(fixture);
    const first = listSegmentsWithCorrections(fixture.handle, fixture.videoId).segments;

    await run(fixture);
    const second = listSegmentsWithCorrections(fixture.handle, fixture.videoId).segments;

    expect(second).toHaveLength(2);
    // Ids are fresh ULIDs on every run, so identity is not the thing being compared.
    const shape = (rows: typeof first) =>
      rows.map((r) => [
        r.sequenceIndex,
        r.startMs,
        r.endMs,
        r.rawText,
        r.normalizedText,
        r.speakerLabel,
      ]);
    expect(shape(second)).toEqual(shape(first));
    expect(countSegments(fixture.handle, fixture.videoId)).toBe(2);
  });
});

describe('failure paths', () => {
  it('marks the transcript failed and keeps the warnings when the file is unusable', async () => {
    fixture = setup(`WEBVTT

this block has no timing line

00:00:05.000 --> 00:00:02.000
Rückwärts.
`);
    await expect(run(fixture)).rejects.toMatchObject({
      code: 'TRANSCRIPT_INVALID_TIMESTAMPS',
    });

    expect(getVideo(fixture.handle, fixture.videoId)?.transcriptStatus).toBe('failed');
    // The user needs to see *why*, not only that it failed.
    const file = getTranscriptFile(fixture.handle, fixture.transcriptFileId);
    expect(file?.warnings.length).toBeGreaterThan(0);
    expect(countSegments(fixture.handle, fixture.videoId)).toBe(0);
  });

  it('refuses a file whose checksum no longer matches, without clearing segments', async () => {
    fixture = setup(VTT);
    await run(fixture);
    expect(countSegments(fixture.handle, fixture.videoId)).toBe(2);

    // Simulate the file being truncated or swapped underneath.
    writeFileSync(fixture.storagePath, 'WEBVTT\n', 'utf8');
    await expect(run(fixture)).rejects.toMatchObject({ code: 'TRANSCRIPT_FILE_CORRUPT' });

    // The previous good segments survive — a corrupt read is not a reason to destroy what
    // already parsed.
    expect(countSegments(fixture.handle, fixture.videoId)).toBe(2);
  });

  it('rejects a payload from a different job version rather than mis-reading it', async () => {
    fixture = setup();
    const job = enqueueJob(fixture.handle, 'PARSE_TRANSCRIPT', {
      entityType: 'video',
      entityId: fixture.videoId,
      maxAttempts: 1,
      input: { jobVersion: 99, videoId: fixture.videoId },
    });
    const handler = createParseTranscriptHandler({ config: fixture.config });
    await expect(
      handler({
        handle: fixture.handle,
        logger: createLogger('worker-test', 'silent'),
        job,
        isCancelled: () => false,
      }),
    ).rejects.toThrow();
  });
});

describe('races and guards', () => {
  it('succeeds as a no-op when the transcript was deleted under it', async () => {
    // Deletion cancels pending jobs, but that loses to a job already claimed. Resurrecting
    // the segments would be the bug, so this is success with nothing to do — not a failure
    // to report.
    fixture = setup();
    deleteTranscript(fixture.handle, fixture.videoId);

    const output = (await run(fixture)) as Record<string, unknown>;
    expect(output).toMatchObject({ skipped: 'file_row_deleted', segmentCount: 0 });
    expect(countSegments(fixture.handle, fixture.videoId)).toBe(0);
  });

  it('refuses to discard corrections it was not told it could discard', async () => {
    fixture = setup();
    await run(fixture);
    const target = listSegmentsWithCorrections(fixture.handle, fixture.videoId).segments[0]!;
    insertCorrection(fixture.handle, {
      videoId: fixture.videoId,
      segmentId: target.id,
      beforeText: target.text,
      afterText: 'Korrigiert.',
      beforeStartMs: target.startMs,
      afterStartMs: target.startMs,
      beforeEndMs: target.endMs,
      afterEndMs: target.endMs,
    });

    // A stale retry must not take the user's hand corrections with it through the cascade.
    await expect(run(fixture)).rejects.toMatchObject({
      code: 'TRANSCRIPT_HAS_CORRECTIONS',
    });
    expect(listSegmentsWithCorrections(fixture.handle, fixture.videoId).segments[0]?.text).toBe(
      'Korrigiert.',
    );
  });

  it('allows the replace path to discard them, because the user was told the cost', async () => {
    fixture = setup();
    await run(fixture);
    const target = listSegmentsWithCorrections(fixture.handle, fixture.videoId).segments[0]!;
    insertCorrection(fixture.handle, {
      videoId: fixture.videoId,
      segmentId: target.id,
      beforeText: target.text,
      afterText: 'Korrigiert.',
      beforeStartMs: target.startMs,
      afterStartMs: target.startMs,
      beforeEndMs: target.endMs,
      afterEndMs: target.endMs,
    });

    await expect(run(fixture, { allowDiscardCorrections: true })).resolves.toMatchObject({
      segmentCount: 2,
    });
  });

  it('writes nothing when cancelled after parsing', async () => {
    fixture = setup();
    await expect(run(fixture, {}, { isCancelled: () => true })).rejects.toThrow(/Cancelled/);
    // The check sits after parsing and before any write, so cancellation never leaves a
    // video half-parsed.
    expect(countSegments(fixture.handle, fixture.videoId)).toBe(0);
    expect(getVideo(fixture.handle, fixture.videoId)?.transcriptStatus).toBe('parsing');
  });

  it('refuses to read outside the storage root', async () => {
    fixture = setup();
    fixture.handle.sqlite
      .prepare('UPDATE transcript_files SET storage_path = ? WHERE id = ?')
      .run('/etc/passwd', fixture.transcriptFileId);

    await expect(run(fixture)).rejects.toThrow(/outside the storage root/);
  });
});
