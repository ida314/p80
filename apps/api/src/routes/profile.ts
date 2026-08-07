import { z } from 'zod';
import type { DatabaseHandle } from '@p80/database';
import { ensureProfile, updateProfile } from '@p80/database';
import type { App } from '../app.js';

const profileResponse = z.object({
  id: z.string(),
  nativeLanguage: z.string(),
  targetLanguage: z.string(),
  proficiencyLabel: z.string().nullable(),
  learningPurpose: z.string().nullable(),
  dailyMinutes: z.number(),
  newItemLimit: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});

const profilePatch = z.object({
  proficiencyLabel: z
    .enum([
      'beginner',
      'lower_intermediate',
      'intermediate',
      'upper_intermediate',
      'advanced',
    ])
    .nullable()
    .optional(),
  learningPurpose: z.string().max(500).nullable().optional(),
  dailyMinutes: z.number().int().min(1).max(600).optional(),
  newItemLimit: z.number().int().min(0).max(200).optional(),
});

/**
 * MVP has one profile, so these endpoints take no profile ID — the server resolves it
 * (`03-api.md` §1). The language pair is deliberately **not** patchable: ADR 0001 ships
 * one pair, and a profile switcher is spec §6 non-goal territory. When a second adapter
 * is registered, this is where the field opens up.
 */
export async function registerProfileRoutes(
  app: App,
  deps: { handle: DatabaseHandle },
): Promise<void> {
  app.get(
    '/api/profile',
    { schema: { response: { 200: profileResponse } } },
    async () => ensureProfile(deps.handle),
  );

  app.put(
    '/api/profile',
    { schema: { body: profilePatch, response: { 200: profileResponse } } },
    async (request) => updateProfile(deps.handle, request.body),
  );
}
