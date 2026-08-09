import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import {
  ERROR_CODES,
  P80Error,
  PARSE_TRANSCRIPT_JOB_VERSION,
  TRANSCRIPT_FORMATS,
  newId,
  normalizeTranscriptText,
  sanitizeOriginalFilename,
  segmentResponse,
  transcriptAcceptedResponse,
  transcriptDeletedResponse,
  transcriptPreviewResponse,
  transcriptResponse,
  transcriptStoragePath,
  transcriptWordsResponse,
  validateSegmentEdit,
  type Config,
} from '@p80/core';
import {
  countWords,
  deleteTranscript,
  enqueueJob,
  findTranscriptFileByChecksum,
  getLatestTranscriptFile,
  insertCorrection,
  insertTranscriptFile,
  listSegmentsWithCorrections,
  listWords,
  requireVideoScopedSegment,
  setTranscriptStatus,
  type DatabaseHandle,
} from '@p80/database';
import {
  TRANSCRIPT_LIMITS,
  TRANSCRIPT_PARSER_VERSION,
  detectTranscriptFormat,
  parseTranscriptContent,
} from '@p80/providers';
import type { App } from '../app.js';
import { requireVideo } from './videos.js';

const idParams = z.object({ id: z.string().min(1) });
const segmentParams = idParams.extend({ segmentId: z.string().min(1) });

/**
 * The upload body is **JSON, not multipart**. The browser reads the file with `FileReader`
 * and posts its text, which removes a dependency and one whole class of filename handling:
 * there is no upload filename that could reach a path, because the path is generated from
 * ids (see `storage.ts`).
 */
const uploadBody = z.object({
  content: z.string().min(1).max(TRANSCRIPT_LIMITS.maxContentChars),
  filename: z.string().max(255).nullable().optional(),
  /** A hint only. The content decides — a `.srt` file holding WebVTT is routine, and
   *  letting an untrusted filename choose the parser is untrusted input reaching control
   *  flow. */
  format: z.enum(TRANSCRIPT_FORMATS).optional(),
  replace: z.boolean().default(false),
});

const previewBody = uploadBody.omit({ replace: true });

/** Paged, because a one-hour video is roughly nine thousand words and a client that wants
 *  a highlight for the current second does not need all of them. */
const wordsQuery = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(5_000).default(5_000),
});

const readQuery = z.object({
  limit: z.coerce.number().int().min(1).max(2000).default(1000),
  cursor: z.coerce.number().int().min(0).optional(),
  includeCorrections: z.coerce.boolean().default(true),
});

const correctionBody = z
  .object({
    text: z.string().max(TRANSCRIPT_LIMITS.maxSegmentChars).optional(),
    startMs: z.number().int().min(0).max(24 * 3_600_000).optional(),
    endMs: z.number().int().min(0).max(24 * 3_600_000).optional(),
  })
  .refine(
    (body) =>
      body.text !== undefined || body.startMs !== undefined || body.endMs !== undefined,
    'An edit must change the text, the start, or the end.',
  );

/** JSON escaping inflates the body well past the character limit, so the transport bound
 *  is looser than the content bound and both exist. */
const BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** A preview does not need to ship three thousand cues for someone to judge whether the
 *  parse worked. */
const PREVIEW_SEGMENTS = 200;

