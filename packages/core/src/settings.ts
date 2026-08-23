/**
 * Which configuration can change while P80 runs, and what a valid value for it is
 * (ADR 0019).
 *
 * The distinction this file encodes is not "important" versus "unimportant". It is
 * **whether every consumer reads the key at the point of use.** A port is consumed by
 * `listen()` before any request exists, so a row overriding it would be honoured by
 * nothing — and a setting that silently does nothing is worse than a setting that is
 * absent. Those keys are shown and refused. The media root and the ASR options are
 * re-read per request and per job, so they can be written.
 *
 * `loadConfig()` still produces the boot-time snapshot, and that snapshot is the **seed**:
 * a key with no stored row takes its value from there. Writing a row makes the row
 * authoritative; clearing it reverts. `resolveRuntimeSettings` is the only place those two
 * are combined, and the only thing a live-key consumer should call.
 *
 * Nothing here touches the filesystem or the database. The media root's existence check
 * lives in `media-root.ts`, and the row read lives in `@p80/database` — this file is the
 * registry both of them are keyed on.
 */

import { z } from 'zod';
import type { SettingViewPayload } from './api-types.js';
import { configSchema, type Config } from './config.js';

/**
 * Keys a client may write. Ordered as the settings surface renders them: the one that
 * decides whether anything works at all, then the transcription options.
 */
export const EDITABLE_SETTING_KEYS = [
  'P80_MEDIA_ROOT',
  'P80_ASR_MODEL',
  'P80_ASR_DEVICE',
  'P80_ASR_COMPUTE_TYPE',
  'P80_ASR_REQUIRE_GPU',
  'P80_ASR_ALIGN',
  'P80_ASR_LANG_MIN_PROB',
  'P80_ASR_CONDITION_ON_PREVIOUS_TEXT',
] as const;

export type EditableSettingKey = (typeof EDITABLE_SETTING_KEYS)[number];

/**
 * Keys the surface displays but refuses to write, each with the reason it cannot be live.
 *
 * Listed explicitly rather than derived as "everything else", so that adding a key to
 * `configSchema` without deciding which tier it belongs to fails a test instead of
 * defaulting into invisibility.
 */
export const BOOT_SETTING_REASONS = {
  P80_BIND_HOST:
    'Consumed by listen() at startup. Changing where P80 binds is also an exposure decision (spec §32.5), which is deliberately not something a page can do.',
  P80_ALLOW_LAN:
    'Opting into LAN exposure warns first and is an explicit act (spec §32.5). A browser-reachable toggle would be a weaker guarantee than the one the spec asks for.',
  P80_TRUSTED_ORIGINS:
    'Widening the CORS allowlist is an exposure decision (ADR 0023), and a page that could add its own origin would be deciding who may talk to the API. Same reasoning as P80_ALLOW_LAN, and the allowlist is read once when the CORS hook is built.',
  P80_API_PORT: 'Consumed by listen() at startup.',
  P80_WEB_PORT: 'Consumed by the dev server and by the CORS allowlist at startup.',
  P80_NLP_PORT: 'Consumed by the sidecar process at startup.',
  P80_DB_PATH:
    'The database is open before this could be read, and the setting lives inside it.',
  P80_STORAGE_PATH:
    'Moving it would strand every uploaded transcript file already written under the old path.',
  P80_LOG_LEVEL:
    'The logger is built once per process. Nothing reads this at the point of use.',
  P80_NLP_BASE_URL: 'Read when the ASR client is constructed, once per worker process.',
  P80_VLLM_BASE_URL: 'No consumer exists yet; inference arrives in Stage 6.',
  P80_VLLM_MODEL_ID: 'No consumer exists yet; inference arrives in Stage 6.',
} as const satisfies Record<string, string>;

export type BootSettingKey = keyof typeof BOOT_SETTING_REASONS;
export type SettingKey = EditableSettingKey | BootSettingKey;

export type SettingTier = 'live' | 'boot';
export type SettingSource = 'environment' | 'database';

export interface SettingDefinition {
  key: EditableSettingKey;
  /** Parses and validates both directions: the API validates a write with this, and a
   *  stored row is read back through it. One definition of valid, not two. */
  schema: z.ZodType<string | number | boolean>;
  /** Rendered next to the field. Written for someone who has not read the ADR. */
  description: string;
  /** What the surface should draw. `path` gets the preflight treatment; the rest are
   *  ordinary fields. */
  control: 'path' | 'text' | 'boolean' | 'number' | 'choice';
  choices?: readonly string[];
}

