import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ERROR_CODES,
  MAX_UPLOAD_BYTES,
  P80Error,
  UPLOAD_CHUNK_BYTES,
  safeMediaFilename,
  uploadListResponse,
  uploadDeletedResponse,
  uploadSessionResponse,
  videoAcceptedResponse,
  MEDIA_PATH_MESSAGES,
  type Config,
  type UploadSessionPayload,
} from '@p80/core';
import {
  advanceUpload,
  completeUpload,
  createUpload,
  ensureProfile,
  findInFlightByFilename,
  getRuntimeSettings,
  getUpload,
  listUploads,
  settleUpload,
  type DatabaseHandle,
  type UploadRow,
} from '@p80/database';
import type { App } from '../app.js';
import { addVideoFromPath } from '../services/add-video.js';
import {
  assertRoomFor,
  discardPartial,
  ensureUploadDirectories,
  finalize,
  partialSize,
  reapAbandonedUploads,
  writeChunk,
} from '../services/media-uploads.js';

/**
 * Pushing a file into the library from a browser (ADR 0024).
 *
 * A **session**, not a request: create, then a sequence of positional chunk writes, then a
 * completion that hands off to the same code path `POST /api/videos` uses. That shape buys
 * two things a single `PUT` cannot. A dropped connection costs one chunk rather than the
 * whole file, which matters when the motivating case is a multi-gigabyte upload from a
 * laptop over a mesh VPN. And every request stays small enough that a reverse proxy's body
 * cap is irrelevant — nginx defaults `client_max_body_size` to one megabyte, and ADR 0023
 * put an arbitrary proxy in the path.
 *
 * **Strict append.** A chunk's offset must equal the byte count already received. This is
 * what makes the protocol simple enough to reason about: there are no holes, so progress
 * is a number rather than an interval set, and two chunks cannot be in flight against one
 * session because the second would fail its own offset check. Random access was rejected —
 * it buys parallel chunking that a single disk behind a single link gains nothing from,
 * and pays for it with a data structure that has its own failure modes.
 *
 * One exception, and it is not an inconsistency: a chunk landing entirely *below* the
 * received count is a **success**. That is what a retry after a lost response looks like,
 * and refusing it would let one dropped acknowledgement wedge a client that is behaving
 * correctly.
 */

const idParams = z.object({ id: z.string().min(1) });

const interestLink = z.object({
  interestId: z.string().min(1),
  relevance: z.number().min(0).max(1).default(1),
});

const createUploadBody = z.object({
  /** As the browser has it. Untrusted, and it never becomes a path — `safeMediaFilename`
   *  proposes a name and `resolveMediaPath` decides whether it may be written. */
  filename: z.string().min(1).max(255),
  /** Declared up front, which is the price of a resumable protocol and what buys the
   *  free-space check, real progress, and the ability to tell *finished* from *truncated*.
   *  Zero is allowed so an empty file fails on its content rather than on its size. */
  sizeBytes: z.number().int().min(0).max(MAX_UPLOAD_BYTES),
  title: z.string().trim().min(1).max(300).optional(),
  speakerLabel: z.string().trim().max(120).nullable().optional(),
  regionLabel: z.string().trim().max(120).nullable().optional(),
  interests: z.array(interestLink).max(20).default([]),
  /** Defaults to transcribing, matching `POST /api/videos`. False still hashes and probes
   *  the file — only the `TRANSCRIBE` enqueue is skipped, which is what makes uploading a
   *  batch and transcribing overnight a real option on a CPU-only ASR build. */
  transcribe: z.boolean().default(true),
});

const chunkQuery = z.object({ offset: z.coerce.number().int().min(0) });

/**
 * The transport limit, distinct from the chunk size.
 *
 * Fastify's default body limit is one mebibyte, so without an explicit value here **every
 * chunk would be refused** — and, before the error-handler branch that ADR 0024 added,
 * refused as a 500 rather than a 413. The slack above `UPLOAD_CHUNK_BYTES` exists because
 * a limit exactly equal to the chunk size makes an off-by-one in either direction a
 * production failure rather than a rounding error.
 */
