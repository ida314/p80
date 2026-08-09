import { createReadStream, statSync } from 'node:fs';
import { z } from 'zod';
import {
  ERROR_CODES,
  INGEST_MEDIA_JOB_VERSION,
  MEDIA_PATH_MESSAGES,
  P80Error,
  SUPPORTED_MEDIA_EXTENSIONS,
  assertInsideMediaRoot,
  resolveMediaPath,
  videoAcceptedResponse,
  type Config,
} from '@p80/core';
import { enqueueJob, setMediaLocation, type DatabaseHandle } from '@p80/database';
import type { App } from '../app.js';
import { toVideoPayload } from '../services/video-payload.js';
import { requireVideo } from './videos.js';

/**
 * `GET /api/videos/:id/media` — the one route in P80 that reads media bytes (ADR 0015).
 *
 * Four properties, each of which is a rule rather than a preference:
 *
 * - **It resolves under `P80_MEDIA_ROOT` and refuses anything outside** (`CLAUDE.md` rule
 *   4). The path in the row was validated on the way in; this is the read-side half, and
 *   it is what stands between a hand-edited database row and an arbitrary file read.
 * - **It supports Range**, because a `<video>` element cannot seek without it. A browser
 *   asked to play a two-hour file over a 200 response downloads the whole thing before
 *   the user can jump to the middle.
 * - **It streams.** Media files are gigabytes; nothing here buffers one.
 * - **It produces no copy** (rule 3). A missing file is a 404 that marks the video for
 *   repair, never a cached duplicate.
 *
 * This route sends bytes rather than JSON, which makes it the one exception to `03-api.md`
 * §1's envelope on the success path. Errors still use the envelope.
 */
export async function registerMediaRoutes(
  app: App,
  deps: { handle: DatabaseHandle; config: Config },
): Promise<void> {
  const { handle, config } = deps;

  app.get(
    '/api/videos/:id/media',
    { schema: { params: z.object({ id: z.string().min(1) }) } },
    async (request, reply) => {
      const video = requireVideo(handle, request.params.id);

      if (video.mediaPath === null) {
        throw new P80Error(
          ERROR_CODES.MEDIA_FILE_NOT_FOUND,
          'This video has no media file associated with it.',
          { statusCode: 404 },
        );
      }

      const absolutePath = assertInsideMediaRoot(video.mediaPath, config.P80_MEDIA_ROOT);

      let size: number;
      try {
        size = statSync(absolutePath).size;
      } catch {
        // Recording it here means the Videos list shows the repair affordance on the next
        // load, rather than the user discovering it one video at a time by clicking play.
        setMediaLocation(handle, video.id, { mediaMissing: true });
        throw new P80Error(
          ERROR_CODES.MEDIA_FILE_NOT_FOUND,
          'The media file has moved or been deleted. Point this video at its new location to restore playback; the transcript and everything built on it are unaffected.',
          { statusCode: 404, details: { videoId: video.id } },
        );
      }

      // The file is here after all. A video marked missing and then successfully read is
      // not missing, and leaving the flag set would keep offering a repair nobody needs.
      if (video.mediaMissing) {
        setMediaLocation(handle, video.id, { mediaMissing: false });
      }

      const contentType = mimeTypeFor(video.mediaPath);
      const range = parseRange(request.headers.range, size);

      if (range === 'unsatisfiable') {
        return reply
          .status(416)
          .header('content-range', `bytes */${size}`)
          .header('accept-ranges', 'bytes')
          .send();
      }

      if (range === null) {
        return reply
          .status(200)
          .header('content-type', contentType)
          .header('content-length', String(size))
          .header('accept-ranges', 'bytes')
          // Local media is a file the user controls. A cache that survived them replacing
          // it would show the old video with the new transcript, which is worse than a
          // re-read that costs nothing on a local disk.
          .header('cache-control', 'no-store')
          .send(createReadStream(absolutePath));
      }

      return reply
        .status(206)
        .header('content-type', contentType)
        .header('content-length', String(range.end - range.start + 1))
        .header('content-range', `bytes ${range.start}-${range.end}/${size}`)
        .header('accept-ranges', 'bytes')
        .header('cache-control', 'no-store')
        .send(createReadStream(absolutePath, { start: range.start, end: range.end }));
    },
  );

  /**
   * `POST /api/videos/:id/media/repair` — re-point a video whose file moved.
   *
   * The route validates the path and enqueues; **the hash check happens in the worker**,
   * because that is where the bytes are read and a multi-gigabyte hash does not belong on
   * a request. A file whose content differs fails that job with `MEDIA_CONTENT_MISMATCH`
   * and leaves the video marked missing, so a refused repair is a no-op rather than a
   * half-applied one.
   *
   * `transcribe: false` is the whole reason this is not just another add. The transcript
   * survives a moved file — that is the point of ADR 0018 — and re-transcribing would
   * destroy the corrections the user has made to it.
   */
  app.post(
    '/api/videos/:id/media/repair',
    {
      schema: {
        params: z.object({ id: z.string().min(1) }),
        body: z.object({ path: z.string().trim().min(1).max(1024) }),
        response: { 202: videoAcceptedResponse },
      },
    },
    async (request, reply) => {
      const video = requireVideo(handle, request.params.id);
      const resolved = requireMediaPath(request.body.path, config.P80_MEDIA_ROOT);
      requireExists(resolved.absolutePath, request.body.path);

      const updated = setMediaLocation(handle, video.id, {
        mediaPath: resolved.relativePath,
        mediaMissing: false,
      });
      const job = enqueueJob(handle, 'INGEST_MEDIA', {
        entityType: 'video',
        entityId: video.id,
        input: {
          jobVersion: INGEST_MEDIA_JOB_VERSION,
          videoId: video.id,
          transcribe: false,
        },
      });

      return reply.status(202).send({
        video: toVideoPayload(handle, updated),
        jobId: job.id,
        status: 'pending' as const,
      });
    },
  );
}