export async function registerTranscriptRoutes(
  app: App,
  deps: { handle: DatabaseHandle; config: Config },
): Promise<void> {
  const { handle, config } = deps;

  /**
   * Accepts a transcript and enqueues the parse (`03-api.md` §1's 202-plus-jobId rule,
   * spec §12.1 step 9 *"ingestion job begins"*).
   *
   * Nothing is parsed here beyond a cheap format sniff. The worker does the real work, so
   * a pathological file cannot hold a request open, and `PARSE_TRANSCRIPT` gets a handler
   * rather than staying a name in an enum.
   */
  app.post(
    '/api/videos/:id/transcript',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      schema: { params: idParams, body: uploadBody, response: { 202: transcriptAcceptedResponse } },
    },
    async (request, reply) => {
      const video = requireVideo(handle, request.params.id);
      const { content, replace } = request.body;

      if (video.transcriptStatus !== 'none' && !replace) {
        // Refusing is the point. Replacing destroys corrections, and the cost has to be
        // stated before it is paid — the client re-sends with `replace: true` after
        // showing the user what will be lost.
        const existing = getLatestTranscriptFile(handle, video.id);
        throw P80Error.conflict(
          ERROR_CODES.TRANSCRIPT_ALREADY_EXISTS,
          video.transcriptStatus === 'parsing'
            ? 'A transcript for this video is still being parsed.'
            : 'This video already has a transcript. Replacing it will discard any corrections you have made.',
          {
            transcriptStatus: video.transcriptStatus,
            transcriptFileId: existing?.id ?? null,
          },
        );
      }

      const checksum = createHash('sha256').update(content, 'utf8').digest('hex');
      // §14.1's "duplicate upload". Applies even under `replace`, because re-uploading
      // identical bytes is a no-op the user should be told about rather than a rewrite.
      if (findTranscriptFileByChecksum(handle, video.id, checksum) !== null) {
        throw P80Error.conflict(
          ERROR_CODES.TRANSCRIPT_DUPLICATE_UPLOAD,
          'That is the same transcript file you already uploaded for this video.',
          { checksum },
        );
      }

      const detection = detectTranscriptFormat(content);
      if (!detection.ok) {
        // Sniffed before anything touches disk, so an unreadable file leaves nothing
        // behind. Full parsing stays in the worker.
        throw new P80Error(
          ERROR_CODES.TRANSCRIPT_FORMAT_UNRECOGNIZED,
          detection.reason === 'internal_json_unsupported'
            ? 'This looks like a JSON transcript. P80 reads WebVTT, SubRip, and pasted timestamped text; JSON import arrives with data export in Stage 13.'
            : 'P80 could not tell what format this file is. It reads WebVTT, SubRip, and pasted text with a timestamp at the start of each line.',
          { statusCode: 400, details: { reason: detection.reason } },
        );
      }

      if (replace) {
        // Clears segments, corrections, prior file rows, and any queued parse. The files
        // themselves stay on disk.
        deleteTranscript(handle, video.id);
      }

      // Minted here because the path is built from it and the file lands on disk before
      // the row exists.
      const transcriptFileId = newId();
      const storagePath = transcriptStoragePath({
        storageRoot: config.P80_STORAGE_PATH,
        videoId: video.id,
        transcriptFileId,
        format: detection.format,
      });

      // File first, database second. A crash between them orphans a file on disk, which is
      // harmless and consistent with keeping uploads anyway; the reverse would leave a job
      // pointing at a file that does not exist.
      mkdirSync(dirname(storagePath), { recursive: true });
      writeFileSync(storagePath, content, 'utf8');

      const job = handle.sqlite.transaction(() => {
        const file = insertTranscriptFile(handle, {
          id: transcriptFileId,
          videoId: video.id,
          format: detection.format,
          originalFilename: sanitizeOriginalFilename(request.body.filename),
          storagePath,
          checksum,
          parserVersion: TRANSCRIPT_PARSER_VERSION,
        });
        setTranscriptStatus(handle, video.id, 'parsing');
        return enqueueJob(handle, 'PARSE_TRANSCRIPT', {
          entityType: 'video',
          entityId: video.id,
          // Parsing is a pure function of bytes on local disk. There is no transient
          // failure worth three attempts, and three would write three noisy failures for
          // one bad file. `POST /api/jobs/:id/retry` is the operator's escape hatch.
          maxAttempts: 1,
          input: {
            jobVersion: PARSE_TRANSCRIPT_JOB_VERSION,
            videoId: video.id,
            // The id, never the path — `GET /api/jobs/:id` returns `inputJson` verbatim,
            // so a path here would be a published path.
            transcriptFileId: file.id,
            parserVersion: TRANSCRIPT_PARSER_VERSION,
            allowDiscardCorrections: replace,
          },
        });
      })();

      return reply
        .status(202)
        .send({ jobId: job.id, status: 'pending' as const, transcriptFileId });
    },
  );

  /**
   * Parses without persisting anything — spec §12.1 step 7, which the contract's endpoint
   * list has no other way to satisfy.
   *
   * A **validation** failure comes back inside a `200` with `validation.fatal` populated.
   * Showing the user what is wrong before they commit is the entire reason this endpoint
   * exists; a 4xx would leave the preview screen with nothing to render. Only an
   * unrecognized format is a 400, because then there is genuinely nothing to preview.
   */
  app.post(
    '/api/videos/:id/transcript/preview',
    {
      bodyLimit: BODY_LIMIT_BYTES,
      schema: {
        params: idParams,
        body: previewBody,
        response: { 200: transcriptPreviewResponse },
      },
    },
    async (request) => {
      requireVideo(handle, request.params.id);
      const { content } = request.body;

      const result = parseTranscriptContent(content, {
        filename: request.body.filename ?? null,
        formatHint: request.body.format ?? null,
      });

      if (result.fatal?.code === ERROR_CODES.TRANSCRIPT_FORMAT_UNRECOGNIZED) {
        throw new P80Error(ERROR_CODES.TRANSCRIPT_FORMAT_UNRECOGNIZED, result.fatal.message, {
          statusCode: 400,
          details: result.fatal.details,
        });
      }

      const segments = result.segments.slice(0, PREVIEW_SEGMENTS).map((segment) => ({
        sequenceIndex: segment.sequenceIndex,
        startMs: segment.startMs,
        endMs: segment.endMs,
        speakerLabel: segment.speakerLabel,
        rawText: segment.rawText,
        normalizedText: normalizeTranscriptText(segment.rawText),
      }));

      const last = result.segments[result.segments.length - 1];
      return {
        format: result.format,
        parserVersion: result.parserVersion,
        checksum: createHash('sha256').update(content, 'utf8').digest('hex'),
        segmentCount: result.segments.length,
        lastEndMs: last?.endMs ?? null,
        segments,
        truncated: result.segments.length > PREVIEW_SEGMENTS,
        warnings: result.warnings,
        warningsByKind: result.warningsByKind,
        validation: {
          fatal: result.fatal
            ? {
                code: result.fatal.code,
                message: result.fatal.message,
                details: result.fatal.details,
              }
            : null,
        },
      };
    },
  );

  app.get(
    '/api/videos/:id/transcript',
    { schema: { params: idParams, querystring: readQuery, response: { 200: transcriptResponse } } },
    async (request) => {
      const video = requireVideo(handle, request.params.id);
      const file = getLatestTranscriptFile(handle, video.id);
      const { segments, nextCursor } = listSegmentsWithCorrections(handle, video.id, {
        limit: request.query.limit,
        cursor: request.query.cursor ?? null,
        includeCorrections: request.query.includeCorrections,
      });

      return {
        videoId: video.id,
        transcriptStatus: video.transcriptStatus,
        file: file
          ? {
              id: file.id,
              format: file.format,
              // `storagePath` is deliberately absent from this shape and every other.
              originalFilename: file.originalFilename,
              parserVersion: file.parserVersion,
              checksum: file.checksum,
              // ADR 0016/0017. The client shows these: "P80 transcribed this" and "you
              // uploaded this" are different levels of trust, and a `cue`-tier transcript
              // cannot produce a single-word clip. Saying so is the alternative to
              // silently giving the user something coarser than they asked for.
              source: file.source,
              timingGranularity: file.timingGranularity,
              asrModelId: file.asrModelId,
              asrAlignmentModelId: file.asrAlignmentModelId,
              detectedLanguage: file.detectedLanguage,
              languageProbability: file.languageProbability,
              createdAt: file.createdAt,
              warnings: file.warnings,
            }
          : null,
        segments,
        segmentCount: segments.length,
        nextCursor,
      };
    },
  );

  /**
   * `GET /api/videos/:id/transcript/words` — the word array, for a transcript that has one.
   *
   * A separate route rather than an expansion of the transcript response: a one-hour video
   * is roughly nine thousand words, which no consumer of the segment list wants by default.
   *
   * A `cue`-tier transcript gets a **409, not an empty array**. An empty array reads as
   * "this transcript has no words", which is false and would send a caller looking for a
   * parsing bug; the honest answer is that word timing was never available for an uploaded
   * subtitle file and never will be (ADR 0017 §1).
   */
  app.get(
    '/api/videos/:id/transcript/words',
    {
      schema: {
        params: idParams,
        querystring: wordsQuery,
        response: { 200: transcriptWordsResponse },
      },
    },
    async (request) => {
      const video = requireVideo(handle, request.params.id);
      const file = getLatestTranscriptFile(handle, video.id);

      if (file === null) {
        throw P80Error.notFound('Transcript', { videoId: video.id });
      }
      if (file.timingGranularity !== 'word') {
        throw P80Error.conflict(
          ERROR_CODES.TRANSCRIPT_TIMING_UNAVAILABLE,
          'This transcript has timing at line boundaries only. Word-level timing comes from transcription, not from an uploaded subtitle file.',
          { videoId: video.id, timingGranularity: file.timingGranularity },
        );
      }

      const wordCount = countWords(handle, file.id);
      const words = listWords(handle, file.id, {
        offset: request.query.offset,
        limit: request.query.limit,
      });
      const nextOffset = request.query.offset + words.length;

      return {
        videoId: video.id,
        transcriptFileId: file.id,
        timingGranularity: 'word' as const,
        words: words.map((w) => ({
          wordIndex: w.wordIndex,
          text: w.text,
          startMs: w.startMs,
          endMs: w.endMs,
          confidence: w.confidence,
        })),
        wordCount,
        nextOffset: nextOffset < wordCount ? nextOffset : null,
      };
    },
  );

  /**
   * Records a correction. **Never touches `transcript_segments`.**
   *
   * The edit is merged against the segment's *current effective* values, so a correction
   * that only moves the start is still judged against an end a previous correction set.
   */
  app.put(
    '/api/videos/:id/transcript/segments/:segmentId',
    {
      schema: {
        params: segmentParams,
        body: correctionBody,
        response: { 200: segmentResponse },
      },
    },
    async (request) => {
      const video = requireVideo(handle, request.params.id);
      if (video.transcriptStatus !== 'ready') {
        throw P80Error.conflict(
          ERROR_CODES.TRANSCRIPT_NOT_READY,
          'This transcript is not ready to be corrected yet.',
          { transcriptStatus: video.transcriptStatus },
        );
      }

      // Scoped by video as well as by segment id — looking the segment up alone would let
      // one video's URL address another video's rows.
      const current = requireVideoScopedSegment(handle, video.id, request.params.segmentId);

      const edit = validateSegmentEdit(
        { startMs: current.startMs, endMs: current.endMs, text: current.text },
        request.body,
      );
      if (!edit.ok) throw P80Error.badRequest(edit.reason);

      insertCorrection(handle, {
        videoId: video.id,
        segmentId: current.id,
        // All four before/after pairs, so the row is self-contained evidence and a later
        // reader does not have to replay every correction to know what changed.
        beforeText: current.text,
        afterText: edit.merged.text,
        beforeStartMs: current.startMs,
        afterStartMs: edit.merged.startMs,
        beforeEndMs: current.endMs,
        afterEndMs: edit.merged.endMs,
      });

      return requireVideoScopedSegment(handle, video.id, request.params.segmentId);
    },
  );

  app.delete(
    '/api/videos/:id/transcript',
    { schema: { params: idParams, response: { 200: transcriptDeletedResponse } } },
    async (request) => {
      const video = requireVideo(handle, request.params.id);
      const counts = deleteTranscript(handle, video.id);
      setTranscriptStatus(handle, video.id, 'none');
      return counts;
    },
  );
}
