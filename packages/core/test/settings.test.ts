import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import {
  ASR_DEFAULTS,
  BOOT_SETTING_REASONS,
  EDITABLE_SETTING_KEYS,
  SETTING_DEFINITIONS,
  describeSettings,
  isEditableSettingKey,
  resolveRuntimeSettings,
  settingTier,
  unclassifiedConfigKeys,
} from '../src/settings.js';

const REQUIRED = { P80_MEDIA_ROOT: '/media/library' };
const config = loadConfig(REQUIRED);

/**
 * Stage 2b exit criteria 10 and 11 (ADR 0019).
 *
 * The registry decides which configuration a client may change. Two properties matter more
 * than the individual entries: it must cover the whole config, and it must not acquire a
 * key that looks like a credential.
 */
describe('the settings registry', () => {
  it('classifies every configuration key into exactly one tier', () => {
    // A key added to `configSchema` without a tier decision would be invisible on the
    // settings surface, and invisible is the one thing a settings surface must not be.
    expect(unclassifiedConfigKeys()).toEqual([]);
  });

  it('puts no key in both tiers', () => {
    const overlap = EDITABLE_SETTING_KEYS.filter((key) => key in BOOT_SETTING_REASONS);
    expect(overlap).toEqual([]);
  });

  it('reads no key that looks like a credential', () => {
    // `CLAUDE.md` rule 14, one layer further out than `config.test.ts` checks it. Under
    // ADR 0005 there are no keys to store; this makes the prohibition mechanical for the
    // table a future cloud adapter would be tempted to use.
    const forbidden = /(_KEY|_SECRET|_TOKEN|_PASSWORD|_CREDENTIAL)$/;
    const keys = [...EDITABLE_SETTING_KEYS, ...Object.keys(BOOT_SETTING_REASONS)];
    expect(keys.filter((k) => forbidden.test(k))).toEqual([]);
  });

  it('gives every boot key a reason it cannot be live', () => {
    for (const [key, reason] of Object.entries(BOOT_SETTING_REASONS)) {
      expect(reason.length, key).toBeGreaterThan(20);
    }
  });

  it('keeps LAN exposure out of the editable set', () => {
    // ADR 0019 §2: spec §32.5 makes LAN exposure an explicit act with a warning. A
    // browser-reachable toggle would be a weaker guarantee, so this one is not merely a
    // restart problem and must not drift into the live tier.
    expect(isEditableSettingKey('P80_ALLOW_LAN')).toBe(false);
    expect(isEditableSettingKey('P80_BIND_HOST')).toBe(false);
    expect(settingTier('P80_ALLOW_LAN')).toBe('boot');
  });

  it('reports an unknown key as belonging to neither tier', () => {
    expect(settingTier('P80_NOT_A_SETTING')).toBeNull();
  });
});

describe('resolveRuntimeSettings', () => {
  it('takes the environment when no row exists', () => {
    const resolved = resolveRuntimeSettings(config, {});
    expect(resolved.mediaRoot).toBe(config.P80_MEDIA_ROOT);
    expect(resolved.asr.requireGpu).toBe(true);
  });

  it('lets a stored row beat the environment', () => {
    // The reverse precedence would make the surface inert: `P80_MEDIA_ROOT` is required,
    // so every installation sets it (ADR 0019 §1).
    const resolved = resolveRuntimeSettings(config, {
      P80_MEDIA_ROOT: '/other/library',
      P80_ASR_REQUIRE_GPU: false,
    });
    expect(resolved.mediaRoot).toBe('/other/library');
    expect(resolved.asr.requireGpu).toBe(false);
  });

  it('falls back to the environment for a row that no longer parses', () => {
    // A row can only become invalid if the schema tightened under it or someone edited the
    // database by hand. Neither is a reason to fail every request that resolves settings —
    // which is every request.
    const resolved = resolveRuntimeSettings(config, {
      P80_ASR_LANG_MIN_PROB: 'not a number',
      P80_ASR_COMPUTE_TYPE: 'float128',
    });
    expect(resolved.asr.languageMinProbability).toBe(0.5);
    expect(resolved.asr.computeType).toBe('float16');
  });
});

