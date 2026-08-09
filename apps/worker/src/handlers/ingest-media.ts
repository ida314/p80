import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  ERROR_CODES,
  INGEST_MEDIA_JOB_VERSION,
  P80Error,
  TRANSCRIBE_JOB_VERSION,
  assertInsideMediaRoot,
  ingestMediaInput,
  type Config,
  type IngestMediaOutput,
} from '@p80/core';
import {
  deleteVideo,
  enqueueJob,
  ensureProfile,
  findByExternalId,
  getVideo,
  isPendingIdentity,
  setMediaIdentity,
  setMediaLocation,
} from '@p80/database';
import type { JobContext, JobHandler } from '../registry.js';

const run = promisify(execFile);

/**
 * `INGEST_MEDIA` — read the referenced file and record what it is (ADR 0015, 0018).
 *
 * This is the first thing that happens to a video, and the only place P80 turns a path
 * into an identity. It does three things in order — hash, measure, hand off — and each is
 * separable so a retry after a partial failure repeats work rather than skipping it.
 *
 * **Idempotent.** Hashing the same bytes gives the same hash, and `setMediaIdentity`
 * refuses to change a hash that is already real, so a re-run either fills in the same
 * values or no-ops. The `TRANSCRIBE` enqueue is the one non-idempotent step, and it is
 * guarded by checking for an existing transcript first.
 *
 * **No media is copied** (`CLAUDE.md` rule 3). The file is read as a stream and nothing is
 * written back — not a hash cache, not a thumbnail, not a decoded track.
 */
export function createIngestMediaHandler(deps: { config: Config }): JobHandler {
  return async (ctx: JobContext): Promise<IngestMediaOutput> => {
    const input = ingestMediaInput.parse(ctx.job.inputJson);
    const video = getVideo(ctx.handle, input.videoId);

    if (video === null) {
      ctx.logger.info(
        { jobId: ctx.job.id, videoId: input.videoId },
        'video deleted while ingest was queued; nothing to do',
      );
      return skipped(input.videoId, 'video_deleted');
    }

    // A hand-edited row cannot make the worker read outside the media root. The path was
    // validated on the way in; this is the read-side half of the same check.
    const absolutePath = assertInsideMediaRoot(
      video.mediaPath ?? '',
      deps.config.P80_MEDIA_ROOT,
    );

    let bytes: number;
    try {
      bytes = statSync(absolutePath).size;
    } catch {
      // Not a job failure. A file that moved between the add and the job is exactly the
      // repairable broken link ADR 0018 §3 designs for, and marking it is more useful to
      // the user than a red job with a stack trace.
      setMediaLocation(ctx.handle, video.id, { mediaMissing: true });
      ctx.logger.warn({ videoId: video.id }, 'media file is missing; marked for repair');
      return skipped(video.id, 'media_missing');
    }

    const contentHash = await hashFile(absolutePath, ctx);

    /**
     * The repair verification (ADR 0018 §3).
     *
     * A video that already has a real hash is being re-pointed, and the new file must be
     * the same content. Accepting different bytes would silently rebind a transcript — and
     * every occurrence, card, and review built on it — to audio it does not match, which
     * is the single failure this whole identity design exists to prevent.
     *
     * The video is left marked missing rather than pointed at the wrong file, so the state
     * after a refused repair is the state before it.
     */
    if (!isPendingIdentity(video.externalVideoId) && video.externalVideoId !== contentHash) {
      setMediaLocation(ctx.handle, video.id, { mediaPath: null, mediaMissing: true });
      throw P80Error.conflict(
        ERROR_CODES.MEDIA_CONTENT_MISMATCH,
        'That file is not the same video. Its contents differ from the one this transcript was built from, so pointing at it would leave the transcript describing different audio.',
        { videoId: video.id, expected: video.externalVideoId, actual: contentHash },
      );
    }

    // ADR 0018 §1: the same file added twice under two names is one video. Detected here
    // rather than at the API because the API has not read the bytes yet.
    const existing = findByExternalId(
      ctx.handle,
      video.profileId,
      'local_media',
      contentHash,
    );
    if (existing !== null && existing.id !== video.id) {
      // The duplicate row carries nothing yet — no transcript, no items — so deleting it
      // destroys nothing. Re-pointing the *original* at this path is the useful side
      // effect: adding a file under its new name after a rename repairs the old entry.
      setMediaLocation(ctx.handle, existing.id, {
        mediaPath: video.mediaPath,
        mediaMissing: false,
      });
      deleteVideo(ctx.handle, video.id);
      ctx.logger.info(
        { videoId: video.id, duplicateOf: existing.id },
        'content hash matches an existing video; re-pointed it and dropped the duplicate',
      );
      return {
        ...skipped(video.id, null),
        contentHash,
        mediaBytes: bytes,
        duplicateOfVideoId: existing.id,
      };
    }

    const durationMs = await probeDurationMs(absolutePath, ctx);
    setMediaIdentity(ctx.handle, video.id, { contentHash, mediaBytes: bytes, durationMs });

    let transcribeJobId: string | null = null;
    if (input.transcribe && video.transcriptStatus === 'none') {
      const profile = ensureProfile(ctx.handle);
      transcribeJobId = enqueueJob(ctx.handle, 'TRANSCRIBE', {
        entityType: 'video',
        entityId: video.id,
        input: {
          jobVersion: TRANSCRIBE_JOB_VERSION,
          videoId: video.id,
          // Pinned now, not read at run time: a profile edited while the job waits must
          // not change what language the audio is decoded as.
          language: profile.targetLanguage,
        },
      }).id;
    }

    return {
      jobVersion: INGEST_MEDIA_JOB_VERSION,
      videoId: video.id,
      contentHash,
      mediaBytes: bytes,
      durationMs,
      duplicateOfVideoId: null,
      transcribeJobId,
      skipped: null,
    };
  };
}

