import cors from '@fastify/cors';
import {
  ERROR_CODES,
  P80Error,
  allowedOrigins,
  createLogger,
  isLanExposed,
  toEnvelope,
  type Config,
} from '@p80/core';
import { ensureProfile, migrate, openDatabase, type DatabaseHandle } from '@p80/database';
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import { createFastify, type App } from './app.js';
import { registerHealthRoutes } from './routes/health.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTranscriptRoutes } from './routes/transcript.js';
import { registerVideoRoutes } from './routes/videos.js';

export interface ApiServer {
  app: App;
  handle: DatabaseHandle;
  close(): Promise<void>;
}

export async function buildServer(config: Config): Promise<ApiServer> {
  const logger = createLogger('api', config.P80_LOG_LEVEL);

  const handle = openDatabase(config.P80_DB_PATH);
  // Migrations run automatically on API start (Stage 1 exit criterion 2,
  // `02-database.md` §3 rule 2). They are checked into source control first — this
  // applies reviewed files, it does not generate any.
  migrate(handle.sqlite, { logger });
  ensureProfile(handle);

  const app = createFastify(logger);

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Strict CORS: loopback web origins only (spec §32.5, `03-api.md` §10). A request from
  // any other origin is refused rather than silently allowed.
  const origins = allowedOrigins(config);
  await app.register(cors, {
    origin: (origin, cb) => {
      // No Origin header at all — curl, the TUI, a same-origin fetch. Not a browser
      // cross-origin request, so there is nothing for CORS to protect against here.
      if (!origin) return cb(null, true);
      if (origins.includes(origin)) return cb(null, true);
      cb(
        new P80Error(
          ERROR_CODES.ORIGIN_NOT_ALLOWED,
          'This origin is not permitted. P80 accepts loopback origins only.',
          { statusCode: 403, details: { origin } },
        ),
        false,
      );
    },
    credentials: false,
  });

  /**
   * The single place an error becomes a response body. Every failure leaves the API in
   * the envelope from `03-api.md` §1 — stable code, displayable message, no secrets.
   */
  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      const validation = new P80Error(
        ERROR_CODES.VALIDATION_FAILED,
        'Request failed validation.',
        {
          statusCode: 400,
          details: {
            issues: error.validation.map((v) => ({
              path: v.instancePath,
              message: v.message,
            })),
          },
        },
      );
      return reply.status(400).send(validation.toEnvelope());
    }

    const { status, body } = toEnvelope(error);
    if (status >= 500) {
      request.log.error({ err: error }, 'unhandled error');
    } else {
      request.log.warn({ err: error, code: body.error.code }, 'request failed');
    }
    return reply.status(status).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const err = P80Error.notFound('Route', {
      method: request.method,
      url: request.url,
    });
    return reply.status(404).send(err.toEnvelope());
  });

  await registerHealthRoutes(app, { config, handle });
  await registerProfileRoutes(app, { handle });
  await registerJobRoutes(app, { handle });
  // ADR 0019. Needs `config` as the seed for every setting and as the authority for the
  // boot tier it displays read-only.
  await registerSettingsRoutes(app, { handle, config });
  // Both need `config` for `P80_STORAGE_PATH` — uploads are written to disk (spec §7.2).
  await registerVideoRoutes(app, { handle, config });
  await registerMediaRoutes(app, { handle, config });
  await registerTranscriptRoutes(app, { handle, config });

  if (isLanExposed(config)) {
    // §32.5: LAN exposure is opt-in and warns first. It is not silently normal.
    logger.warn(
      { bindHost: config.P80_BIND_HOST, allowLan: config.P80_ALLOW_LAN },
      'P80 is NOT bound to loopback. Anyone on this network can reach your library, ' +
        'transcripts, and review history. Unset P80_ALLOW_LAN to go back to 127.0.0.1.',
    );
  }

  return {
    app,
    handle,
    async close() {
      await app.close();
      handle.close();
    },
  };
}
