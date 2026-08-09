import { eq } from 'drizzle-orm';
import { newId, now } from '@p80/core';
import type { DatabaseHandle } from '../client.js';
import { profiles } from '../schema/profile.js';

export interface Profile {
  id: string;
  nativeLanguage: string;
  targetLanguage: string;
  proficiencyLabel: string | null;
  learningPurpose: string | null;
  dailyMinutes: number;
  newItemLimit: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProfileUpdate {
  nativeLanguage?: string;
  targetLanguage?: string;
  proficiencyLabel?: string | null;
  learningPurpose?: string | null;
  dailyMinutes?: number;
  newItemLimit?: number;
}

/**
 * MVP has one profile (`03-api.md` §1). Endpoints do not take a profile ID; the server
 * resolves the single profile here, and handlers still pass `profileId` down into the
 * service layer so that adding multiple profiles later is a routing change rather than a
 * rewrite.
 *
 * ADR 0001: German → English is the one shipping pair. The target language is a column
 * rather than a constant because the `LanguageAdapter` registry is keyed on it.
 */
export function ensureProfile(handle: DatabaseHandle): Profile {
  const existing = handle.db.select().from(profiles).limit(1).all()[0];
  if (existing) return existing as Profile;

  const ts = now();
  const row: Profile = {
    id: newId(),
    nativeLanguage: 'en',
    targetLanguage: 'de',
    proficiencyLabel: null,
    learningPurpose: null,
    dailyMinutes: 20,
    newItemLimit: 10,
    createdAt: ts,
    updatedAt: ts,
  };
  handle.db.insert(profiles).values(row).run();
  return row;
}

export function getProfile(handle: DatabaseHandle): Profile | null {
  return (handle.db.select().from(profiles).limit(1).all()[0] as Profile) ?? null;
}

export function updateProfile(handle: DatabaseHandle, patch: ProfileUpdate): Profile {
  const current = ensureProfile(handle);
  const next = { ...current, ...patch, updatedAt: now() };
  handle.db.update(profiles).set(next).where(eq(profiles.id, current.id)).run();
  return next;
}

// The key-value settings helpers moved to `repositories/settings.ts` when ADR 0019 gave
// the table a job. `index.ts` re-exports both files, so nothing importing them changed.
