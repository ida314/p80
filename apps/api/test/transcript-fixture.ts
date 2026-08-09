import { newId } from '@p80/core';
import {
  insertTranscriptFile,
  replaceSegments,
  setProcessingStatus,
  setTranscriptStatus,
  type SegmentInput,
} from '@p80/database';
import type { TestApi } from './helpers.js';

/**
 * Puts a video into the state the worker leaves it in, without running the worker.
 *
 * Phase 6's handler is what produces this state in the application; seeding it here keeps
 * the read and correction tests about reading and correcting rather than about job
 * scheduling, which `apps/worker/test/parse-transcript.test.ts` covers on its own.
 */
let seeded = 1;

export async function seedReadyTranscript(
  api: TestApi,
  segments: readonly SegmentInput[],
  options: { mediaPath?: string; title?: string } = {},
): Promise<string> {
  // A real file under the test's media root, because `POST /api/videos` checks existence
  // (ADR 0015). It is never decoded — nothing in these tests plays anything.
  //
  // The default is per-call unique. Adding the same path twice is a 409 by design, and a
  // test that seeds two transcripts is not testing that.
  const path = api.writeMedia(options.mediaPath ?? `german/folge-${seeded++}.mp4`);
  const created = await api.server.app.inject({
    method: 'POST',
    url: '/api/videos',
    payload: { path, title: options.title ?? 'Folge 1' },
  });
  const videoId = created.json().video.id as string;

  insertTranscriptFile(api.server.handle, {
    id: newId(),
    videoId,
    format: 'vtt',
    originalFilename: 'folge-1.vtt',
    storagePath: `${api.config.P80_STORAGE_PATH}/transcripts/${videoId}/seed.vtt`,
    checksum: newId().toLowerCase(),
    parserVersion: '1',
  });
  replaceSegments(api.server.handle, videoId, segments);
  setTranscriptStatus(api.server.handle, videoId, 'parsing');
  setTranscriptStatus(api.server.handle, videoId, 'ready');
  setProcessingStatus(api.server.handle, videoId, 'transcript_ready');

  return videoId;
}

export const segment = (
  sequenceIndex: number,
  startMs: number,
  endMs: number,
  rawText: string,
): SegmentInput => ({
  startMs,
  endMs,
  speakerLabel: null,
  rawText,
  normalizedText: rawText,
  sequenceIndex,
});
