import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INGEST_MEDIA_JOB_VERSION,
  TRANSCRIBE_JOB_VERSION,
  createLogger,
  loadConfig,
  type Config,
  type JobRecord,
} from '@p80/core';
import {
  createVideo,
  ensureProfile,
  enqueueJob,
  migrate,
  openDatabase,
  writeSetting,
  type DatabaseHandle,
} from '@p80/database';
import type { AsrProvider, AsrRequest } from '@p80/providers';
import { createIngestMediaHandler } from '../src/handlers/ingest-media.js';
import { createTranscribeHandler } from '../src/handlers/transcribe.js';

/**
 * Stage 2b exit criteria 5 and 8 (ADR 0019).
 *
 * The worker half of the live-tier property. The API test proves a root change is visible
 * to the *next request*; this proves it is visible to the *next job*, in a handler built
 * before the change happened.
 *
 * That distinction is the whole reason nothing caches the root. A worker holding the value
 * it booted with would resolve a path the API had just validated against a different root
 * — the temporal form of the bug ADR 0012 records, where two processes disagreed about
 * where the database was and nothing errored.
 */

interface Fixture {
  handle: DatabaseHandle;
  config: Config;
  videoId: string;
  bootRoot: string;
  otherRoot: string;
  dispose(): void;
}

let fixture: Fixture | undefined;
afterEach(() => {
  fixture?.dispose();
  fixture = undefined;
});

/**
 * A video whose file exists **only** under `otherRoot`. Under the root the worker booted
 * with, it is missing — so any handler that finds the bytes can only have re-read the
 * setting.
 */
function setup(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), 'p80-settings-worker-'));
  const bootRoot = join(dir, 'media');
  const otherRoot = join(dir, 'other-library');
  mkdirSync(bootRoot, { recursive: true });

  const config = loadConfig({
    P80_DB_PATH: join(dir, 'p80.db'),
    P80_STORAGE_PATH: join(dir, 'storage'),
    P80_MEDIA_ROOT: bootRoot,
    P80_LOG_LEVEL: 'silent',
  });
  const handle = openDatabase(config.P80_DB_PATH);
  migrate(handle.sqlite);

  const media = join(otherRoot, 'german/folge-1.mp4');
  mkdirSync(dirname(media), { recursive: true });
  writeFileSync(media, 'bytes that exist in exactly one of the two libraries');

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
    bootRoot,
    otherRoot,
    dispose() {
      handle.sqlite.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function context(f: Fixture, job: unknown) {
  return {
    handle: f.handle,
    logger: createLogger('worker-test', 'silent'),
    job: job as JobRecord,
    isCancelled: () => false,
  };
}

describe('INGEST_MEDIA', () => {
  it('resolves against the stored media root, not the one it booted with', async () => {
    fixture = setup();
    // Built first, deliberately — before the setting exists. A handler that captured the
    // root at construction would fail the second run below.
    const handler = createIngestMediaHandler({ config: fixture.config });

    const enqueue = () =>
      enqueueJob(fixture!.handle, 'INGEST_MEDIA', {
        entityType: 'video',
        entityId: fixture!.videoId,
        input: {
          jobVersion: INGEST_MEDIA_JOB_VERSION,
          videoId: fixture!.videoId,
          transcribe: false,
        },
      });

    const before = (await handler(context(fixture, enqueue()))) as Record<string, unknown>;
    expect(before.skipped).toBe('media_missing');

    writeSetting(fixture.handle, 'P80_MEDIA_ROOT', fixture.otherRoot);

    const after = (await handler(context(fixture, enqueue()))) as Record<string, unknown>;
    expect(after.skipped).toBeNull();
    expect(after.contentHash).toEqual(expect.any(String));
  });
});

describe('TRANSCRIBE', () => {
  it('sends the stored ASR options with the request', async () => {
    fixture = setup();
    writeSetting(fixture.handle, 'P80_MEDIA_ROOT', fixture.otherRoot);
    // The setting whose whole purpose is being changeable for one run without a restart.
    writeSetting(fixture.handle, 'P80_ASR_REQUIRE_GPU', false);
    writeSetting(fixture.handle, 'P80_ASR_MODEL', 'medium');

    const seen: AsrRequest[] = [];
    const asr: AsrProvider = {
      name: 'stub',
      modelId: 'medium',
      alignmentModelId: null,
      async transcribe(request) {
        seen.push(request);
        return {
          words: [{ text: 'Hallo', startMs: 0, endMs: 400, confidence: 0.9 }],
          detectedLanguage: 'de',
          languageProbability: 0.99,
          durationMs: 400,
          warnings: [],
        };
      },
    };

    const handler = createTranscribeHandler({ config: fixture.config, asr });
    const job = enqueueJob(fixture.handle, 'TRANSCRIBE', {
      entityType: 'video',
      entityId: fixture.videoId,
      input: {
        jobVersion: TRANSCRIBE_JOB_VERSION,
        videoId: fixture.videoId,
        language: 'de',
      },
    });
    await handler(context(fixture, job));

    expect(seen).toHaveLength(1);
    // Resolved from the database, not from this process's environment — which is what
    // makes them editable without restarting the worker or the sidecar.
    expect(seen[0]?.options).toEqual({
      model: 'medium',
      device: 'cuda',
      computeType: 'float16',
      requireGpu: false,
      align: true,
      languageMinProbability: 0.5,
      conditionOnPreviousText: false,
    });
    // And the path came from the stored root, or the media would not have been found.
    expect(seen[0]?.mediaPath.startsWith(fixture.otherRoot)).toBe(true);
  });
});
