/**
 * Job payload schemas.
 *
 * Spec §27.3 requires every job to be **versioned**. `jobVersion` makes that structural
 * rather than aspirational: a queued job outlives the code that enqueued it, so a handler
 * that assumes today's shape will one day read a payload written by a previous release and
 * mis-read it silently. Validating on the way in turns that into a loud failure.
 *
 * These schemas are also the reason no filesystem path appears in a job payload.
 * `GET /api/jobs/:id` returns `inputJson` and `outputJson` verbatim, so anything in here is
 * published — see `CLAUDE.md` rule 8 and the storage-path note in `storage.ts`. The payload
 * carries `transcriptFileId`; the handler resolves the path itself.
 */

import { z } from 'zod';
import { PARSE_WARNING_KINDS, TRANSCRIPT_FORMATS } from './domain.js';

export const INGEST_MEDIA_JOB_VERSION = 1;

/**
 * `INGEST_MEDIA` — read the file P80 was pointed at, and record what it is.
 *
 * No path here, for the reason the header gives: `GET /api/jobs/:id` returns `inputJson`
 * verbatim, so anything in a payload is published. The handler reads `videos.media_path`
 * itself, which is also the only way a retry stays correct after a repair moved the file.
 */
export const ingestMediaInput = z.object({
  jobVersion: z.literal(INGEST_MEDIA_JOB_VERSION),
  videoId: z.string().min(1),
  /** Whether to enqueue `TRANSCRIBE` on success. False on the repair path: re-pointing a
   *  video at a moved file must not re-transcribe a transcript that is already there. */
  transcribe: z.boolean().default(true),
});
export type IngestMediaInput = z.infer<typeof ingestMediaInput>;

export const ingestMediaOutput = z.object({
  jobVersion: z.literal(INGEST_MEDIA_JOB_VERSION),
  videoId: z.string(),
  /** The content hash. Identity from here on (ADR 0018). */
  contentHash: z.string(),
  mediaBytes: z.number().int().nonnegative(),
  /** Null when `ffprobe` is unavailable. A null duration is a missing fact; a guessed one
   *  is a wrong fact displayed as if it were known. */
  durationMs: z.number().int().nonnegative().nullable(),
  /** Set when the hash matched a video the profile already has. The row this job ran for
   *  is discarded and the client is sent to the original — a rename must not become a
   *  second copy of a library entry (ADR 0018 §1). */
  duplicateOfVideoId: z.string().nullable().default(null),
  transcribeJobId: z.string().nullable().default(null),
  skipped: z.enum(['video_deleted', 'media_missing']).nullable().default(null),
});
export type IngestMediaOutput = z.infer<typeof ingestMediaOutput>;

export const TRANSCRIBE_JOB_VERSION = 1;

/**
 * `TRANSCRIBE` — local ASR over the referenced file (ADR 0016).
 *
 * The first job that takes minutes. Everything about its failure handling follows from
 * that: it is resumable in the sense that re-running is safe and cheap to reason about,
 * and it never leaves a partial transcript behind.
 */
export const transcribeInput = z.object({
  jobVersion: z.literal(TRANSCRIBE_JOB_VERSION),
  videoId: z.string().min(1),
  /** Pinned at enqueue from `profile.target_language`, not read at run time. A profile
   *  edited while the job sat in the queue must not silently change what language the
   *  audio is decoded as. */
  language: z.string().min(1),
});
export type TranscribeInput = z.infer<typeof transcribeInput>;

export const transcribeOutput = z.object({
  jobVersion: z.literal(TRANSCRIBE_JOB_VERSION),
  videoId: z.string(),
  transcriptFileId: z.string().nullable(),
  wordCount: z.number().int().nonnegative(),
  segmentCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  warningsByKind: z.record(z.enum(PARSE_WARNING_KINDS), z.number().int()).default({}),
  detectedLanguage: z.string().nullable(),
  modelId: z.string().nullable(),
  /** Null means the timings came from Whisper's own attention weights rather than forced
   *  alignment. Recorded so a less precise transcript is distinguishable from a precise
   *  one, instead of both claiming the same thing. */
  alignmentModelId: z.string().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  /** `upload_won` is ADR 0016 §1's precedence rule reaching the worker: a user-supplied
   *  transcript arrived while ASR was queued or running, so the result is discarded rather
   *  than allowed to overwrite it. The job succeeds — nothing failed. */
  skipped: z
    .enum(['video_deleted', 'media_missing', 'upload_won'])
    .nullable()
    .default(null),
});
export type TranscribeOutput = z.infer<typeof transcribeOutput>;

export const PARSE_TRANSCRIPT_JOB_VERSION = 1;

export const parseTranscriptInput = z.object({
  jobVersion: z.literal(PARSE_TRANSCRIPT_JOB_VERSION),
  videoId: z.string().min(1),
  /**
   * Pinned at enqueue time so a retry re-parses **the same file**, even if the user has
   * since uploaded a replacement. Without this, retrying an old job would silently
   * overwrite the newer transcript with the older one.
   */
  transcriptFileId: z.string().min(1),
  parserVersion: z.string().min(1),
  /**
   * Set only by the replace path, which has already told the user how many corrections it
   * is about to destroy. A plain retry leaves it false, so a stale job cannot quietly take
   * the user's hand corrections with it.
   */
  allowDiscardCorrections: z.boolean().default(false),
});
export type ParseTranscriptInput = z.infer<typeof parseTranscriptInput>;

export const parseTranscriptOutput = z.object({
  jobVersion: z.literal(PARSE_TRANSCRIPT_JOB_VERSION),
  transcriptFileId: z.string(),
  parserVersion: z.string(),
  format: z.enum(TRANSCRIPT_FORMATS),
  segmentCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  /** Counts per kind, so the UI can say "3 cues look like subtitle boilerplate" without
   *  re-reading the whole warning list. */
  warningsByKind: z.record(z.enum(PARSE_WARNING_KINDS), z.number().int()).default({}),
  /** The transcript's last timestamp. Deliberately *not* written to `videos.duration_ms`:
   *  the transcript's end is not the video's end, and a wrong duration in a displayed
   *  field is worse than a null one. */
  lastEndMs: z.number().int().nonnegative().nullable(),
  /** Present when the file row vanished under the job — a DELETE that raced a queued
   *  parse. The job succeeds, because resurrecting deleted segments would be the bug. */
  skipped: z.enum(['file_row_deleted', 'video_deleted']).nullable().default(null),
});
export type ParseTranscriptOutput = z.infer<typeof parseTranscriptOutput>;
