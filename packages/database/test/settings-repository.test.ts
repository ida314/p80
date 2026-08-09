import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '@p80/core';
import { openDatabase } from '../src/client.js';
import {
  clearSetting,
  getRuntimeSettings,
  getSetting,
  getSettingViews,
  listSettings,
  setSetting,
  writeSetting,
} from '../src/repositories/settings.js';
import { createTempDatabase, type TempDatabase } from './helpers.js';

/**
 * Stage 2b exit criteria 1 and 2 (ADR 0019 §1).
 *
 * The precedence rule is the whole of this file: **the environment seeds, the row
 * overrides, and clearing the row reverts.** Everything else follows from it.
 */
describe('the settings repository', () => {
  let db: TempDatabase | null = null;
  afterEach(() => {
    db?.dispose();
    db = null;
  });

  const config = loadConfig({ P80_MEDIA_ROOT: '/media/library' });

  it('resolves to the environment when nothing is stored', () => {
    db = createTempDatabase();
    expect(getRuntimeSettings(db, config).mediaRoot).toBe(config.P80_MEDIA_ROOT);
    expect(listSettings(db)).toEqual({});
  });

  it('lets a stored row beat the environment', () => {
    db = createTempDatabase();
    writeSetting(db, 'P80_MEDIA_ROOT', '/elsewhere');
    expect(getRuntimeSettings(db, config).mediaRoot).toBe('/elsewhere');
  });

  it('reverts to the environment when the row is cleared', () => {
    // Distinct from writing the environment value into the row: a cleared key keeps
    // tracking .env.local, a written one stops.
    db = createTempDatabase();
    writeSetting(db, 'P80_MEDIA_ROOT', '/elsewhere');
    expect(clearSetting(db, 'P80_MEDIA_ROOT')).toBe(true);
    expect(getRuntimeSettings(db, config).mediaRoot).toBe(config.P80_MEDIA_ROOT);
    expect(clearSetting(db, 'P80_MEDIA_ROOT')).toBe(false);
  });

  it('survives a reopen, which is what makes it a setting rather than a session', () => {
    const temp = createTempDatabase();
    const path = temp.sqlite.name;
    writeSetting(temp, 'P80_ASR_REQUIRE_GPU', false);
    temp.close();

    const reopened = openDatabase(path);
    try {
      expect(getRuntimeSettings(reopened, config).asr.requireGpu).toBe(false);
    } finally {
      reopened.close();
      temp.dispose();
    }
  });

  it('round-trips each value type through JSON storage', () => {
    db = createTempDatabase();
    writeSetting(db, 'P80_ASR_MODEL', 'medium');
    writeSetting(db, 'P80_ASR_ALIGN', false);
    writeSetting(db, 'P80_ASR_LANG_MIN_PROB', 0.8);

    const resolved = getRuntimeSettings(db, config).asr;
    expect(resolved.model).toBe('medium');
    expect(resolved.align).toBe(false);
    expect(resolved.languageMinProbability).toBe(0.8);
  });

  it('reports where each effective value came from', () => {
    db = createTempDatabase();
    writeSetting(db, 'P80_ASR_MODEL', 'medium');

    const views = getSettingViews(db, config);
    expect(views.find((v) => v.key === 'P80_ASR_MODEL')).toMatchObject({
      value: 'medium',
      source: 'database',
      environmentValue: 'large-v3',
    });
    expect(views.find((v) => v.key === 'P80_ASR_DEVICE')?.source).toBe('environment');
  });

  it('ignores a row for a key that is no longer editable', () => {
    // Applying it would mean honouring an override that nothing reads, which is exactly
    // the failure mode ADR 0019 §2 is organised around avoiding.
    db = createTempDatabase();
    setSetting(db, 'P80_API_PORT', 9999);
    expect(getSettingViews(db, config).find((v) => v.key === 'P80_API_PORT')).toMatchObject(
      { value: config.P80_API_PORT, source: 'environment' },
    );
  });

  it('treats a row that is not JSON as absent rather than failing every request', () => {
    db = createTempDatabase();
    db.sqlite
      .prepare('INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)')
      .run('P80_MEDIA_ROOT', 'not json at all', 0);

    expect(getSetting(db, 'P80_MEDIA_ROOT')).toBeUndefined();
    expect(getRuntimeSettings(db, config).mediaRoot).toBe(config.P80_MEDIA_ROOT);
  });

  it('refuses to write a key that nothing would read', () => {
    db = createTempDatabase();
    expect(() =>
      // @ts-expect-error — the type rejects it too; this is the runtime half.
      writeSetting(db, 'P80_API_PORT', 9999),
    ).toThrow(/not an editable setting/);
  });
});
