import { eq } from 'drizzle-orm';
import { newId, now } from '@p80/core';
import type { DatabaseHandle } from '../client.js';
import { profiles } from '../schema/profile.js';
import { settings } from '../schema/ops.js';

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

/**
 * Key-value settings. API keys are never stored here (§32.3) — under ADR 0005 there are
 * none to store, and the prohibition stands so that a future cloud adapter cannot
 * quietly land one in a row.
 */
export function getSetting<T = unknown>(
  handle: DatabaseHandle,
  key: string,
): T | undefined {
  const row = handle.db.select().from(settings).where(eq(settings.key, key)).all()[0];
  return row ? (JSON.parse(row.valueJson) as T) : undefined;
}

export function setSetting(handle: DatabaseHandle, key: string, value: unknown): void {
  handle.db
    .insert(settings)
    .values({ key, valueJson: JSON.stringify(value), updatedAt: now() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson: JSON.stringify(value), updatedAt: now() },
    })
    .run();
}

export function listSettings(handle: DatabaseHandle): Record<string, unknown> {
  const rows = handle.db.select().from(settings).all();
  return Object.fromEntries(rows.map((r) => [r.key, JSON.parse(r.valueJson)]));
}