const CHUNK_LIMIT_BYTES = UPLOAD_CHUNK_BYTES + 1024 * 1024;

export async function registerUploadRoutes(
  app: App,
  deps: { handle: DatabaseHandle; config: Config },
): Promise<void> {
  const { handle, config } = deps;

  app.post(
    '/api/uploads',
    { schema: { body: createUploadBody, response: { 201: uploadSessionResponse } } },
    async (request, reply) => {
      const profile = ensureProfile(handle);
      const { mediaRoot } = getRuntimeSettings(handle, config);

      // Cheap, and it is what keeps abandoned partials from accumulating without a timer
      // unit to install and forget. Failures here must not fail the upload.
      try {
        reapAbandonedUploads(handle, mediaRoot);
      } catch (error) {
        request.log.warn({ err: error }, 'upload reaper failed; continuing');
      }

      const named = safeMediaFilename(request.body.filename);
      if (!named.ok) {
        throw new P80Error(ERROR_CODES.INVALID_MEDIA_PATH, MEDIA_PATH_MESSAGES[named.reason], {
          statusCode: 400,
          details: { reason: named.reason, filename: request.body.filename },
        });
      }

      // Throws 413 over the cap and 507 when the disk cannot hold it — both before a byte
      // is written, which is the point of declaring the size.
      assertRoomFor(mediaRoot, request.body.sizeBytes);

      // A pre-check only. Two sessions can pass this simultaneously; the real guard is
      // `link(2)` failing atomically at completion. What it buys is telling the user about
      // a collision *before* they spend twenty minutes uploading.
      const clashing = findInFlightByFilename(handle, {
        profileId: profile.id,
        filename: named.filename,
      });
      if (clashing !== null) {
        throw P80Error.conflict(
          ERROR_CODES.CONFLICT,
          'Another upload is already sending a file with that name. Wait for it to finish, or rename this one.',
          { uploadId: clashing.id, filename: named.filename },
        );
      }

      ensureUploadDirectories(mediaRoot);

      const upload = createUpload(handle, {
        profileId: profile.id,
        originalFilename: request.body.filename.slice(0, 255),
        filename: named.filename,
        sizeBytes: request.body.sizeBytes,
        mediaRoot,
        title: request.body.title ?? null,
        interestsJson:
          request.body.interests.length > 0 ? JSON.stringify(request.body.interests) : null,
        transcribe: request.body.transcribe,
      });

      return reply.status(201).send(toUploadPayload(upload));
    },
  );

  app.get(
    '/api/uploads',
    { schema: { response: { 200: uploadListResponse } } },
    async () => {
      const profile = ensureProfile(handle);
      return {
        uploads: listUploads(handle, { profileId: profile.id }).map(toUploadPayload),
        chunkBytes: UPLOAD_CHUNK_BYTES,
        maxUploadBytes: MAX_UPLOAD_BYTES,
      };
    },
  );

  app.get(
    '/api/uploads/:id',
    { schema: { params: idParams, response: { 200: uploadSessionResponse } } },
    async (request) => toUploadPayload(requireUpload(handle, request.params.id)),
  );

  /**
   * Completion. The bytes are all here; make it a video.
   *
   * `finalize` moves the partial into `uploads/` under a free name and then this reuses
   * `addVideoFromPath`, which is the identical tail `POST /api/videos` runs — so the
   * response is the identical `202 { video, jobId }` and everything downstream of "a video
   * started ingesting" is unchanged, in both clients and in `curl`.
   */
  app.post(
    '/api/uploads/:id/complete',
    { schema: { params: idParams, response: { 202: videoAcceptedResponse } } },
    async (request, reply) => {
      const profile = ensureProfile(handle);
      const upload = requireUpload(handle, request.params.id);
      requireInProgress(upload);
      assertRootUnchanged(handle, config, upload);

      if (upload.receivedBytes !== upload.sizeBytes) {
        throw P80Error.conflict(
          ERROR_CODES.UPLOAD_INCOMPLETE,
          `That upload is not finished — ${upload.receivedBytes} of ${upload.sizeBytes} bytes have arrived.`,
          { receivedBytes: upload.receivedBytes, sizeBytes: upload.sizeBytes },
        );
      }

      const placed = finalize({
        mediaRoot: upload.mediaRoot,
        uploadId: upload.id,
        filename: upload.filename,
      });

      const interests = upload.interestsJson
        ? (JSON.parse(upload.interestsJson) as Array<{ interestId: string; relevance: number }>)
        : [];

      const accepted = addVideoFromPath(handle, {
        profileId: profile.id,
        targetLanguage: profile.targetLanguage,
        relativePath: placed.relativePath,
        title: upload.title,
        interests,
        transcribe: upload.transcribe,
      });

      completeUpload(handle, {
        id: upload.id,
        mediaPath: placed.relativePath,
        videoId: accepted.video.id,
        jobId: accepted.jobId,
      });

      return reply.status(202).send(accepted);
    },
  );

  app.delete(
    '/api/uploads/:id',
    { schema: { params: idParams, response: { 200: uploadDeletedResponse } } },
    async (request) => {
      const upload = requireUpload(handle, request.params.id);
      const discarded = partialSize(upload.mediaRoot, upload.id);
      discardPartial(upload.mediaRoot, upload.id);
      if (upload.status === 'in_progress') {
        settleUpload(handle, { id: upload.id, status: 'aborted' });
      }
      return { deleted: true as const, discardedBytes: discarded };
    },
  );

  /**
   * The chunk route, in its own encapsulated scope.
   *
   * **The encapsulation is load-bearing, not tidiness.** Fastify's content-type parsers are
   * per-instance and inherited downward; registering an `application/octet-stream` parser
   * on the root app would apply it to every route in P80, so a stray content-type header on
   * a JSON endpoint would silently hand the handler a `Buffer` where it expected an object.
   * Inside `register`, the parser reaches this route and nothing else — which
   * `uploads-content-type.test.ts` asserts rather than assumes.
   *
   * **`parseAs: 'buffer'` rather than streaming**, deliberately. Peak memory is one chunk,
   * because only one can be in flight per session. What it buys is that *a partially
   * received chunk can never be counted*: Fastify does not call the handler until the whole
   * body has arrived, so the property that makes resume correct is structural instead of
   * being the output of a half-written-file state machine — which is the hardest part of
   * this protocol to get right and the easiest to get subtly wrong.
   */
  await app.register(async (child) => {
    // The child instance is a fresh `FastifyInstance` and does not inherit the parent's
    // type provider, so `request.params` and `request.query` would be `unknown` inside it.
    // Re-applying it is a type-level operation only — same instance, same encapsulation.
    const scope = child.withTypeProvider<ZodTypeProvider>();

    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: CHUNK_LIMIT_BYTES },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.put(
      '/api/uploads/:id/chunk',
      {
        bodyLimit: CHUNK_LIMIT_BYTES,
        // No `body` schema on purpose: the Zod validator would try to parse a `Buffer`.
        schema: {
          params: idParams,
          querystring: chunkQuery,
          response: { 200: uploadSessionResponse },
        },
      },
      async (request) => {
        const upload = requireUpload(handle, request.params.id);
        requireInProgress(upload);
        assertRootUnchanged(handle, config, upload);

        const data = request.body;
        if (!Buffer.isBuffer(data)) {
          throw P80Error.badRequest(
            'A chunk must be sent as application/octet-stream.',
            { received: request.headers['content-type'] ?? null },
          );
        }

        const { offset } = request.query;

        // The idempotent replay. A chunk wholly below the received count is a retry after
        // a lost response, and answering 200 is what stops one dropped acknowledgement
        // from wedging a client that is doing everything right.
        if (offset + data.length <= upload.receivedBytes) {
          return toUploadPayload(upload);
        }

        if (offset !== upload.receivedBytes) {
          throw P80Error.conflict(
            ERROR_CODES.UPLOAD_OFFSET_MISMATCH,
            `That chunk starts at ${offset}, and the file currently ends at ${upload.receivedBytes}.`,
            { expectedOffset: upload.receivedBytes, receivedOffset: offset },
          );
        }

        if (offset + data.length > upload.sizeBytes) {
          throw P80Error.tooLarge(
            'That chunk would write past the size this upload declared.',
            {
              sizeBytes: upload.sizeBytes,
              offset,
              chunkBytes: data.length,
            },
            ERROR_CODES.UPLOAD_TOO_LARGE,
          );
        }

        const written = writeChunk({
          mediaRoot: upload.mediaRoot,
          uploadId: upload.id,
          offset,
          data,
          knownReceivedBytes: upload.receivedBytes,
        });

        // Conditional on the offset still being what we read. If this returns false the
        // bytes must not be counted — another writer got there first, or the session
        // settled underneath us.
        const advanced = advanceUpload(handle, {
          id: upload.id,
          fromReceivedBytes: upload.receivedBytes,
          toReceivedBytes: offset + written,
        });
        if (!advanced) {
          const current = requireUpload(handle, upload.id);
          throw P80Error.conflict(
            ERROR_CODES.UPLOAD_OFFSET_MISMATCH,
            'That upload moved on while this chunk was being written. Re-read the session and continue from where it now ends.',
            { expectedOffset: current.receivedBytes },
          );
        }

        return toUploadPayload(requireUpload(handle, upload.id));
      },
    );
  });
}

