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
  CARD_TYPES,
  CONTEXT_MODES,
  ITEM_STATUSES,
  LEARNING_ITEM_TYPES,
  MEDIA_SOURCE_KINDS,
  PARSE_WARNING_KINDS,
  PROCESSING_STATUSES,
  REGISTERS,
  SCHEDULER_RATINGS,
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
  /**
   * Items whose last occurrence went with the video (`01-domain-model.md` §7 invariant 5).
   *
   * They are archived, not deleted — review history stays interpretable — and the count is
   * reported because deleting a video quietly retiring part of a curriculum is exactly the
   * kind of consequence this codebase states before it is paid.
   */
  archivedItems: z.number().int().nonnegative(),
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

/* ------------------------------------------------ media library and uploads (ADR 0024) */

export const UPLOAD_STATUSES = ['in_progress', 'completed', 'aborted', 'failed'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

/**
 * An upload in flight, and the only thing a client needs in order to resume one.
 *
 * **`receivedBytes` is the server's count, and the client must treat it as authoritative.**
 * A client that tracks what it has *sent* has a second source of truth, and the two diverge
 * the first time a response is lost — which is precisely the case the protocol exists to
 * survive. Every chunk response carries the whole session for that reason.
 *
 * **`chunkBytes` is here rather than in the client** for the same reason `control` and
 * `editable` are on the settings payload: it is a server decision, and a hardcoded constant
 * in the browser is a copy that drifts. Changing the chunk size is then one constant on one
 * machine, which matters because the right value depends on the proxy in front of P80.
 *
 * No path is exposed. The final name cannot be known until completion — a collision can
 * appear in between — and the client has no business learning where the library is.
 */
export const uploadSessionResponse = z.object({
  id: z.string(),
  /** The sanitised name P80 intends to use, for display while the upload runs. The name it
   *  actually used arrives with the video, because a collision may change it. */
  filename: z.string(),
  /** As the browser sent it, for a message that names what the user picked. */
  originalFilename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  receivedBytes: z.number().int().nonnegative(),
  chunkBytes: z.number().int().positive(),
  status: z.enum(UPLOAD_STATUSES),
  /** Set once completion has created the video; null while bytes are still arriving. */
  videoId: z.string().nullable(),
  /** The `INGEST_MEDIA` job completion enqueued, so a client that reloaded can pick the
   *  progress display back up without guessing. */
  jobId: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type UploadSessionPayload = z.infer<typeof uploadSessionResponse>;

export const uploadListResponse = z.object({
  uploads: z.array(uploadSessionResponse),
  chunkBytes: z.number().int().positive(),
  maxUploadBytes: z.number().int().positive(),
});
export type UploadListPayload = z.infer<typeof uploadListResponse>;

export const uploadDeletedResponse = z.object({
  deleted: z.literal(true),
  /** Bytes thrown away, so the client can say what the cancellation cost rather than
   *  pretending nothing happened. */
  discardedBytes: z.number().int().nonnegative(),
});
export type UploadDeletedPayload = z.infer<typeof uploadDeletedResponse>;

/**
 * One entry in the media library listing.
 *
 * `video` is what makes browsing useful rather than decorative: it is the difference
 * between a list of filenames and a list that says which of them P80 already knows about.
 *
 * `supported` is false for a file P80 cannot play. Such files are **listed anyway**,
 * deliberately — hiding the `.avi` somebody copied in produces "where did my file go",
 * while showing it greyed out explains itself.
 */
export const libraryEntryResponse = z.object({
  name: z.string(),
  /** Media-root-relative, and the exact string `POST /api/videos` will accept. */
  path: z.string(),
  kind: z.enum(['file', 'directory', 'symlink']),
  sizeBytes: z.number().int().nonnegative().nullable(),
  modifiedAt: z.number().int().nullable(),
  supported: z.boolean(),
  video: z
    .object({ id: z.string(), title: z.string(), mediaMissing: z.boolean() })
    .nullable(),
  /** A playable file with no video row yet — the one-click add. */
  canAdd: z.boolean(),
  /** Only ever true under `uploads/`. P80 deletes what P80 wrote (ADR 0024 §5), so the
   *  client renders no button for anything else rather than offering one that 403s. */
  deletable: z.boolean(),
});
export type LibraryEntryPayload = z.infer<typeof libraryEntryResponse>;

export const libraryListingResponse = z.object({
  /** The directory being listed, media-root-relative. Empty string is the root. */
  path: z.string(),
  /** One level up, or null at the root. */
  parent: z.string().nullable(),
  entries: z.array(libraryEntryResponse),
  /** True when `limit` cut the listing short. A directory that changes between pages
   *  shifts the offset — acceptable for a personal library, and stated so nobody builds a
   *  stable cursor for it. */
  truncated: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type LibraryListingPayload = z.infer<typeof libraryListingResponse>;

export const libraryDeleteResponse = z.object({
  deleted: z.literal(true),
  path: z.string(),
  /** Videos left pointing at a file that is now gone. Not an error and not a cascade —
   *  ADR 0018 §3's repairable dangling link, with the transcript and review history
   *  intact. */
  markedMissing: z.number().int().nonnegative(),
});
export type LibraryDeletePayload = z.infer<typeof libraryDeleteResponse>;

/* ------------------------------------------------------------ items and review */
/**
 * Stage 3 (ADR 0020). `03-api.md` §5 and §6 give paths and no bodies, same as Stage 2, so
 * these shapes are this stage's resolution of that gap.
 *
 * One choice runs through all of them: **the client sends a selection, never a schedule.**
 * A creation request carries segment ids and character offsets; the server resolves those
 * to timings against the word array. A rating carries a word from §4's table; the server
 * decides what it means for a due date. Anything else would put scheduling in a browser,
 * which ADR 0007 spends its length ruling out.
 */

export const itemSelectionSchema = z.object({
  /** The touched segments, in reading order. One for an ordinary selection; more when the
   *  user dragged across a cue boundary. */
  segmentIds: z.array(z.string()).min(1).max(8),
  /** Character offsets into the *joined* text of those segments, joined by one space. */
  spanStart: z.number().int().nonnegative(),
  spanEnd: z.number().int().nonnegative(),
});

export const createItemRequest = z.object({
  videoId: z.string(),
  selection: itemSelectionSchema,
  canonicalForm: z.string().min(1).max(200),
  itemType: z.enum(LEARNING_ITEM_TYPES),
  /** The user's own gloss. Stored as a `definitions` row with `provider: 'user'`, and
   *  rendered as user-authored — never as verified (hard rule 11, ADR 0020 §3). */
  meaning: z.string().min(1).max(1000),
  /** A natural rendering in the profile's native language. Optional: an item can be
   *  understood without being translatable in one phrase, and forcing a translation is how
   *  a definition acquires a confident-looking wrong answer. */
  translation: z.string().max(1000).optional(),
  register: z.enum(REGISTERS).default('neutral'),
  lemma: z.string().max(200).optional(),
  partOfSpeech: z.string().max(40).optional(),
  dialectRegion: z.string().max(80).optional(),
  offensiveOrSensitive: z.boolean().default(false),
  /** Overrides for the two judgement calls in `05-cards-and-review.md` §2. Omitted means
   *  the heuristic decides. */
  includeAudioCard: z.boolean().optional(),
  includeClozeCard: z.boolean().optional(),
});
export type CreateItemBody = z.input<typeof createItemRequest>;

export const skillStateSchema = z.object({
  cardId: z.string().nullable(),
  phase: z.enum(['not_started', 'learning', 'review', 'relearning', 'suspended']),
  dueAt: z.number().int().nullable(),
  lastRating: z.enum(SCHEDULER_RATINGS).nullable(),
  successCount: z.number().int().nonnegative(),
  lapseCount: z.number().int().nonnegative(),
});

export const occurrenceResponse = z.object({
  id: z.string(),
  itemId: z.string(),
  videoId: z.string(),
  sentenceId: z.string(),
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  /** ADR 0017. `cue` means the clip covers the whole line the item sits in. Surfaced
   *  rather than absorbed: a replay that plays a whole sentence when a word was asked for
   *  is a worse answer, not a rounder one (`05-cards-and-review.md` §3.1). */
  timingPrecision: z.enum(['word', 'cue']),
  surfaceForm: z.string(),
  sentenceText: z.string(),
  precedingText: z.string().nullable(),
  followingText: z.string().nullable(),
  isPrimaryOccurrence: z.boolean(),
});
export type OccurrencePayload = z.infer<typeof occurrenceResponse>;

export const itemDefinitionSchema = z.object({
  id: z.string(),
  provider: z.string(),
  definition: z.string(),
  translation: z.string().nullable(),
  /** False whenever `evidence` is null. The label the UI must render is *unverified*, and
   *  it is computed here so two clients cannot disagree about it. */
  verified: z.boolean(),
  confidence: z.number().nullable(),
  isUserEdited: z.boolean(),
  createdAt: z.number().int(),
});

export const itemResponse = z.object({
  id: z.string(),
  profileId: z.string(),
  targetLanguage: z.string(),
  canonicalForm: z.string(),
  normalizedForm: z.string(),
  lemma: z.string().nullable(),
  itemType: z.enum(LEARNING_ITEM_TYPES),
  senseKey: z.string(),
  partOfSpeech: z.string().nullable(),
  meaning: z.string(),
  register: z.enum(REGISTERS),
  dialectRegion: z.string().nullable(),
  offensiveOrSensitive: z.boolean(),
  status: z.enum(ITEM_STATUSES),
  /** ADR 0020 §3: zero here means *unscored*, not *worthless*. A manual item bypassed
   *  admission, and nothing reads these before Stage 6 can compute them. */
  scores: z.object({
    domainFrequency: z.number(),
    contextualDiversity: z.number(),
    reusePotential: z.number(),
    extractionConfidence: z.number(),
    definitionConfidence: z.number(),
  }),
  /** True while the three ranking scores are placeholders. */
  unscored: z.boolean(),
  translations: z.array(
    z.object({ language: z.string(), kind: z.string(), text: z.string() }),
  ),
  definitions: z.array(itemDefinitionSchema),
  /** Projected from `cards` on read, never stored (`01-domain-model.md` §2.1). One entry
   *  per card type, including types with no card — that is what `not_started` is for. */
  skills: z.record(z.enum(CARD_TYPES), skillStateSchema),
  occurrences: z.array(occurrenceResponse),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type ItemPayload = z.infer<typeof itemResponse>;

export const itemListResponse = z.object({
  items: z.array(itemResponse),
  nextCursor: z.string().nullable(),
});

/** `03-api.md` §5: "reviews + definition edits + provenance". Append-only, newest first. */
export const itemHistoryResponse = z.object({
  itemId: z.string(),
  reviews: z.array(
    z.object({
      id: z.string(),
      sessionId: z.string().nullable(),
      cardId: z.string().nullable(),
      cardType: z.enum(CARD_TYPES),
      contextMode: z.enum(CONTEXT_MODES),
      shownAt: z.number().int(),
      answeredAt: z.number().int().nullable(),
      responseText: z.string().nullable(),
      responseLatencyMs: z.number().int().nullable(),
      /** Null in MVP. §4's step 2 is optional and no LLM runs in Stage 3. */
      machineClassification: z.string().nullable(),
      schedulerRating: z.enum(SCHEDULER_RATINGS).nullable(),
      hintCount: z.number().int().nonnegative(),
      sourceContextUsed: z.boolean(),
      occurrenceId: z.string().nullable(),
    }),
  ),
  definitions: z.array(itemDefinitionSchema),
});
export type ItemHistoryPayload = z.infer<typeof itemHistoryResponse>;

export const sessionRequestSchema = z.object({
  desiredMinutes: z.number().int().min(1).max(180).default(20),
  includeNewItems: z.boolean().default(true),
  /** Stage 11. Accepted and reported back as unfilled rather than rejected, so a client
   *  written against the contract does not have to know which stage it is talking to. */
  includeVideoLoop: z.boolean().default(false),
  includeTransfer: z.boolean().default(false),
  includeErrorRepair: z.boolean().default(false),
});

export const sessionPlanSchema = z.object({
  cards: z.array(
    z.object({
      cardId: z.string(),
      itemId: z.string(),
      cardType: z.enum(CARD_TYPES),
      tier: z.string(),
      estimatedSeconds: z.number().int().nonnegative(),
    }),
  ),
  estimatedSeconds: z.number().int().nonnegative(),
  budgetSeconds: z.number().int().nonnegative(),
  newItemCount: z.number().int().nonnegative(),
  newItemAllowance: z.number().int().nonnegative(),
  /** Which §9 constraints had to give, in the order they gave. Empty is the common case,
   *  and a non-empty list is the plan explaining itself rather than a warning. */
  relaxations: z.array(z.string()),
  /** §6 rule 2 at work, not a shortfall. A learner with one item gets one card and two
   *  siblings held for another day, and the UI needs this number to say so. */
  deferredSiblings: z.number().int().nonnegative(),
  unplacedCards: z.number().int().nonnegative(),
  /** §9 tiers no stage has built yet. Carried so a plan is self-describing. */
  unimplementedTiers: z.array(z.string()),
  newItemsSuppressedByBurden: z.boolean(),
});

export const sessionResponse = z.object({
  id: z.string(),
  startedAt: z.number().int(),
  completedAt: z.number().int().nullable(),
  request: sessionRequestSchema,
  plan: sessionPlanSchema,
});
export type SessionPayload = z.infer<typeof sessionResponse>;

/** What the review surface renders. The back face is **not** in this payload — it arrives
 *  from `POST .../answer`, because a reveal that the client already holds is a reveal the
 *  learner can reach without a retrieval (§1 rule 2, §9.9). */
export const reviewCardResponse = z.object({
  reviewId: z.string(),
  cardId: z.string(),
  itemId: z.string(),
  cardType: z.enum(CARD_TYPES),
  contextMode: z.enum(CONTEXT_MODES),
  position: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** §3.1's miniature player, pre-roll already applied. Null for a card with no clip. */
  clip: z
    .object({
      videoId: z.string(),
      mediaUrl: z.string(),
      mediaMissing: z.boolean(),
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().nonnegative(),
      itemStartMs: z.number().int().nonnegative(),
      itemEndMs: z.number().int().nonnegative(),
      timingPrecision: z.enum(['word', 'cue']),
    })
    .nullable(),
  prompt: z.string(),
  /** The cloze front. Present only on a cloze card, and it is the only place the sentence
   *  appears before reveal. */
  clozeText: z.string().nullable(),
  /** True when the card accepts typed input. §3.1 makes it optional for audio recognition
   *  — a mental answer is permitted. */
  acceptsText: z.boolean(),
  /** §3.2: playback is offered after the first attempt on a cloze, never before. */
  clipAvailableBeforeAnswer: z.boolean(),
});
export type ReviewCardPayload = z.infer<typeof reviewCardResponse>;

export const reviewAnswerRequest = z.object({
  reviewId: z.string(),
  responseText: z.string().max(2000).optional(),
  /** Measured by the client from card render to submit. §23.1 wants it honest, which is
   *  why it is a separate call from the rating rather than derived from server timings. */
  responseLatencyMs: z.number().int().nonnegative().optional(),
  sourceContextUsed: z.boolean().default(false),
});

/** The back face, §3.1 and §3.2. Returned only once an attempt has been recorded. */
export const reviewRevealResponse = z.object({
  reviewId: z.string(),
  canonicalForm: z.string(),
  meaning: z.string(),
  translation: z.string().nullable(),
  /** False whenever the gloss has no dictionary evidence. */
  meaningVerified: z.boolean(),
  sentenceText: z.string(),
  /** Character offsets of the item within `sentenceText`, for highlighting. The client
   *  escapes the text and applies the offsets; it never receives markup (hard rule 8). */
  spanStart: z.number().int().nonnegative(),
  spanEnd: z.number().int().nonnegative(),
  precedingText: z.string().nullable(),
  followingText: z.string().nullable(),
  /** §3.3: the source sentence is *one* acceptable answer, never the only one. Clients
   *  render this label; it is not advice, it is part of the card. */
  isOneOfSeveralAnswers: z.boolean(),
  /** A structured check where §4's step 1 could make one — cloze only. Null elsewhere. */
  automaticCheck: z
    .object({ correct: z.boolean(), expected: z.string() })
    .nullable(),
});
export type ReviewRevealPayload = z.infer<typeof reviewRevealResponse>;

export const reviewRateRequest = z.object({
  reviewId: z.string(),
  rating: z.enum(SCHEDULER_RATINGS),
});

export const reviewRateResponse = z.object({
  cardId: z.string(),
  rating: z.enum(SCHEDULER_RATINGS),
  /** The four intervals FSRS would have produced, so the UI can show what each rating
   *  costs before it is pressed and what it bought after. */
  dueAt: z.number().int(),
  intervalDays: z.number(),
  phase: z.enum(['not_started', 'learning', 'review', 'relearning', 'suspended']),
  lapsed: z.boolean(),
  /** True when the card was requeued into this session — §6 rule 4 puts it back no sooner
   *  than five intervening cards. */
  requeued: z.boolean(),
});

export const dueSummaryResponse = z.object({
  dueNow: z.number().int().nonnegative(),
  overdue: z.number().int().nonnegative(),
  /** Cards, by type, that are due now. A count of items would hide that one item can put
   *  three cards on the pile. */
  dueByCardType: z.record(z.enum(CARD_TYPES), z.number().int().nonnegative()),
  newItemsAvailable: z.number().int().nonnegative(),
  newItemAllowance: z.number().int().nonnegative(),
  newItemsIntroducedToday: z.number().int().nonnegative(),
  estimatedMinutes: z.number(),
});
export type DueSummaryPayload = z.infer<typeof dueSummaryResponse>;

/** §8's burden, over the next seven days. */
export const reviewForecastResponse = z.object({
  totalMinutes: z.number(),
  overdueMinutes: z.number(),
  upcomingMinutes: z.number(),
  days: z.array(z.object({ date: z.string(), cards: z.number().int(), minutes: z.number() })),
});
export type ReviewForecastPayload = z.infer<typeof reviewForecastResponse>;