describe('describeSettings', () => {
  it('reports the source of every value', () => {
    const rows = describeSettings(config, { P80_ASR_MODEL: 'medium' });
    const model = rows.find((r) => r.key === 'P80_ASR_MODEL');
    const device = rows.find((r) => r.key === 'P80_ASR_DEVICE');

    expect(model).toMatchObject({ value: 'medium', source: 'database' });
    // The environment value travels with the row so that reverting is a visible option
    // rather than a remembered one.
    expect(model?.environmentValue).toBe('large-v3');
    expect(device).toMatchObject({ source: 'environment' });
  });

  it('marks an unparseable row as invalid instead of letting it look effective', () => {
    const rows = describeSettings(config, { P80_ASR_LANG_MIN_PROB: 'nonsense' });
    const row = rows.find((r) => r.key === 'P80_ASR_LANG_MIN_PROB');
    expect(row?.source).toBe('environment');
    expect(row?.invalid).toBeTruthy();
  });

  it('includes the boot tier, read-only, with a reason', () => {
    // A settings page that omits the port it is served on is one the user will not trust.
    const rows = describeSettings(config);
    const port = rows.find((r) => r.key === 'P80_API_PORT');
    expect(port).toMatchObject({ tier: 'boot', editable: false, control: 'readonly' });
    expect(port?.description).toContain('.env.local');
  });

  it('gives every editable setting a description a stranger could act on', () => {
    for (const key of EDITABLE_SETTING_KEYS) {
      expect(SETTING_DEFINITIONS[key].description.length, key).toBeGreaterThan(40);
    }
  });
});

/**
 * Stage 2b exit criterion 10 — the cross-language pin.
 *
 * P80 sends the ASR options with every request, so this table is what actually runs. The
 * Python fallback in `asr.py` must agree with it: two defaults that quietly disagreed
 * would surface as a model change nobody made. `services/nlp/tests/test_transcribe.py`
 * asserts the same equality from the other side.
 */
describe('ASR defaults', () => {
  it('match the schema they are meant to describe', () => {
    expect(config.P80_ASR_MODEL).toBe(ASR_DEFAULTS.P80_ASR_MODEL);
    expect(config.P80_ASR_DEVICE).toBe(ASR_DEFAULTS.P80_ASR_DEVICE);
    expect(config.P80_ASR_COMPUTE_TYPE).toBe(ASR_DEFAULTS.P80_ASR_COMPUTE_TYPE);
    expect(config.P80_ASR_REQUIRE_GPU).toBe(ASR_DEFAULTS.P80_ASR_REQUIRE_GPU);
    expect(config.P80_ASR_ALIGN).toBe(ASR_DEFAULTS.P80_ASR_ALIGN);
    expect(config.P80_ASR_LANG_MIN_PROB).toBe(ASR_DEFAULTS.P80_ASR_LANG_MIN_PROB);
  });

  it('match the Python fallback table field for field', () => {
    const source = readFileSync(
      join(
        dirname(fileURLToPath(import.meta.url)),
        '../../../services/nlp/src/p80_nlp/asr.py',
      ),
      'utf8',
    );
    const block = /DEFAULTS: dict\[str, object\] = \{([\s\S]*?)\}/.exec(source)?.[1];
    expect(block, 'DEFAULTS not found in asr.py').toBeTruthy();

    const python = Object.fromEntries(
      [...(block ?? '').matchAll(/"(\w+)":\s*([^,\n]+),/g)].map(([, k, v]) => [
        k,
        (v ?? '').trim(),
      ]),
    );

    expect(python).toEqual({
      model_id: `"${ASR_DEFAULTS.P80_ASR_MODEL}"`,
      device: `"${ASR_DEFAULTS.P80_ASR_DEVICE}"`,
      compute_type: `"${ASR_DEFAULTS.P80_ASR_COMPUTE_TYPE}"`,
      require_gpu: ASR_DEFAULTS.P80_ASR_REQUIRE_GPU ? 'True' : 'False',
      align: ASR_DEFAULTS.P80_ASR_ALIGN ? 'True' : 'False',
      language_min_probability: String(ASR_DEFAULTS.P80_ASR_LANG_MIN_PROB),
    });
  });
});
