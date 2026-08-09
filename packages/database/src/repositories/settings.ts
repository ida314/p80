/**
 * The `settings` table (ADR 0019).
 *
 * The table has been in migration 0001 since the contracts were extracted and was never
 * written to; this is what it was for. Rows are the **override** — a key with no row takes
 * its value from `loadConfig()`, and clearing a row reverts to that.
 *
 * The three primitives moved here from `profile.ts`, where they had been sitting next to
 * the profile repository for want of a better home. `index.ts` re-exports both files with
 * `export *`, so the package's public surface is unchanged.
 *
 * **API keys are never stored here** (§32.3). Under ADR 0005 there are none to store; the
 * prohibition stands so that a future cloud adapter cannot quietly land one in a row, and
 * `packages/core`'s key registry is where that becomes mechanical rather than remembered.
 */

import { eq, inArray } from 'drizzle-orm';
import {
  EDITABLE_SETTING_KEYS,
  describeSettings,
  isEditableSettingKey,
  now,
  resolveRuntimeSettings,
  type Config,
  type EditableSettingKey,
  type RuntimeSettings,
  type SettingView,
} from '@p80/core';
import type { DatabaseHandle } from '../client.js';
import { settings } from '../schema/ops.js';

export function getSetting<T = unknown>(
  handle: DatabaseHandle,
  key: string,
): T | undefined {
  const row = handle.db.select().from(settings).where(eq(settings.key, key)).all()[0];
  if (!row) return undefined;
  try {
    return JSON.parse(row.valueJson) as T;
  } catch {
    // A row that is not JSON can only come from a hand-edited database. Treating it as
    // absent falls back to the environment, which is a working system; throwing here would
    // fail every request that resolves settings, which is every request.
    return undefined;
  }
}

export function setSetting(handle: DatabaseHandle, key: string, value: unknown): void {
  const ts = now();
  handle.db
    .insert(settings)
    .values({ key, valueJson: JSON.stringify(value), updatedAt: ts })
    .onConflictDoUpdate({
      target: settings.key,
      set: { valueJson: JSON.stringify(value), updatedAt: ts },
    })
    .run();
}

/** Reverts a key to its environment value. Distinct from writing the environment value
 *  into the row: a cleared key keeps tracking `.env.local`, a written one stops. */
export function clearSetting(handle: DatabaseHandle, key: string): boolean {
  const before = handle.db.select().from(settings).where(eq(settings.key, key)).all();
  if (before.length === 0) return false;
  handle.db.delete(settings).where(eq(settings.key, key)).run();
  return true;
}

export function listSettings(handle: DatabaseHandle): Record<string, unknown> {
  const rows = handle.db.select().from(settings).all();
  return Object.fromEntries(
    rows.map((r) => {
      try {
        return [r.key, JSON.parse(r.valueJson)];
      } catch {
        return [r.key, undefined];
      }
    }),
  );
}

/**
 * Only the rows the registry recognises.
 *
 * A row for a key that is no longer editable — a setting that was demoted to boot tier, or
 * one written by an older version — is ignored rather than applied. Applying it would mean
 * honouring an override that nothing reads, which is the failure mode ADR 0019 §2 is
 * organised around avoiding.
 */
function editableOverrides(handle: DatabaseHandle): Record<string, unknown> {
  const rows = handle.db
    .select()
    .from(settings)
    .where(inArray(settings.key, [...EDITABLE_SETTING_KEYS]))
    .all();

  const out: Record<string, unknown> = {};
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.valueJson);
    } catch {
      // Left absent, so `describeSettings` reports the environment value as effective.
    }
  }
  return out;
}

/**
 * **The entry point for every live-key consumer.** Call it per request and per job; never
 * hold the result across one.
 *
 * A SQLite read of at most seven rows costs microseconds, and paying it every time is what
 * removes the window in which the API validates a path against one media root while the
 * worker resolves it against another. That window is the temporal form of the bug ADR 0012
 * records, and a cached-and-invalidated value would reintroduce it.
 */
export function getRuntimeSettings(
  handle: DatabaseHandle,
  config: Config,
): RuntimeSettings {
  return resolveRuntimeSettings(config, editableOverrides(handle));
}

/** The settings surface's rows: both tiers, resolved, labelled, in render order. */
export function getSettingViews(handle: DatabaseHandle, config: Config): SettingView[] {
  return describeSettings(config, editableOverrides(handle));
}

/**
 * Write one editable key, returning what it replaced.
 *
 * The caller has already validated the value against the registry schema — this does not
 * re-validate, because a second validation is a second answer to the same question and the
 * two diverge the first time one changes. It does refuse a non-editable key, which is a
 * different check: that one is about whether the write means anything at all.
 */
export function writeSetting(
  handle: DatabaseHandle,
  key: EditableSettingKey,
  value: string | number | boolean,
): { previous: unknown } {
  if (!isEditableSettingKey(key)) {
    throw new Error(`${key} is not an editable setting; writing it would do nothing.`);
  }
  const previous = getSetting(handle, key);
  setSetting(handle, key, value);
  return { previous };
}
