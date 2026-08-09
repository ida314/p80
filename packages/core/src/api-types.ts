/**
 * Response shapes for the Stage 2 surface, defined once.
 *
 * `apps/api` uses these as Fastify `response` schemas — so an extra field is stripped
 * rather than leaked — and `apps/web` infers its types from the same objects. Before this,
 * the web client hand-mirrored the API's Zod shapes in `api.ts`, which works until it
 * doesn't: `videoResponse` alone is eighteen fields, and a hand-copied mirror drifts
 * silently, with the API sending one thing and the client typed for another.
 *
 * Kept free of any `node:*` import so it can be pulled in through `@p80/core/browser`.
 *
 * `03-api.md` gives paths and comments but no bodies, so these shapes are Stage 2's
 * resolution of that gap and are recorded back into the contract with `ADDED` markers.
 */

import { z } from 'zod';
import {
  MEDIA_SOURCE_KINDS,
  PARSE_WARNING_KINDS,
  PROCESSING_STATUSES,
  TIMING_GRANULARITIES,
  TRANSCRIPT_FORMATS,
  TRANSCRIPT_SOURCES,
  TRANSCRIPT_STATUSES,
} from './domain.js';

export const parseWarningSchema = z.object({
  kind: z.enum(PARSE_WARNING_KINDS),
  /** `null` for a whole-file anomaly, whose message carries a count instead. Without that
   *  split, a three-thousand-cue auto-caption file produces three thousand warnings. */
  segmentIndex: z.number().int().nullable(),
  /** Contains no transcript text, ever — see ADR 0014. Bounded because this is persisted
   *  and re-served on every read. */
  message: z.string().max(500),
});
export type ParseWarningPayload = z.infer<typeof parseWarningSchema>;

export const mediaDescriptorSchema = z.object({
  kind: z.literal('local_media'),
  /** An API route, never a filesystem path. The client does not learn where media lives. */
  mediaUrl: z.string(),
  missing: z.boolean(),
  /** Fractional seconds. A `<video>` seek is exact, unlike the keyframe-bounded player
   *  this replaced, so rounding to whole seconds would throw away precision the schema
   *  can carry for free (ADR 0015). */
  startSeconds: z.number().nonnegative().optional(),
  endSeconds: z.number().nonnegative().optional(),
});

export const videoInterestSchema = z.object({
  interestId: z.string(),
  name: z.string(),
  relevance: z.number().min(0).max(1),
});

export const videoResponse = z.object({
  id: z.string(),
  profileId: z.string(),
  sourceType: z.enum(MEDIA_SOURCE_KINDS),
  /** The content hash (ADR 0018), or `pending:<id>` until the ingest job has read the
   *  file. Opaque to clients — it is an identity, not a display value. */
  externalVideoId: z.string(),
  /** Display locator only: the path the user gave, as they gave it. Never dereferenced,
   *  never fetched, and never used to build a player — that is `media.mediaUrl`. */
  url: z.string(),
  title: z.string().nullable(),
  targetLanguage: z.string(),
  durationMs: z.number().int().nullable(),
  speakerLabel: z.string().nullable(),
  regionLabel: z.string().nullable(),
  transcriptStatus: z.enum(TRANSCRIPT_STATUSES),
  processingStatus: z.enum(PROCESSING_STATUSES),
  estimatedCoverage: z.number().nullable(),
  difficultyLabel: z.string().nullable(),
  pipelineVersion: z.string().nullable(),
  /** The referenced file was not there last time P80 looked. Everything else about the
   *  video still works — only playback needs the bytes (ADR 0018 §3). */
  mediaMissing: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  /** ADR 0007: the client renders this rather than constructing a player from `url`. */
  media: mediaDescriptorSchema,
  segmentCount: z.number().int().nonnegative(),
  interests: z.array(videoInterestSchema),
});
export type VideoPayload = z.infer<typeof videoResponse>;

export const videoListResponse = z.object({
  videos: z.array(videoResponse),
  nextCursor: z.string().nullable(),
});

/** `03-api.md` §1: work that starts a pipeline returns a job reference, not a result.
 *  Adding a video reads a multi-gigabyte file and then transcribes it, so it is the most
 *  clearly asynchronous operation in the product. */
export const videoAcceptedResponse = z.object({
  video: videoResponse,
  jobId: z.string(),
  status: z.literal('pending'),
});
export type VideoAcceptedPayload = z.infer<typeof videoAcceptedResponse>;

