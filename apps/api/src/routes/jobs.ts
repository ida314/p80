import { z } from 'zod';
import { JOB_STATES, JOB_TYPES, P80Error } from '@p80/core';
import { cancelJob, getJob, listJobs, retryJob, type DatabaseHandle } from '@p80/database';
import type { App } from '../app.js';

const jobResponse = z.object({
  id: z.string(),
  jobType: z.string(),
  entityType: z.string().nullable(),
  entityId: z.string().nullable(),
  status: z.string(),
  attemptCount: z.number(),
  maxAttempts: z.number(),
  priority: z.number(),
  inputJson: z.unknown(),
  outputJson: z.unknown(),
  errorJson: z.unknown(),
  claimedBy: z.string().nullable(),
  claimedAt: z.number().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  completedAt: z.number().nullable(),
});

const listQuery = z.object({
  status: z.enum(JOB_STATES).optional(),
  jobType: z.enum(JOB_TYPES).optional(),
  entityId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const idParams = z.object({ id: z.string().min(1) });

/**
 * Jobs and diagnostics (`03-api.md` §8). Every job is inspectable — the contract's word,
 * and the reason a failed enrichment is a visible, retryable row rather than a silence.
 */
export async function registerJobRoutes(
  app: App,
  deps: { handle: DatabaseHandle },
): Promise<void> {
  app.get(
    '/api/jobs',
    { schema: { querystring: listQuery, response: { 200: z.array(jobResponse) } } },
    async (request) => listJobs(deps.handle, request.query),
  );

  app.get(
    '/api/jobs/:id',
    { schema: { params: idParams, response: { 200: jobResponse } } },
    async (request) => {
      const job = getJob(deps.handle, request.params.id);
      if (!job) throw P80Error.notFound('Job', { id: request.params.id });
      return job;
    },
  );

  app.post(
    '/api/jobs/:id/retry',
    { schema: { params: idParams, response: { 200: jobResponse } } },
    async (request) => retryJob(deps.handle, request.params.id),
  );

  app.post(
    '/api/jobs/:id/cancel',
    { schema: { params: idParams, response: { 200: jobResponse } } },
    async (request) => cancelJob(deps.handle, request.params.id),
  );
}
