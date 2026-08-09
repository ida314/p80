import { z } from 'zod';
import {
  ERROR_CODES,
  INGEST_MEDIA_JOB_VERSION,
  P80Error,
  PROCESSING_STATUSES,
  TRANSCRIPT_STATUSES,
  interestResponse,
  videoAcceptedResponse,
  videoDeletedResponse,
  videoListResponse,
  videoResponse,
  type Config,
} from '@p80/core';
import {
  createInterest,
  createVideo,
  deleteInterest,
  deleteVideo,
  enqueueJob,
  ensureProfile,
  findByMediaPath,
  getVideo,
  listInterests,
  listVideos,
  setVideoInterests,
  updateInterest,
  updateVideo,
  type DatabaseHandle,
} from '@p80/database';
import type { App } from '../app.js';
import { toVideoPayload } from '../services/video-payload.js';
import { requireExists, requireMediaPath } from './media.js';

const idParams = z.object({ id: z.string().min(1) });

const interestLink = z.object({
  interestId: z.string().min(1),
  relevance: z.number().min(0).max(1).default(1),
});

const createVideoBody = z.object({
  /** Relative to `P80_MEDIA_ROOT` (ADR 0015). Not a URL: P80 never acquires media, so
   *  there is nothing for a URL to name. */
  path: z.string().trim().min(1).max(1024),
  title: z.string().trim().min(1).max(300).optional(),
  speakerLabel: z.string().trim().max(120).nullable().optional(),
  regionLabel: z.string().trim().max(120).nullable().optional(),
  interests: z.array(interestLink).max(20).default([]),
});

const updateVideoBody = z.object({
  title: z.string().trim().min(1).max(300).nullable().optional(),
  speakerLabel: z.string().trim().max(120).nullable().optional(),
  regionLabel: z.string().trim().max(120).nullable().optional(),
  durationMs: z.number().int().min(0).nullable().optional(),
  interests: z.array(interestLink).max(20).optional(),
});

const listQuery = z.object({
  transcriptStatus: z.enum(TRANSCRIPT_STATUSES).optional(),
  processingStatus: z.enum(PROCESSING_STATUSES).optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(64).optional(),
});

const interestBody = z.object({
  name: z.string().trim().min(1).max(100),
  weight: z.number().int().min(1).max(5).default(3),
});

/**
 * Videos and interests (`03-api.md` §3 and §2).
 *
 * **`targetLanguage` is not accepted.** Spec §12.1 step 5 has the user enter or confirm it
 * on the add-video form; ADR 0001 ships exactly one pair and the value comes from the
 * profile. A form field offering a choice with one legal answer is a promise the rest of
 * the system does not keep. Recorded as a divergence in the stage brief.
 */