/**
 * The ASR defaults live here rather than in `asr.py`, which is a change ADR 0019 §5 makes
 * deliberately: the sidecar no longer holds settings of its own that a user could edit.
 *
 * **`services/nlp/src/p80_nlp/asr.py` carries the same table** as the fallback for direct
 * callers and for its own tests. The two are pinned to identical values by
 * `test/settings.test.ts` here and `test_transcribe.py` there, because two defaults that
 * quietly disagree would surface as a model change nobody made.
 */
export const ASR_DEFAULTS = {
  P80_ASR_MODEL: 'large-v3',
  P80_ASR_DEVICE: 'cuda',
  P80_ASR_COMPUTE_TYPE: 'float16',
  P80_ASR_REQUIRE_GPU: true,
  P80_ASR_ALIGN: true,
  P80_ASR_LANG_MIN_PROB: 0.5,
  P80_ASR_CONDITION_ON_PREVIOUS_TEXT: false,
} as const;

export const SETTING_DEFINITIONS: Record<EditableSettingKey, SettingDefinition> = {
  P80_MEDIA_ROOT: {
    key: 'P80_MEDIA_ROOT',
    // Structural only. Absoluteness, the refusal list, and existence are `validateMediaRoot`
    // in `media-root.ts` — they need the filesystem, and this schema is also what parses a
    // row back on every read, which must stay cheap.
    schema: z.string().trim().min(1).max(1024),
    description:
      'The only directory P80 reads media from. Videos are added by path relative to it. Changing it does not move, copy, or delete anything — but every video already added resolves against the new root, so files outside it stop playing until you change it back.',
    control: 'path',
  },
  P80_ASR_MODEL: {
    key: 'P80_ASR_MODEL',
    schema: z.string().trim().min(1).max(200),
    description:
      'The Whisper model transcription loads. Larger is more accurate and slower; the model is downloaded on first use and cached.',
    control: 'text',
  },
  P80_ASR_DEVICE: {
    key: 'P80_ASR_DEVICE',
    schema: z.string().trim().min(1).max(50),
    description:
      'Where the model runs. `cuda` for a GPU, `cpu` otherwise. A device index may be appended, as in `cuda:1`.',
    control: 'text',
  },
  P80_ASR_COMPUTE_TYPE: {
    key: 'P80_ASR_COMPUTE_TYPE',
    schema: z.enum(['float16', 'float32', 'int8', 'int8_float16', 'bfloat16']),
    description:
      'Numeric precision. `float16` on a GPU; `int8` is the usual choice on CPU, trading a little accuracy for speed.',
    control: 'choice',
    choices: ['float16', 'float32', 'int8', 'int8_float16', 'bfloat16'],
  },
  P80_ASR_REQUIRE_GPU: {
    key: 'P80_ASR_REQUIRE_GPU',
    schema: z.boolean(),
    description:
      'Refuse to transcribe when a GPU was asked for and is not available. On by default, because falling back silently gives you a device you did not ask for and no way to tell. How much slower CPU is depends on the model: a turbo model can run several times faster than real time on a many-core CPU, while a full large model on the same machine can take longer than the audio. Turn this off to accept whatever CPU gives you here.',
    control: 'boolean',
  },
  P80_ASR_ALIGN: {
    key: 'P80_ASR_ALIGN',
    schema: z.boolean(),
    description:
      'Refine word timings with forced alignment when it is installed. Off means timings come from the model’s own attention weights and are less precise; either way the transcript records which was used.',
    control: 'boolean',
  },
  P80_ASR_LANG_MIN_PROB: {
    key: 'P80_ASR_LANG_MIN_PROB',
    schema: z.number().min(0).max(1),
    description:
      'How confident the model must be that the audio is in another language before the mismatch fails the job rather than warning. An uncertain disagreement is not evidence of anything; a confident one is.',
    control: 'number',
  },
  P80_ASR_CONDITION_ON_PREVIOUS_TEXT: {
    key: 'P80_ASR_CONDITION_ON_PREVIOUS_TEXT',
    schema: z.boolean(),
    description:
      'Give each window of audio the previous window’s text as context. Off by default: it helps continuous speech with consistent terminology, but it also lets an invented phrase become the next window’s prompt, which is how a transcript grows a hallucinated tail and stops being reproducible run to run.',
    control: 'boolean',
  },
};

const EDITABLE = new Set<string>(EDITABLE_SETTING_KEYS);

export function isEditableSettingKey(key: string): key is EditableSettingKey {
  return EDITABLE.has(key);
}

export function settingTier(key: string): SettingTier | null {
  if (isEditableSettingKey(key)) return 'live';
  return key in BOOT_SETTING_REASONS ? 'boot' : null;
}

/**
 * The shape a live-key consumer actually wants — resolved, typed, and named for what it
 * is rather than for the environment variable it came from.
 */
export interface RuntimeSettings {
  /** Absolute. Already anchored, already the effective value. */
  mediaRoot: string;
  asr: AsrOptions;
}

