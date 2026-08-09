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
   *  because "too large" without a number is not actionable. */
  static tooLarge(message: string, details?: Record<string, unknown>): P80Error {
    return new P80Error(ERROR_CODES.TRANSCRIPT_TOO_LARGE, message, {
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