export async function registerVideoRoutes(
  app: App,
  deps: { handle: DatabaseHandle; config: Config },
): Promise<void> {
  const { handle, config } = deps;

  /**
   * Structural validation and an existence check, then a job.
   *
   * The file is **not read here**. Hashing it and probing its duration cost seconds on a
   * large file, and §1 requires work that starts a pipeline to return a job reference
   * rather than a result. Identity is therefore filled in by `INGEST_MEDIA`, which also
   * means a duplicate is detected in the worker and resolves by re-pointing the original
   * rather than by failing an insert (ADR 0018).
   */
  app.post(
    '/api/videos',
    { schema: { body: createVideoBody, response: { 202: videoAcceptedResponse } } },
    async (request, reply) => {
      const profile = ensureProfile(handle);

      const resolved = requireMediaPath(request.body.path, config.P80_MEDIA_ROOT);
      requireExists(resolved.absolutePath, request.body.path);

      // The boring duplicate, caught before it costs anything. ADR 0018's content-hash
      // check catches the interesting one — the same file under two names — but only in
      // the worker, after a full read. Without this, re-adding a path someone already
      // added spends minutes hashing and transcribing before being discarded, which looks
      // like a bug from the outside.
      const already = findByMediaPath(handle, profile.id, resolved.relativePath);
      if (already !== null) {
        throw P80Error.conflict(
          ERROR_CODES.DUPLICATE_VIDEO,
          'You have already added this file.',
          { videoId: already.id, path: resolved.relativePath },
        );
      }

      const video = createVideo(handle, {
        profileId: profile.id,
        sourceType: 'local_media',
        // `externalVideoId` omitted on purpose — the row gets `pending:<id>` until the
        // ingest job hashes the bytes.
        url: resolved.relativePath,
        mediaPath: resolved.relativePath,
        title: request.body.title ?? null,
        targetLanguage: profile.targetLanguage,
        speakerLabel: request.body.speakerLabel ?? null,
        regionLabel: request.body.regionLabel ?? null,
      });

      if (request.body.interests.length > 0) {
        setVideoInterests(handle, video.id, request.body.interests);
      }

      const job = enqueueJob(handle, 'INGEST_MEDIA', {
        entityType: 'video',
        entityId: video.id,
        input: {
          jobVersion: INGEST_MEDIA_JOB_VERSION,
          videoId: video.id,
          transcribe: true,
        },
      });

      return reply.status(202).send({
        video: toVideoPayload(handle, video),
        jobId: job.id,
        status: 'pending' as const,
      });
    },
  );

  app.get(
    '/api/videos',
    { schema: { querystring: listQuery, response: { 200: videoListResponse } } },
    async (request) => {
      const profile = ensureProfile(handle);
      const result = listVideos(handle, { profileId: profile.id, ...request.query });
      return {
        videos: result.videos.map((video) => toVideoPayload(handle, video)),
        nextCursor: result.nextCursor,
      };
    },
  );

  app.get(
    '/api/videos/:id',
    { schema: { params: idParams, response: { 200: videoResponse } } },
    async (request) => toVideoPayload(handle, requireVideo(handle, request.params.id)),
  );

  app.put(
    '/api/videos/:id',
    { schema: { params: idParams, body: updateVideoBody, response: { 200: videoResponse } } },
    async (request) => {
      requireVideo(handle, request.params.id);
      // `url` and `externalVideoId` are absent from the body schema on purpose: changing a
      // video's identity would orphan its transcript and every occurrence built on it.
      const { interests, ...patch } = request.body;
      const video = updateVideo(handle, request.params.id, patch);
      if (interests !== undefined) {
        setVideoInterests(handle, request.params.id, interests);
      }
      return toVideoPayload(handle, video);
    },
  );

  app.delete(
    '/api/videos/:id',
    { schema: { params: idParams, response: { 200: videoDeletedResponse } } },
    async (request) => {
      requireVideo(handle, request.params.id);
      const counts = deleteVideo(handle, request.params.id);
      // Approved learning items survive (`01-domain-model.md` §7 invariant 5) — an item
      // whose last occurrence goes becomes archived, not deleted, so review history stays
      // interpretable. The uploaded transcript files stay on disk.
      return { deleted: true as const, ...counts, cancelledJobs: 0 };
    },
  );

  registerNotYetImplemented(app);
  registerInterestRoutes(app, handle);
}

/**
 * Registered rather than left to the not-found handler.
 *
 * A 404 from an unregistered route and a 404 for "no such video" are indistinguishable to
 * a client, which turns "this endpoint arrives in Stage 4" into "your video is missing".
 * A 501 naming the stage is a claim that the endpoint exists and is not ready.
 */
function registerNotYetImplemented(app: App): void {
  const stub = (method: 'get' | 'post', path: string, stage: string) => {
    app[method](path, { schema: { params: idParams } }, async () => {
      throw new P80Error(
        ERROR_CODES.NOT_IMPLEMENTED,
        `This arrives in ${stage}.`,
        { statusCode: 501, details: { stage } },
      );
    });
  };

  stub('post', '/api/videos/:id/process', 'Stage 4, with the extraction pipeline');
  stub('post', '/api/videos/:id/recalculate', 'Stage 10, with video difficulty');
  stub('get', '/api/videos/:id/items', 'Stage 3, with manual learning items');
  stub('get', '/api/videos/:id/recommendations', 'Stage 12, with recommendations');
}

/**
 * Interests (`03-api.md` §2).
 *
 * Beyond spec §35's Stage 2 list, and flagged as such in the stage brief. Without them
 * `video_interests` is a table nothing can reference and §12.1 step 5's interest tags have
 * nothing to bind to.
 */
function registerInterestRoutes(app: App, handle: DatabaseHandle): void {
  app.get(
    '/api/interests',
    { schema: { response: { 200: z.array(interestResponse) } } },
    async () => listInterests(handle, ensureProfile(handle).id),
  );

  app.post(
    '/api/interests',
    { schema: { body: interestBody, response: { 201: interestResponse } } },
    async (request, reply) => {
      const profile = ensureProfile(handle);
      const interest = createInterest(handle, { profileId: profile.id, ...request.body });
      return reply.status(201).send(interest);
    },
  );

  app.put(
    '/api/interests/:id',
    {
      schema: {
        params: idParams,
        body: interestBody.partial(),
        response: { 200: interestResponse },
      },
    },
    async (request) => updateInterest(handle, request.params.id, request.body),
  );

  app.delete(
    '/api/interests/:id',
    { schema: { params: idParams, response: { 200: z.object({ deleted: z.literal(true) }) } } },
    async (request) => {
      if (!deleteInterest(handle, request.params.id)) {
        throw P80Error.notFound('Interest', { id: request.params.id });
      }
      return { deleted: true as const };
    },
  );
}

export function requireVideo(handle: DatabaseHandle, id: string) {
  const video = getVideo(handle, id);
  if (!video) throw P80Error.notFound('Video', { id });
  return video;
}