function requireUpload(handle: DatabaseHandle, id: string): UploadRow {
  const upload = getUpload(handle, id);
  if (upload === null) {
    throw new P80Error(
      ERROR_CODES.UPLOAD_NOT_FOUND,
      'There is no upload with that id. It may have been cancelled, or expired after a day without activity.',
      { statusCode: 404, details: { id } },
    );
  }
  return upload;
}

function requireInProgress(upload: UploadRow): void {
  if (upload.status !== 'in_progress') {
    throw P80Error.conflict(
      ERROR_CODES.UPLOAD_NOT_IN_PROGRESS,
      `That upload has already ${upload.status === 'completed' ? 'finished' : upload.status}.`,
      { status: upload.status, videoId: upload.videoId },
    );
  }
}

/**
 * The ADR 0019 hazard, made explicit.
 *
 * Every other consumer of the media root reads it per use, because it is editable while
 * P80 runs and a cached value would keep serving the old library. An upload is the one
 * place where reading per use gives the *wrong* answer: the partial file is under the root
 * that was configured when the session started, and finishing against a new one would move
 * bytes across filesystems into a library the user has since left.
 *
 * So the root is stored on the row and compared, and a change is refused rather than
 * performed. The session fails; the partial is left for the reaper under the old root.
 */
function assertRootUnchanged(
  handle: DatabaseHandle,
  config: Config,
  upload: UploadRow,
): void {
  const { mediaRoot } = getRuntimeSettings(handle, config);
  if (mediaRoot === upload.mediaRoot) return;

  settleUpload(handle, {
    id: upload.id,
    status: 'failed',
    error: { reason: 'media_root_changed' },
  });
  throw P80Error.conflict(
    ERROR_CODES.UPLOAD_ROOT_CHANGED,
    'The media library folder changed while this upload was in progress, so it was stopped. Start it again.',
    { uploadId: upload.id },
  );
}

function toUploadPayload(upload: UploadRow): UploadSessionPayload {
  return {
    id: upload.id,
    filename: upload.filename,
    originalFilename: upload.originalFilename,
    sizeBytes: upload.sizeBytes,
    receivedBytes: upload.receivedBytes,
    chunkBytes: UPLOAD_CHUNK_BYTES,
    status: upload.status,
    videoId: upload.videoId,
    jobId: upload.jobId,
    createdAt: upload.createdAt,
    updatedAt: upload.updatedAt,
    expiresAt: upload.expiresAt,
  };
}
