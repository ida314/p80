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
