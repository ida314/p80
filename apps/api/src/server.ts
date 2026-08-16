import { existsSync } from 'node:fs';
import { join } from 'node:path';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import {
  ERROR_CODES,
  P80Error,
  allowedOrigins,
  createLogger,
  findRepoRoot,
  isLanExposed,
  toEnvelope,
  trustedOrigins,
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
import { registerItemRoutes } from './routes/items.js';
import { registerJobRoutes } from './routes/jobs.js';
import { registerProfileRoutes } from './routes/profile.js';
import { registerReviewRoutes } from './routes/review.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerTranscriptRoutes } from './routes/transcript.js';
import { registerVideoRoutes } from './routes/videos.js';

export interface ApiServer {
  app: App;
  handle: DatabaseHandle;
  close(): Promise<void>;
}

export interface ServerOptions {
  /**
   * Where the built browser client lives. Defaults to `apps/web/dist` under the
   * repository root.
   *
   * An argument rather than a `P80_*` variable on purpose: `CONFIG_KEYS` is a closed set
   * asserted against the schema, and this is a build-output location, not something a
   * user configures. Tests use it to exercise both the built and unbuilt cases without
   * depending on whether the repository happens to have been built.
   */
  webRoot?: string;
}

export async function buildServer(
  config: Config,
  options: ServerOptions = {},
): Promise<ApiServer> {
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

  // Strict CORS: loopback web origins, plus anything `P80_TRUSTED_ORIGINS` names (spec
  // §32.5, `03-api.md` §10, ADR 0023). A request from any other origin is refused rather
  // than silently allowed.
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
          // The permitted list is named rather than described: "loopback origins only" was
          // a true sentence that stopped being one the moment ADR 0023 made the list
          // configurable, and a refusal that misstates the rule sends the reader to the
          // wrong file.
          `This origin is not permitted. P80 accepts: ${origins.join(', ')}.`,
          { statusCode: 403, details: { origin, allowed: origins } },
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

  /**
   * The built browser client, served by the API itself on the API's own port.
   *
   * In development Vite does two jobs on `P80_WEB_PORT`: it compiles the client and it
   * proxies `/api/*` here. In a deployment there is no Vite, so the API serves
   * `apps/web/dist` and everything lives on one origin — no proxy hop, and no reliance on
   * the CORS allowlist for the app's own requests.
   *
   * Resolved from the repository root rather than `cwd` for the same reason every other
   * path is (`resolveFromRepoRoot`): this process is started from at least three different
   * working directories depending on who starts it.
   */
  const webRoot = options.webRoot ?? join(findRepoRoot(), 'apps', 'web', 'dist');
  const webBuilt = existsSync(join(webRoot, 'index.html'));

  if (webBuilt) {
    await app.register(fastifyStatic, {
      root: webRoot,
      // NOT the default `true`. A wildcard registers a catch-all `GET /*` that answers
      // every unmatched path itself, which would swallow the client-route fallback below
      // and turn a refreshed `/items/abc` into a 404. With `false`, each built file is
      // registered individually and anything else falls through to the handler.
      wildcard: false,
    });
  } else {
    // Not an error. `pnpm dev` serves the client from Vite and never builds, so an absent
    // `dist` is the normal development state — the API simply has no client to hand out.
    logger.info(
      { webRoot },
      'no built web client found; serving the API only. `pnpm build` produces one.',
    );
  }

  app.setNotFoundHandler((request, reply) => {
    // A client-side route, not a missing endpoint. React Router owns the path, so the
    // shell is the correct answer and the router decides what it means — otherwise
    // refreshing any page below `/` is a 404. `/api/*` is never a client route: an
    // unknown endpoint must stay a JSON error, or a typo in a `curl` returns HTML.
    if (webBuilt && request.method === 'GET' && !request.url.startsWith('/api/')) {
      return reply.type('text/html').sendFile('index.html');
    }

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
  // Stage 3. Neither needs `config`: the media root is reached through the media route,
  // and a review payload carries an API URL rather than a path (ADR 0015).
  await registerItemRoutes(app, { handle });
  await registerReviewRoutes(app, { handle });

  if (isLanExposed(config)) {
    // §32.5: LAN exposure is opt-in and warns first. It is not silently normal.
    logger.warn(
      { bindHost: config.P80_BIND_HOST, allowLan: config.P80_ALLOW_LAN },
      'P80 is NOT bound to loopback. Anyone on this network can reach your library, ' +
        'transcripts, and review history. Unset P80_ALLOW_LAN to go back to 127.0.0.1.',
    );
  }

  const trusted = trustedOrigins(config);
  if (trusted.length > 0) {
    // ADR 0023: still loopback-bound, so `isLanExposed` is false and the warning above
    // stays quiet — but a proxy is reaching P80 from somewhere else, which is the same
    // decision wearing different clothes. Warning on both keeps rule 13's "opt-in behind a
    // warning" true of the mechanism rather than only of the one variable it was written
    // for.
    logger.warn(
      { trustedOrigins: trusted },
      'P80 accepts browser requests from non-loopback origins. P80 has no authentication, ' +
        'so whatever can reach these origins can read and change everything. Unset ' +
        'P80_TRUSTED_ORIGINS to accept loopback only.',
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