export const wordSchema = z.object({
  wordIndex: z.number().int().nonnegative(),
  text: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  /** Null where the aligner could not place the word — distinct from a low score. */
  confidence: z.number().nullable(),
});

export const transcriptWordsResponse = z.object({
  videoId: z.string(),
  transcriptFileId: z.string(),
  /** Always `word` on this route; a `cue` transcript gets a 409 instead. Carried anyway so
   *  a stored response is self-describing. */
  timingGranularity: z.literal('word'),
  words: z.array(wordSchema),
  wordCount: z.number().int().nonnegative(),
  nextOffset: z.number().int().nullable(),
});
export type TranscriptWordsPayload = z.infer<typeof transcriptWordsResponse>;

export const segmentResponse = z.object({
  id: z.string(),
  /** The file's own order, preserved. Reads are ordered by time, but the two differ
   *  whenever a transcript's cues are out of order, and both facts are worth keeping. */
  sequenceIndex: z.number().int(),
  startMs: z.number().int(),
  endMs: z.number().int(),
  speakerLabel: z.string().nullable(),
  /** As stored. Immutable after ingestion. */
  rawText: z.string(),
  normalizedText: z.string(),
  /** Effective text: the latest correction if one exists, else `rawText`. */
  text: z.string(),
  corrected: z.boolean(),
  correctionId: z.string().nullable(),
  /** Half-open range into the transcript's word array (ADR 0017). Null on a `cue`-tier
   *  transcript, and meaningless once `corrected` is true — a correction changes the text
   *  without changing the words beneath it, so the indices no longer address what the
   *  caller is reading. `resolveSpanTiming` handles both cases at one call site. */
  wordStartIndex: z.number().int().nullable(),
  wordEndIndex: z.number().int().nullable(),
});
export type SegmentPayload = z.infer<typeof segmentResponse>;

/**
 * A preview has no ids and no corrections — nothing has been persisted.
 *
 * It also has no word indices, and never will: a preview parses a subtitle file the user
 * is about to upload, and an uploaded file is `cue`-tier by definition (ADR 0017). There
 * is no preview of an ASR transcript, because ASR output is not something the user
 * confirms before it is stored — the job produces it.
 */
export const previewSegmentSchema = segmentResponse.omit({
  id: true,
  text: true,
  corrected: true,
  correctionId: true,
  wordStartIndex: true,
  wordEndIndex: true,
});

export const parseFatalSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.record(z.string(), z.unknown()),
});

export const transcriptPreviewResponse = z.object({
  format: z.enum(TRANSCRIPT_FORMATS),
  parserVersion: z.string(),
  checksum: z.string(),
  segmentCount: z.number().int().nonnegative(),
  lastEndMs: z.number().int().nullable(),
  segments: z.array(previewSegmentSchema),
  /** True when `segments` is a head rather than the whole parse. A preview of a
   *  three-thousand-cue file does not need to ship three thousand cues to let someone
   *  decide whether the parse worked. */
  truncated: z.boolean(),
  warnings: z.array(parseWarningSchema),
  warningsByKind: z.record(z.enum(PARSE_WARNING_KINDS), z.number().int()),
  /**
   * A validation failure arrives here inside a `200`, not as an error status. Showing the
   * user what is wrong *before* they commit is the entire reason this endpoint exists
   * (§12.1 step 7); returning a 4xx would leave the preview screen with nothing to show.
   * Only an unrecognized format is a 400, because then there is nothing to preview.
   */
  validation: z.object({ fatal: parseFatalSchema.nullable() }),
});
export type TranscriptPreviewPayload = z.infer<typeof transcriptPreviewResponse>;

export const transcriptFileSchema = z.object({
  id: z.string(),
  format: z.enum(TRANSCRIPT_FORMATS),
  /** Display only. Never an `href`, a `download`, or a path — see `storage.ts`. Null for
   *  an ASR transcript, which had no file to begin with. */
  originalFilename: z.string().nullable(),
  parserVersion: z.string(),
  checksum: z.string(),
  /** ADR 0016. Shown to the user, because "this transcript came from a model" and "you
   *  uploaded this" are different levels of trust and the UI must not conflate them. */
  source: z.enum(TRANSCRIPT_SOURCES),
  /** ADR 0017. A `cue` transcript cannot produce a single-word clip, and saying so is the
   *  alternative to silently returning a coarser one. */
  timingGranularity: z.enum(TIMING_GRANULARITIES),
  asrModelId: z.string().nullable(),
  /** Null means the timings came from Whisper's own attention rather than forced
   *  alignment — less precise, and visibly so. */
  asrAlignmentModelId: z.string().nullable(),
  detectedLanguage: z.string().nullable(),
  languageProbability: z.number().nullable(),
  createdAt: z.number().int(),
  warnings: z.array(parseWarningSchema),
});

