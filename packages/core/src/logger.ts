import { destination, pino, type DestinationStream, type Logger } from 'pino';

export type { Logger };

/**
 * One logger factory for every process (spec §35 Stage 1 step 8).
 *
 * The `redact` list is deliberately populated even though ADR 0005 leaves nothing to
 * redact — there is no API key anywhere in P80. It stays because a future cloud adapter
 * would reintroduce the risk silently, and a redaction path added later is a redaction
 * path that was missing for however long the adapter existed.
 *
 * `stream` overrides pino's default of stdout — see `createCliLogger`.
 */
export function createLogger(
  service: string,
  level = 'info',
  stream?: DestinationStream,
): Logger {
  return pino(
    {
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
    },
    stream,
  );
}

/**
 * A logger for scripts whose **stdout is a data channel** — `dev:noop` prints a job id
 * that `scripts/smoke.sh` reads with `tail -1`.
 *
 * Pino buffers and flushes on process exit, so a script that logs and then writes a value
 * to stdout emits the two in nondeterministic order. That made the smoke check flaky:
 * roughly two runs in five, `tail -1` returned the JSON log line instead of the id, and
 * the job lookup 404'd. Logs go to fd 2, data to fd 1, and the two can no longer race.
 *
 * `sync: true` because these scripts are short-lived and exit immediately after logging.
 */
export function createCliLogger(service: string, level = 'info'): Logger {
  return createLogger(service, level, destination({ dest: 2, sync: true }));
}
