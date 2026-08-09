import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ERROR_CODES,
  P80Error,
  TRANSCRIBE_JOB_VERSION,
  createLogger,
  loadConfig,
  newId,
  type Config,
  type JobRecord,
} from '@p80/core';
import {
  countSegments,
  countWords,
  createVideo,
  ensureProfile,
  enqueueJob,
  getLatestTranscriptFile,
  getVideo,
  insertTranscriptFile,
  listSegmentsWithCorrections,
  listWords,
  migrate,
  openDatabase,
  type DatabaseHandle,
} from '@p80/database';
import type { AsrProvider, AsrResult } from '@p80/providers';
import { createTranscribeHandler } from '../src/handlers/transcribe.js';

/**
 * `TRANSCRIBE` — ADR 0016 and 0017.
 *
 * The ASR provider is stubbed. What is under test is not the model — it is everything
 * around it: that a refusal stays a refusal rather than becoming an empty transcript, that
 * an uploaded transcript wins, and that the word array and the segments that index it are
 * written together or not at all.
 */

const WORDS = [
  { text: 'Ich', startMs: 0, endMs: 300, confidence: 0.95 },
  { text: 'fange', startMs: 320, endMs: 700, confidence: 0.9 },
  { text: 'an.', startMs: 720, endMs: 950, confidence: 0.88 },
  { text: 'Wie', startMs: 2_000, endMs: 2_200, confidence: 0.92 },
  { text: 'geht', startMs: 2_220, endMs: 2_450, confidence: 0.91 },
  { text: 'es?', startMs: 2_470, endMs: 2_700, confidence: 0.87 },
];

function stubAsr(overrides: Partial<AsrResult> = {}, fail?: Error): AsrProvider {
  return {
    name: 'stub',
    modelId: 'large-v3',
    alignmentModelId: 'wav2vec2-de',
    async transcribe() {
      if (fail) throw fail;
      return {
        words: WORDS,
        detectedLanguage: 'de',
        languageProbability: 0.99,
        durationMs: 3_000,
        warnings: [],
        ...overrides,
      };
    },
  };
}

interface Fixture {
  handle: DatabaseHandle;
  config: Config;
  videoId: string;
  dispose(): void;
}

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});