/**
 * Validate a user-supplied path, or throw the envelope.
 *
 * Shared by add and repair, because they ask the identical question and two copies of a
 * containment check is one copy too many — the second one is where the `..` case gets
 * forgotten.
 */
export function requireMediaPath(
  input: string,
  mediaRoot: string,
): { relativePath: string; absolutePath: string } {
  const resolved = resolveMediaPath(input, mediaRoot);
  if (!resolved.ok) {
    throw new P80Error(
      ERROR_CODES.INVALID_MEDIA_PATH,
      MEDIA_PATH_MESSAGES[resolved.reason],
      { statusCode: 400, details: { reason: resolved.reason } },
    );
  }
  return { relativePath: resolved.relativePath, absolutePath: resolved.absolutePath };
}

/**
 * Existence is checked here; everything else about the file is the job's business.
 *
 * A path to nothing is a typo, and telling the user immediately is worth one `statSync`.
 * Reading the file is not: hashing and probing take seconds on a large file and belong in
 * a job that has somewhere to report progress.
 *
 * The message echoes the **relative** path the caller sent, never the resolved absolute
 * one — a client that supplied `lektion-3.mp4` has no business learning where the media
 * root lives.
 */
export function requireExists(absolutePath: string, relativePath: string): void {
  try {
    if (statSync(absolutePath).isFile()) return;
  } catch {
    // Fall through to the same answer: a directory and a missing file are both "there is
    // no media here", and distinguishing them tells a caller about the filesystem.
  }
  throw new P80Error(
    ERROR_CODES.MEDIA_FILE_NOT_FOUND,
    `No media file at ${relativePath} inside the media library.`,
    { statusCode: 404, details: { path: relativePath } },
  );
}

/**
 * A closed map keyed on the stored extension, which was itself chosen from a closed list
 * on the way in (`SUPPORTED_MEDIA_EXTENSIONS`).
 *
 * Never sniffed from the file's own bytes, and never taken from a user-supplied header: a
 * content type is something a browser acts on, and letting an untrusted value choose it is
 * how a video endpoint starts serving `text/html`.
 */
const MIME_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
};

function mimeTypeFor(path: string): string {
  const lower = path.toLowerCase();
  const ext = SUPPORTED_MEDIA_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  return (ext && MIME_TYPES[ext]) ?? 'application/octet-stream';
}

/**
 * Parse a single byte range, or say the request cannot be served.
 *
 * Only one range, deliberately. Multi-range responses need `multipart/byteranges`, no
 * browser video element asks for one, and implementing a format nothing requests is
 * surface with no user. A multi-range header is treated as no range, which is a valid and
 * complete response.
 *
 * `null` means "send the whole file". `'unsatisfiable'` means the client asked for bytes
 * past the end, which is a 416 — silently clamping it would make a seek past the end look
 * like a seek to the end.
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null | 'unsatisfiable' {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  // A suffix range — `bytes=-500` means the *last* 500 bytes, not the first 500. Getting
  // this backwards produces a player that works until someone seeks to the end.
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return 'unsatisfiable';

  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isFinite(end) || end < start) return 'unsatisfiable';

  return { start, end };
}
