import { pino, type Logger } from 'pino';

export type { Logger };

/**
 * One logger factory for every process (spec §35 Stage 1 step 8).
 *
 * The `redact` list is deliberately populated even though ADR 0005 leaves nothing to
 * redact — there is no API key anywhere in P80. It stays because a future cloud adapter
 * would reintroduce the risk silently, and a redaction path added later is a redaction
 * path that was missing for however long the adapter existed.
 */
export function createLogger(service: string, level = 'info'): Logger {
  return pino({
    level,
    base: { service },
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        '*.apiKey',
        '*.api_key',
        '*.token',
        '*.password',
      ],
      censor: '[redacted]',
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