/** Sent to the sidecar per request (ADR 0019 §5), so the sidecar keeps no editable state
 *  of its own. Every field is always present: P80 states what it wants rather than
 *  relying on the other process's environment agreeing with this one's. */
export interface AsrOptions {
  model: string;
  device: string;
  computeType: string;
  requireGpu: boolean;
  align: boolean;
  languageMinProbability: number;
  conditionOnPreviousText: boolean;
}

/**
 * Combine the boot-time snapshot with whatever rows exist. **The row wins.**
 *
 * The reverse precedence was rejected in ADR 0019 §1: `P80_MEDIA_ROOT` is required, so
 * every installation sets it, so environment-wins would make the settings surface inert
 * for the one setting that motivated it.
 *
 * An unparseable row is ignored in favour of the environment rather than throwing. A row
 * can only become invalid if the schema tightened under it or someone edited the database
 * by hand, and neither is a reason to make every request fail — `describeSettings` reports
 * the same row as invalid, which is where a person can see and fix it.
 */
export function resolveRuntimeSettings(
  config: Config,
  overrides: Readonly<Record<string, unknown>> = {},
): RuntimeSettings {
  const value = <K extends EditableSettingKey>(key: K): unknown => {
    if (!(key in overrides)) return config[key];
    const parsed = SETTING_DEFINITIONS[key].schema.safeParse(overrides[key]);
    return parsed.success ? parsed.data : config[key];
  };

  return {
    mediaRoot: value('P80_MEDIA_ROOT') as string,
    asr: {
      model: value('P80_ASR_MODEL') as string,
      device: value('P80_ASR_DEVICE') as string,
      computeType: value('P80_ASR_COMPUTE_TYPE') as string,
      requireGpu: value('P80_ASR_REQUIRE_GPU') as boolean,
      align: value('P80_ASR_ALIGN') as boolean,
      languageMinProbability: value('P80_ASR_LANG_MIN_PROB') as number,
      conditionOnPreviousText: value('P80_ASR_CONDITION_ON_PREVIOUS_TEXT') as boolean,
    },
  };
}

/**
 * One row of the settings surface — everything a client needs to render and label a
 * setting without knowing anything about it.
 *
 * The shape is `api-types.ts`'s, not a second definition of it. That module is
 * browser-safe and this one is not (it reaches `config.ts`, which reaches `node:fs`), so
 * the wire schema has to live there; making this an alias is what keeps the two from
 * drifting.
 */
export type SettingView = SettingViewPayload;

/**
 * Every key in both tiers, resolved and labelled, in render order.
 *
 * Boot keys are included rather than hidden. A settings page that omits the port it is
 * served on is one the user will not trust — and the reason each is read-only is more
 * useful to show than to imply.
 */
export function describeSettings(
  config: Config,
  overrides: Readonly<Record<string, unknown>> = {},
): SettingView[] {
  const live: SettingView[] = EDITABLE_SETTING_KEYS.map((key) => {
    const definition = SETTING_DEFINITIONS[key];
    const environmentValue = config[key];
    const stored = key in overrides ? overrides[key] : undefined;
    const parsed = stored === undefined ? null : definition.schema.safeParse(stored);

    return {
      key,
      tier: 'live' as const,
      value: parsed?.success ? parsed.data : environmentValue,
      source: parsed?.success ? ('database' as const) : ('environment' as const),
      environmentValue,
      editable: true,
      description: definition.description,
      control: definition.control,
      ...(definition.choices ? { choices: [...definition.choices] } : {}),
      ...(parsed && !parsed.success
        ? {
            invalid: `A stored value for this setting could not be read, so the value from the environment is in use. ${parsed.error.issues[0]?.message ?? ''}`.trim(),
          }
        : {}),
    };
  });

  const boot: SettingView[] = (
    Object.keys(BOOT_SETTING_REASONS) as BootSettingKey[]
  ).map((key) => ({
    key,
    tier: 'boot' as const,
    value: config[key],
    source: 'environment' as const,
    environmentValue: config[key],
    editable: false,
    description: `${BOOT_SETTING_REASONS[key]} Change it in .env.local and restart.`,
    control: 'readonly' as const,
  }));

  return [...live, ...boot];
}

/**
 * Asserts the registry covers `configSchema` exactly.
 *
 * Exported rather than left in the test file because it is the mechanical form of a rule
 * that is otherwise remembered: a key added to the config without a tier decision would
 * become invisible on the settings surface, and invisible is the one thing a settings
 * surface must not be. Returns the offending keys; empty means the registry is complete.
 */
export function unclassifiedConfigKeys(): string[] {
  return Object.keys(configSchema.shape).filter((key) => settingTier(key) === null);
}
