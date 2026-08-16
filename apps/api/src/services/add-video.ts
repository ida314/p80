import {
  ERROR_CODES,
  INGEST_MEDIA_JOB_VERSION,
  P80Error,
  type VideoAcceptedPayload,
} from '@p80/core';
import {
  createVideo,
  enqueueJob,
  findByMediaPath,
  setVideoInterests,
  type DatabaseHandle,
} from '@p80/database';
import { toVideoPayload } from './video-payload.js';

/**
 * Turning a path that exists into a video that is ingesting.
 *
 * Extracted so that `POST /api/videos` and `POST /api/uploads/:id/complete` cannot drift.
 * They arrive at this point by very different routes — one was handed a path the user
 * typed, the other has just finished writing a file — but from here the work is identical,
 * and it is work with three ordering constraints that are not obvious from the outside:
 * the duplicate check has to precede the insert to produce a useful message, the interests
 * have to be linked before the job is enqueued or a fast worker can read a video with none,
 * and the job has to be the last thing so a failure anywhere above it does not leave a job
 * pointing at a row that was never finished.
 *
 * Two copies of that would agree today and disagree the first time one of them changed.
 *
 * **`externalVideoId` is deliberately not passed.** The row gets a `pending:<id>` sentinel
 * and `INGEST_MEDIA` fills in the content hash after streaming the file (ADR 0018), which
 * is why a duplicate under a *different* name is caught in the worker rather than here.
 * What this catches is the boring duplicate — the same path added twice — which is worth
 * catching early because the alternative is minutes of hashing and transcription before
 * the result is discarded.
 */
export function addVideoFromPath(
  handle: DatabaseHandle,
  input: {
    profileId: string;
    targetLanguage: string;
    /** Media-root-relative, already validated for containment and existence. */
    relativePath: string;
    title?: string | null;
    speakerLabel?: string | null;
    regionLabel?: string | null;
    interests?: Array<{ interestId: string; relevance: number }>;
    /** False skips the `TRANSCRIBE` enqueue and nothing else — the hash and the duration
     *  still happen, so the video is usable and can be transcribed later (ADR 0024 §2). */
    transcribe: boolean;
  },
): VideoAcceptedPayload {
  const already = findByMediaPath(handle, input.profileId, input.relativePath);
  if (already !== null) {
    throw P80Error.conflict(
      ERROR_CODES.DUPLICATE_VIDEO,
      'You have already added this file.',
      { videoId: already.id, path: input.relativePath },
    );
  }

  const video = createVideo(handle, {
    profileId: input.profileId,
    sourceType: 'local_media',
    url: input.relativePath,
    mediaPath: input.relativePath,
    title: input.title ?? null,
    targetLanguage: input.targetLanguage,
    speakerLabel: input.speakerLabel ?? null,
    regionLabel: input.regionLabel ?? null,
  });

  if (input.interests !== undefined && input.interests.length > 0) {
    setVideoInterests(handle, video.id, input.interests);
  }

  const job = enqueueJob(handle, 'INGEST_MEDIA', {
    entityType: 'video',
    entityId: video.id,
    input: {
      jobVersion: INGEST_MEDIA_JOB_VERSION,
      videoId: video.id,
      transcribe: input.transcribe,
    },
  });

  return {
    video: toVideoPayload(handle, video),
    jobId: job.id,
    status: 'pending' as const,
  };
}