export const transcriptResponse = z.object({
  videoId: z.string(),
  transcriptStatus: z.enum(TRANSCRIPT_STATUSES),
  file: transcriptFileSchema.nullable(),
  segments: z.array(segmentResponse),
  segmentCount: z.number().int().nonnegative(),
  nextCursor: z.number().int().nullable(),
});
export type TranscriptPayload = z.infer<typeof transcriptResponse>;

/** `03-api.md` §1: work that starts a pipeline returns a job reference, not a result. */
export const transcriptAcceptedResponse = z.object({
  jobId: z.string(),
  status: z.literal('pending'),
  transcriptFileId: z.string(),
});

/**
 * Deleting names its cost. The uploaded file stays on disk, so the source is recoverable;
 * corrections are not, which is why they are counted rather than merely cascaded.
 */
export const transcriptDeletedResponse = z.object({
  deletedSegments: z.number().int().nonnegative(),
  deletedCorrections: z.number().int().nonnegative(),
  deletedFiles: z.number().int().nonnegative(),
  cancelledJobs: z.number().int().nonnegative(),
});

export const videoDeletedResponse = transcriptDeletedResponse.extend({
  deleted: z.literal(true),
});

export const interestResponse = z.object({
  id: z.string(),
  name: z.string(),
  /** 1..5 — how much the user cares about the topic. Distinct from
   *  `video_interests.relevance`, which is 0..1 and says how much a video is *about* it. */
  weight: z.number().int().min(1).max(5),
  createdAt: z.number().int(),
});
export type InterestPayload = z.infer<typeof interestResponse>;

/* --------------------------------------------------------------------- settings */
/**
 * ADR 0019. The settings surface is the one place a client renders configuration, and both
 * clients render the same rows, so the row shape is defined here rather than twice.
 *
 * `value` and `environmentValue` are a union of the three primitive types a setting can
 * have. They are not narrowed per key, because a client renders from `control` and does not
 * branch on which setting it is looking at — that is what keeps the surface from acquiring
 * knowledge of what a media root is.
 */
export const settingValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const settingViewResponse = z.object({
  key: z.string(),
  tier: z.enum(['live', 'boot']),
  value: settingValueSchema,
  /** Which of the two sources the effective value came from. A stored row that no longer
   *  matches `.env.local` reads as overridden rather than as ignored. */
  source: z.enum(['environment', 'database']),
  environmentValue: settingValueSchema,
  editable: z.boolean(),
  description: z.string(),
  control: z.enum(['path', 'text', 'boolean', 'number', 'choice', 'readonly']),
  choices: z.array(z.string()).optional(),
  /** Present only when a stored row exists and cannot be parsed. The environment value is
   *  in use; this says so rather than letting the row look effective. */
  invalid: z.string().optional(),
});
export type SettingViewPayload = z.infer<typeof settingViewResponse>;

export const settingsResponse = z.object({
  settings: z.array(settingViewResponse),
});
export type SettingsPayload = z.infer<typeof settingsResponse>;

/**
 * What changing the media root would cost, counted before it is paid.
 *
 * `videos.media_path` is relative to the root (ADR 0015), so a new root makes every video
 * resolve somewhere else. Nothing is destroyed and setting the root back restores
 * everything — but that is a claim the user should be able to check against a number, which
 * is what `orphaned` is. Same shape of decision as `replace: true` on a transcript upload.
 */
export const mediaRootPreflightResponse = z.object({
  /** The normalised absolute path that would be stored, or null when it was rejected. */
  path: z.string().nullable(),
  valid: z.boolean(),
  /** Machine-readable rejection reason, for a client that wants to style the field. */
  reason: z.string().nullable(),
  message: z.string().nullable(),
  videoCount: z.number().int().nonnegative(),
  /** Videos whose file is present under the proposed root. */
  resolved: z.number().int().nonnegative(),
  /** Videos whose file is not. These stop playing until the root changes back or the video
   *  is re-pointed; their transcripts and everything built on them are unaffected. */
  orphaned: z.number().int().nonnegative(),
  /** A bounded sample, for a message that names videos rather than only counting them. */
  orphanedSample: z.array(z.object({ id: z.string(), title: z.string() })),
});
export type MediaRootPreflightPayload = z.infer<typeof mediaRootPreflightResponse>;
