/**
 * The error envelope from `docs/contracts/03-api.md` §1.
 *
 * Codes are stable SCREAMING_SNAKE_CASE. `message` is safe to display. `details` is
 * structured and never contains secrets. Provider failures surface here as actionable
 * errors, never as fabricated success (spec §27.4).
 */
export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
    retryable: boolean;
  };
}

export const ERROR_CODES = {
  BAD_REQUEST: 'BAD_REQUEST',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  ORIGIN_NOT_ALLOWED: 'ORIGIN_NOT_ALLOWED',
  MIGRATION_FAILED: 'MIGRATION_FAILED',
  PROFILE_NOT_INITIALIZED: 'PROFILE_NOT_INITIALIZED',
  JOB_NOT_RETRYABLE: 'JOB_NOT_RETRYABLE',
  JOB_NOT_CANCELLABLE: 'JOB_NOT_CANCELLABLE',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',

  // --- Stage 2: video and transcript ingestion ---
  /** The path is not one P80 can use. `details.reason` carries a `MediaPathRejection`, so
   *  the client can explain *which* way it failed without parsing a message. Never carries
   *  the resolved absolute path: the caller sent a relative one and has no business
   *  learning where the media root is (ADR 0015). */
  INVALID_MEDIA_PATH: 'INVALID_MEDIA_PATH',
  /** The path is well-formed and contained, and there is nothing there. Also the read-side
   *  answer when a file that was ingested has since moved — which sets
   *  `videos.media_missing` and is repairable, not fatal (ADR 0018 §3). */
  MEDIA_FILE_NOT_FOUND: 'MEDIA_FILE_NOT_FOUND',
  /** Repair was offered a file whose content hashes differently. `details` names both
   *  hashes. Accepting it would silently rebind a transcript to audio it does not match,
   *  which is the failure ADR 0018 exists to prevent. */
  MEDIA_CONTENT_MISMATCH: 'MEDIA_CONTENT_MISMATCH',
  /** A source no `MediaSourceAdapter` claims. */
  UNSUPPORTED_MEDIA_SOURCE: 'UNSUPPORTED_MEDIA_SOURCE',
  /** The sidecar is down, or has no ASR model installed. Not a failure of the product:
   *  ingestion falls back to the upload path and says so (ADR 0016). */
  ASR_UNAVAILABLE: 'ASR_UNAVAILABLE',
  /** The decode language and the detected language disagree. Transcribing anyway would
   *  produce a plausible curriculum of the wrong language (ADR 0016 §3). */
  ASR_LANGUAGE_MISMATCH: 'ASR_LANGUAGE_MISMATCH',
  /** Transcription ran and failed. Distinct from unavailable, which is not an error in
   *  the pipeline so much as a configuration the product supports. */
  ASR_FAILED: 'ASR_FAILED',
  /** Word-level timing was asked for on a `cue`-tier transcript (ADR 0017). */
  TRANSCRIPT_TIMING_UNAVAILABLE: 'TRANSCRIPT_TIMING_UNAVAILABLE',
  /** The `videos` unique constraint. `details` carries the existing id so a client can
   *  navigate to it rather than making the user search. */
  DUPLICATE_VIDEO: 'DUPLICATE_VIDEO',
  /** A second upload without `replace: true`. Refusing is the point: replacing destroys
   *  corrections, and the cost has to be stated before it is paid. */
  TRANSCRIPT_ALREADY_EXISTS: 'TRANSCRIPT_ALREADY_EXISTS',
  /** §14.1 "duplicate upload" — identical checksum for this video. */
  TRANSCRIPT_DUPLICATE_UPLOAD: 'TRANSCRIPT_DUPLICATE_UPLOAD',
  /** A correction against a transcript that is not `ready`. */
  TRANSCRIPT_NOT_READY: 'TRANSCRIPT_NOT_READY',
  /** The worker refusing to discard hand corrections it was not told it could discard. */
  TRANSCRIPT_HAS_CORRECTIONS: 'TRANSCRIPT_HAS_CORRECTIONS',
  TRANSCRIPT_FORMAT_UNRECOGNIZED: 'TRANSCRIPT_FORMAT_UNRECOGNIZED',
  TRANSCRIPT_TOO_LARGE: 'TRANSCRIPT_TOO_LARGE',
  /** Parsed cleanly and produced nothing. Not a transcript. */
  TRANSCRIPT_NO_SEGMENTS: 'TRANSCRIPT_NO_SEGMENTS',
  /** §14.1 "nonnegative durations". No non-arbitrary repair exists, and a negative
   *  duration breaks click-to-seek — this stage's own exit criterion. */
  TRANSCRIPT_INVALID_TIMESTAMPS: 'TRANSCRIPT_INVALID_TIMESTAMPS',
  /** The envelope example in `03-api.md` §1 uses this code, so it must exist. */
  TRANSCRIPT_PARSE_FAILED: 'TRANSCRIPT_PARSE_FAILED',
  /** The stored file no longer matches its checksum. */
  TRANSCRIPT_FILE_CORRUPT: 'TRANSCRIPT_FILE_CORRUPT',

  // --- Stage 2b: runtime settings (ADR 0019) ---
  /** A `PUT` naming a key the registry does not know, or one in the boot tier. Boot-tier
   *  writes are refused rather than accepted-and-ignored: a setting that silently does
   *  nothing is worse than one that is absent. `details.reason` says which case it is. */
  SETTING_NOT_EDITABLE: 'SETTING_NOT_EDITABLE',
  /** A proposed media root that cannot be one. `details.reason` carries a
   *  `MediaRootRejection`, which distinguishes a typo from a refusal on principle. */
  INVALID_MEDIA_ROOT: 'INVALID_MEDIA_ROOT',
  // --- Stage 3: manual items and review (ADR 0020) ---
  /** The item identity constraint from `01-domain-model.md` §3.1. `details` names the
   *  existing item so the client can offer to open it. Never auto-suffixed into a second
   *  sense: two senses described identically are more likely one item entered twice, and
   *  a silently collapsed distinction is invariant 4's failure mode. */
  ITEM_SENSE_EXISTS: 'ITEM_SENSE_EXISTS',
  /** A transcript selection that does not resolve — segments from another video, an empty
   *  span, or offsets past the end of the joined text. */
  INVALID_SELECTION: 'INVALID_SELECTION',
  /** `GET /next` or an answer against a session that has been completed. */
  SESSION_COMPLETE: 'SESSION_COMPLETE',
  /** A rating for a review that already has one. `reviews` is append-only, so the second
   *  rating cannot overwrite the first and must be refused rather than absorbed. */
  REVIEW_ALREADY_RATED: 'REVIEW_ALREADY_RATED',
  /** Revealing or rating before an attempt was recorded. §1 rule 2 makes the rep happen
   *  before the reveal; skipping the attempt would log a restudy as a rep (§9.9). */
  REVIEW_NOT_ATTEMPTED: 'REVIEW_NOT_ATTEMPTED',
  /** The new root is valid, and videos already added would stop resolving under it.
   *  Nothing is destroyed and changing the root back restores them, so this is a
   *  confirmation gate rather than a failure — `acknowledgeOrphans: true` proceeds.
   *  `details` carries the counts. Same shape as `TRANSCRIPT_ALREADY_EXISTS`. */
  MEDIA_ROOT_WOULD_ORPHAN: 'MEDIA_ROOT_WOULD_ORPHAN',

  // --- Media library uploads (ADR 0024) ---
  /** No session with that id — never created, already settled and pruned, or reaped after
   *  its expiry. The client's stored id is stale and it should start again. */
  UPLOAD_NOT_FOUND: 'UPLOAD_NOT_FOUND',
  /** A chunk against a session that has completed, aborted, or failed. Distinct from
   *  `UPLOAD_NOT_FOUND` because the answer is different: the bytes went somewhere, and
   *  `GET /api/uploads/:id` will say where. */
  UPLOAD_NOT_IN_PROGRESS: 'UPLOAD_NOT_IN_PROGRESS',
  /** The offset is not where the file currently ends. `details.expectedOffset` is the
   *  whole point: this is a **resume instruction**, not just a refusal, and a client that
   *  reads it recovers without asking anything further. */
  UPLOAD_OFFSET_MISMATCH: 'UPLOAD_OFFSET_MISMATCH',
  /** Completion asked for before every byte arrived. `details` carries both numbers, so
   *  the client can resume from the difference rather than restarting. */
  UPLOAD_INCOMPLETE: 'UPLOAD_INCOMPLETE',
  /** Over `MAX_UPLOAD_BYTES` at session creation, or a chunk that would write past the
   *  declared size. Also what Fastify's own body-limit refusal is translated into, so an
   *  over-large request is a 413 rather than the 500 a raw framework error becomes. */
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  /** Not enough free space for the declared size, or `ENOSPC` mid-write. Retryable and
   *  honestly so: strict-append means nothing already received is lost, so freeing space
   *  and resuming genuinely works. */
  UPLOAD_STORAGE_FULL: 'UPLOAD_STORAGE_FULL',
  /** The write did not complete and the partial file was rewound to the last known-good
   *  offset. Retryable, because the session is intact. */
  UPLOAD_WRITE_FAILED: 'UPLOAD_WRITE_FAILED',
  /** `P80_MEDIA_ROOT` was edited while this upload was in flight (ADR 0019 makes it
   *  live-editable). The partial is under the old root and finishing would move it across
   *  filesystems into a library the user has since left. Refused rather than guessed. */
  UPLOAD_ROOT_CHANGED: 'UPLOAD_ROOT_CHANGED',
  /** A delete against a file one or more videos still reference. `details.videos` names
   *  them, and `acknowledgeVideos: true` proceeds — the same confirmation shape as
   *  `MEDIA_ROOT_WOULD_ORPHAN`. Nothing cascades: the videos are marked missing, which is
   *  ADR 0018 §3's repairable state. */
  MEDIA_FILE_IN_USE: 'MEDIA_FILE_IN_USE',
  /** A delete aimed outside `<P80_MEDIA_ROOT>/uploads/`. P80 deletes what P80 wrote and
   *  nothing else (ADR 0024 §5); a file the user put there is theirs. */
  MEDIA_DELETE_REFUSED: 'MEDIA_DELETE_REFUSED',
  /** The endpoint has no parser for the content type sent. Almost always a client bug,
   *  and reported as one — before ADR 0024 the framework's own refusal was flattened into
   *  `INTERNAL_ERROR`, which said P80 broke when the request was simply not accepted. */
  UNSUPPORTED_MEDIA_TYPE: 'UNSUPPORTED_MEDIA_TYPE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class P80Error extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: {
      statusCode?: number;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = 'P80Error';
    this.code = code;
    this.statusCode = options.statusCode ?? 500;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
        retryable: this.retryable,
      },
    };
  }

  static notFound(what: string, details?: Record<string, unknown>): P80Error {
    return new P80Error(ERROR_CODES.NOT_FOUND, `${what} not found.`, {
      statusCode: 404,
      ...(details ? { details } : {}),
    });
  }

  static badRequest(message: string, details?: Record<string, unknown>): P80Error {
    return new P80Error(ERROR_CODES.BAD_REQUEST, message, {
      statusCode: 400,
      ...(details ? { details } : {}),
    });
  }

  static conflict(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): P80Error {
    return new P80Error(code, message, {
      statusCode: 409,
      ...(details ? { details } : {}),
    });
  }

  /** 422 — the request was well-formed but its content cannot be used. A transcript that
   *  parses into nothing, or whose timestamps run backwards, is this rather than a 400:
   *  the client did nothing wrong, the file is unusable. */
  static unprocessable(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
  ): P80Error {
    return new P80Error(code, message, {
      statusCode: 422,
      ...(details ? { details } : {}),
    });
  }

  /** 413 — over a declared limit. `details` always names the limit and the actual value,
   *  because "too large" without a number is not actionable.
   *
   *  The code is a parameter and defaults to the transcript one, which is what it
   *  hardcoded when transcripts were the only thing with a size limit. An upload that
   *  reported `TRANSCRIPT_TOO_LARGE` would send a client looking for a transcript. */
  static tooLarge(
    message: string,
    details?: Record<string, unknown>,
    code: ErrorCode = ERROR_CODES.TRANSCRIPT_TOO_LARGE,
  ): P80Error {
    return new P80Error(code, message, {
      statusCode: 413,
      ...(details ? { details } : {}),
    });
  }
}

/**
 * Anything that escapes a handler becomes an envelope. An unexpected throw is reported
 * as `INTERNAL_ERROR` with a generic message — the original goes to the log, not to the
 * client, because an exception message can carry a file path or a query fragment.
 */
export function toEnvelope(err: unknown): { status: number; body: ErrorEnvelope } {
  if (err instanceof P80Error) {
    return { status: err.statusCode, body: err.toEnvelope() };
  }
  return {
    status: 500,
    body: {
      error: {
        code: ERROR_CODES.INTERNAL_ERROR,
        message: 'An unexpected error occurred. See the server log for details.',
        retryable: false,
      },
    },
  };
}
