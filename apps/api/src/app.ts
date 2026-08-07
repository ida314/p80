import Fastify from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Logger } from '@p80/core';

/**
 * Builds the Fastify instance and exports its exact type.
 *
 * The type alias is derived from the builder rather than written out by hand because
 * two things vary from Fastify's defaults — the pino logger instance and the Zod type
 * provider — and hand-writing the seven generic parameters that encode them is how route
 * modules end up with `request.body: unknown` and lose the validation they were given.
 */
export function createFastify(logger: Logger) {
  return Fastify({ loggerInstance: logger }).withTypeProvider<ZodTypeProvider>();
}

export type App = ReturnType<typeof createFastify>;