/**
 * Streamed, in 1 MB chunks, so a 20 GB file costs 1 MB of memory rather than 20 GB.
 *
 * Cancellation is checked per chunk. This is the longest uninterruptible stretch in the
 * job after transcription itself, and a worker shutting down should not have to wait out a
 * full read of a large file.
 */
async function hashFile(path: string, ctx: JobContext): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(path, { highWaterMark: 1024 * 1024 });
  for await (const chunk of stream) {
    if (ctx.isCancelled()) {
      stream.destroy();
      throw new Error('Cancelled while hashing; nothing was changed.');
    }
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}

/**
 * Duration via `ffprobe`, or null.
 *
 * Null rather than a guess, and rather than a failure. A missing duration is a fact the UI
 * can render as unknown; a duration inferred from the transcript's last timestamp would be
 * wrong in a displayed field, which is worse — the transcript's end is not the video's end.
 * The same reasoning `PARSE_TRANSCRIPT` already applies to `lastEndMs`.
 *
 * `execFile`, not `exec`: no shell, so the path cannot be interpreted as a command even
 * though it has already passed containment. Two independent reasons to be safe is the
 * right number for a string that started as user input.
 */
async function probeDurationMs(path: string, ctx: JobContext): Promise<number | null> {
  try {
    const { stdout } = await run(
      'ffprobe',
      [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        path,
      ],
      { timeout: 30_000 },
    );
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
  } catch (error) {
    ctx.logger.warn(
      { err: error },
      'ffprobe unavailable or failed; duration stays unknown',
    );
    return null;
  }
}

function skipped(
  videoId: string,
  reason: IngestMediaOutput['skipped'],
): IngestMediaOutput {
  return {
    jobVersion: INGEST_MEDIA_JOB_VERSION,
    videoId,
    contentHash: '',
    mediaBytes: 0,
    durationMs: null,
    duplicateOfVideoId: null,
    transcribeJobId: null,
    skipped: reason,
  };
}