function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'p80-transcribe-'));
  const config = loadConfig({
    P80_DB_PATH: join(dir, 'p80.db'),
    P80_STORAGE_PATH: join(dir, 'storage'),
    P80_MEDIA_ROOT: join(dir, 'media'),
    P80_LOG_LEVEL: 'silent',
  });
  const handle = openDatabase(config.P80_DB_PATH);
  migrate(handle.sqlite);

  const media = join(config.P80_MEDIA_ROOT, 'german/folge-1.mp4');
  mkdirSync(dirname(media), { recursive: true });
  writeFileSync(media, 'bytes');

  const profile = ensureProfile(handle);
  const video = createVideo(handle, {
    profileId: profile.id,
    sourceType: 'local_media',
    url: 'german/folge-1.mp4',
    mediaPath: 'german/folge-1.mp4',
    targetLanguage: 'de',
  });

  return {
    handle,
    config,
    videoId: video.id,
    dispose() {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function run(f: Fixture, asr: AsrProvider) {
  const handler = createTranscribeHandler({ config: f.config, asr });
  const job = enqueueJob(f.handle, 'TRANSCRIBE', {
    entityType: 'video',
    entityId: f.videoId,
    input: { jobVersion: TRANSCRIBE_JOB_VERSION, videoId: f.videoId, language: 'de' },
  });
  return (await handler({
    handle: f.handle,
    logger: createLogger('worker-test', 'silent'),
    job: job as JobRecord,
    isCancelled: () => false,
  })) as Record<string, unknown>;
}

describe('a successful run', () => {
  it('writes the word array as the source of truth', async () => {
    fixture = setup();
    const result = await run(fixture, stubAsr());

    expect(result.wordCount).toBe(WORDS.length);
    const file = getLatestTranscriptFile(fixture.handle, fixture.videoId)!;
    expect(countWords(fixture.handle, file.id)).toBe(WORDS.length);

    const stored = listWords(fixture.handle, file.id);
    expect(stored.map((w) => w.text)).toEqual(WORDS.map((w) => w.text));
    // Timings survive unrounded. A card that replays a single word aims at these numbers.
    expect(stored[1]).toMatchObject({ startMs: 320, endMs: 700, wordIndex: 1 });
  });

  it('writes segments that are index ranges over the words, not a second copy', async () => {
    fixture = setup();
    await run(fixture, stubAsr());

    const { segments } = listSegmentsWithCorrections(fixture.handle, fixture.videoId, {
      limit: 100,
      cursor: null,
      includeCorrections: true,
    });

    expect(segments.length).toBeGreaterThan(0);
    for (const segment of segments) {
      expect(segment.wordStartIndex).not.toBeNull();
      expect(segment.wordEndIndex).not.toBeNull();
    }
    // The ranges tile the array exactly — a hole is a word no segment addresses.
    expect(segments[0]!.wordStartIndex).toBe(0);
    expect(segments[segments.length - 1]!.wordEndIndex).toBe(WORDS.length);
  });

  it('records provenance so the transcript is attributable and recomputable', async () => {
    fixture = setup();
    await run(fixture, stubAsr());

    const file = getLatestTranscriptFile(fixture.handle, fixture.videoId)!;
    expect(file).toMatchObject({
      source: 'asr',
      timingGranularity: 'word',
      asrModelId: 'large-v3',
      asrAlignmentModelId: 'wav2vec2-de',
      detectedLanguage: 'de',
      // There is no uploaded file to point at.
      storagePath: null,
    });
  });

  it('reports a null alignment model rather than implying precision it does not have', async () => {
    fixture = setup();
    const asr = { ...stubAsr(), alignmentModelId: null } as AsrProvider;
    const result = await run(fixture, asr);

    // Whisper's own attention weights are less precise than forced alignment. Recording
    // which was used is what keeps the two distinguishable after the fact.
    expect(result.alignmentModelId).toBeNull();
    expect(getLatestTranscriptFile(fixture.handle, fixture.videoId)!.asrAlignmentModelId).toBeNull();
  });

  it('leaves the video ready and its media not missing', async () => {
    fixture = setup();
    await run(fixture, stubAsr());

    const video = getVideo(fixture.handle, fixture.videoId)!;
    expect(video.transcriptStatus).toBe('ready');
    expect(video.processingStatus).toBe('transcript_ready');
    expect(video.mediaMissing).toBe(false);
  });

  it('stores warnings without dropping anything', async () => {
    fixture = setup();
    const result = await run(
      fixture,
      stubAsr({
        warnings: [
          { kind: 'low_asr_confidence', segmentIndex: 0, message: 'low-confidence region' },
          { kind: 'unaligned_words', segmentIndex: null, message: '2 words had no timestamp' },
        ],
      }),
    );

    expect(result.warningCount).toBe(2);
    expect(result.warningsByKind).toMatchObject({ low_asr_confidence: 1, unaligned_words: 1 });
    // §14.2: a warning never causes a row to be dropped.
    expect(countWords(fixture.handle, getLatestTranscriptFile(fixture.handle, fixture.videoId)!.id)).toBe(
      WORDS.length,
    );
  });

  it('is idempotent — a retry produces one transcript, not two', async () => {
    fixture = setup();
    await run(fixture, stubAsr());
    const first = countSegments(fixture.handle, fixture.videoId);

    await run(fixture, stubAsr());

    // `replaceWords` and `replaceSegments` both delete-then-insert. An insert-only handler
    // would trip the unique constraints on every retry.
    expect(countSegments(fixture.handle, fixture.videoId)).toBe(first);
  });
});

describe('an uploaded transcript always wins (ADR 0016 §1)', () => {
  it('discards the ASR run before paying for it', async () => {
    fixture = setup();
    insertTranscriptFile(fixture.handle, {
      id: newId(),
      videoId: fixture.videoId,
      format: 'vtt',
      originalFilename: 'folge-1.vtt',
      storagePath: '/tmp/whatever.vtt',
      checksum: 'abc',
      parserVersion: '1',
      source: 'upload',
    });

    let called = false;
    const asr: AsrProvider = {
      ...stubAsr(),
      async transcribe() {
        called = true;
        throw new Error('should never run');
      },
    };

    const result = await run(fixture, asr);

    // Checked before the expensive part. Spending four minutes on a transcript that is
    // going to be thrown away only shows up as a slow machine.
    expect(called).toBe(false);
    expect(result.skipped).toBe('upload_won');
  });

  it('succeeds rather than failing, because nothing went wrong', async () => {
    fixture = setup();
    insertTranscriptFile(fixture.handle, {
      id: newId(),
      videoId: fixture.videoId,
      format: 'vtt',
      originalFilename: 'folge-1.vtt',
      storagePath: '/tmp/whatever.vtt',
      checksum: 'abc',
      parserVersion: '1',
      source: 'upload',
    });

    const result = await run(fixture, stubAsr());
    // The user got what they asked for. A failed job here would be reporting their own
    // choice back to them as an error.
    expect(result.skipped).toBe('upload_won');
    expect(result.transcriptFileId).toBeNull();
  });
});

describe('failure is preserved, never fabricated (§27.4)', () => {
  it('marks the transcript failed when the sidecar is unavailable', async () => {
    fixture = setup();
    const unavailable = new P80Error(ERROR_CODES.ASR_UNAVAILABLE, 'no model', {
      statusCode: 503,
    });

    await expect(run(fixture, stubAsr({}, unavailable))).rejects.toMatchObject({
      code: 'ASR_UNAVAILABLE',
    });

    // `failed`, not a silent revert to `none`: the user asked for a transcript and is
    // entitled to see that the attempt happened and did not work. The upload path is still
    // open, which is what the UI offers next.
    expect(getVideo(fixture.handle, fixture.videoId)!.transcriptStatus).toBe('failed');
  });

  it('writes no transcript at all when the run fails', async () => {
    fixture = setup();
    await run(fixture, stubAsr({}, new Error('boom'))).catch(() => undefined);

    // An empty transcript is indistinguishable from a silent video, and the difference
    // decides whether the user goes looking for a subtitle file or for a bug.
    expect(getLatestTranscriptFile(fixture.handle, fixture.videoId)).toBeNull();
    expect(countSegments(fixture.handle, fixture.videoId)).toBe(0);
  });

  it('refuses to write an empty word array as a transcript', async () => {
    fixture = setup();
    // The provider returning nothing is not a transcript of silence — it is a failure to
    // transcribe, and it must not be stored as a success.
    await expect(run(fixture, stubAsr({ words: [] }))).rejects.toBeTruthy();
    expect(getLatestTranscriptFile(fixture.handle, fixture.videoId)).toBeNull();
  });

  it('succeeds as a no-op when the video was deleted under it', async () => {
    fixture = setup();
    fixture.handle.sqlite.prepare('DELETE FROM videos WHERE id = ?').run(fixture.videoId);

    const result = await run(fixture, stubAsr());
    expect(result.skipped).toBe('video_deleted');
  });

  it('refuses to read media outside the media root', async () => {
    fixture = setup();
    fixture.handle.sqlite
      .prepare('UPDATE videos SET media_path = ? WHERE id = ?')
      .run('../../etc/passwd.mp4', fixture.videoId);

    // Only reachable via a hand-edited row. It costs one string comparison and it is the
    // difference between that mistake being a failed job and being an arbitrary file read.
    await expect(run(fixture, stubAsr())).rejects.toThrow(/media root/);
  });
});
