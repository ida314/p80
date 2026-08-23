import { statSync } from 'node:fs';
import { z } from 'zod';
import {
  ERROR_CODES,
  MEDIA_ROOT_MESSAGES,
  P80Error,
  SETTING_DEFINITIONS,
  isEditableSettingKey,
  mediaRootPreflightResponse,
  resolveMediaPath,
  settingTier,
  settingsResponse,
  validateMediaRoot,
  type Config,
  type EditableSettingKey,
  type MediaRootResult,
} from '@p80/core';
import {
  ensureProfile,
  getSettingViews,
  listVideoMediaRefs,
  revertSetting,
  setMediaLocation,
  writeSetting,
  type DatabaseHandle,
  type VideoMediaRef,
} from '@p80/database';
import type { App } from '../app.js';

/**
 * `/api/settings` — the configuration surface for both clients (ADR 0019).
 *
 * Three things live here and nowhere else, which is what keeps the TUI and the web page
 * from each growing a half-copy of them (ADR 0007's `curl` test):
 *
 * - **Which keys may be written.** The registry in `packages/core` decides; a boot-tier key
 *   is refused rather than accepted and ignored, because a setting that silently does
 *   nothing is worse than one that is absent.
 * - **What a valid media root is.** Structure, the refusal list, and existence — see
 *   `media-root.ts`, and ADR 0019 §3 for what the refusal list is and is not claiming.
 * - **What changing the media root costs.** Counted, reported, and confirmed before it is
 *   paid.
 *
 * A settings value is text the user typed and is therefore a render surface. It leaves here
 * inside the ordinary JSON envelope and both clients escape it like any other untrusted
 * string (`CLAUDE.md` rule 8) — a media root is not transcript text, but it is not the
 * server's text either.
 */
export async function registerSettingsRoutes(
  app: App,
  deps: { handle: DatabaseHandle; config: Config },
): Promise<void> {
  const { handle, config } = deps;

  app.get(
    '/api/settings',
    { schema: { response: { 200: settingsResponse } } },
    async () => ({ settings: getSettingViews(handle, config) }),
  );

  /**
   * `POST /api/settings/media-root/preflight` — what would happen, without doing it.
   *
   * Separate from the write rather than folded into it, because the surface needs the
   * answer *while the user is typing the path*, before there is anything to confirm.
   * Persists nothing, for the same reason `POST .../transcript/preview` does not.
   */
  app.post(
    '/api/settings/media-root/preflight',
    {
      schema: {
        body: z.object({ path: z.string().max(1024) }),
        response: { 200: mediaRootPreflightResponse },
      },
    },
    async (request) => preflight(handle, config, request.body.path),
  );

  /**
   * `PUT /api/settings` — write one or more editable keys.
   *
   * A batch rather than a per-key route, because the ASR options are edited together and
   * three round trips to change three fields is a worse surface. It is **not atomic across
   * keys** and does not pretend to be: every key is validated first, so a request either
   * fails before writing anything or writes everything it named.
   */
  app.put(
    '/api/settings',
    {
      schema: {
        body: z.object({
          /**
           * `null` reverts a key to its environment value rather than writing one
           * (ADR 0026 §1). It is a value in the same batch rather than a second route,
           * because reverting one ASR option while writing two others is an ordinary edit
           * of one form.
           */
          settings: z.record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean(), z.null()]),
          ),
          /**
           * Required when the media root would stop videos resolving. Named for what it
           * acknowledges rather than `force`: the user is confirming a specific, counted
           * consequence, not overriding a check.
           */
          acknowledgeOrphans: z.boolean().default(false),
        }),
        response: { 200: settingsResponse },
      },
    },
    async (request) => {
      const entries = Object.entries(request.body.settings);
      if (entries.length === 0) {
        throw P80Error.badRequest('No settings were named in the request.');
      }

      // The media root as it stands once this request has been applied, whether that came
      // from a write or a revert. Null when the request did not name it.
      let settledRoot: string | null = null;

      // Validate every key before writing any of them.
      const validated: Array<[EditableSettingKey, string | number | boolean]> = [];
      const reverted: EditableSettingKey[] = [];
      for (const [key, raw] of entries) {
        requireEditable(key);
        if (raw === null) {
          reverted.push(key);
          continue;
        }
        const parsed = SETTING_DEFINITIONS[key].schema.safeParse(raw);
        if (!parsed.success) {
          throw new P80Error(
            ERROR_CODES.VALIDATION_FAILED,
            `${key}: ${parsed.error.issues[0]?.message ?? 'invalid value'}`,
            { statusCode: 400, details: { key } },
          );
        }
        validated.push([key, parsed.data]);
      }

      /**
       * What the media root would become, whichever way it was named.
       *
       * A revert is not the safe direction (ADR 0026 §2): the environment value can be a
       * directory that has since been removed, or one holding none of the library. So it
       * runs the same validation and the same orphan count as a write, and the only thing
       * that differs afterwards is whether a row is deleted or inserted.
       */
      const mediaRoot = validated.find(([key]) => key === 'P80_MEDIA_ROOT');
      const revertsMediaRoot = reverted.includes('P80_MEDIA_ROOT');
      const proposedRoot = mediaRoot
        ? String(mediaRoot[1])
        : revertsMediaRoot
          ? config.P80_MEDIA_ROOT
          : null;

      if (proposedRoot !== null) {
        const result = validateMediaRoot(proposedRoot, config.P80_STORAGE_PATH);
        if (!result.ok) {
          throw new P80Error(
            ERROR_CODES.INVALID_MEDIA_ROOT,
            MEDIA_ROOT_MESSAGES[result.reason],
            { statusCode: 400, details: { reason: result.reason } },
          );
        }

        const impact = assessMediaRoot(handle, result.path);
        if (impact.orphaned > 0 && !request.body.acknowledgeOrphans) {
          throw new P80Error(
            ERROR_CODES.MEDIA_ROOT_WOULD_ORPHAN,
            `${impact.orphaned} of your ${impact.videoCount} videos would stop resolving under this media root and could not be played until it is changed back. Nothing is deleted: transcripts, corrections, and review history are unaffected, and setting the root back restores playback exactly.`,
            {
              statusCode: 409,
              details: {
                videoCount: impact.videoCount,
                resolved: impact.resolved,
                orphaned: impact.orphaned,
                orphanedSample: impact.orphanedSample,
              },
            },
          );
        }

        // Store the normalised absolute form, not the string as typed. `/library/` and
        // `/library` are the same directory and must not be two different roots — the
        // containment check compares string prefixes. A revert stores nothing, so it takes
        // the normalised path only for the recompute below.
        if (mediaRoot) mediaRoot[1] = result.path;
        settledRoot = result.path;
      }

      for (const [key, value] of validated) {
        const { previous } = writeSetting(handle, key, value);
        if (key === 'P80_MEDIA_ROOT') {
          // Logged at warn, with both values, because this is the setting that decides what
          // is reachable at all — and the one whose change explains a library that has
          // suddenly gone missing.
          request.log.warn(
            { setting: key, previous: previous ?? config.P80_MEDIA_ROOT, next: value },
            'media root changed',
          );
        } else {
          request.log.info({ setting: key, next: value }, 'setting changed');
        }
      }

      for (const key of reverted) {
        const { previous, cleared } = revertSetting(handle, key);
        // `cleared: false` means there was no row. Reported rather than silent, because
        // "reverted" and "was never overridden" look identical in the response.
        const next = config[key];
        if (key === 'P80_MEDIA_ROOT') {
          request.log.warn(
            { setting: key, previous: previous ?? next, next, cleared },
            'media root reverted to the environment',
          );
        } else {
          request.log.info({ setting: key, next, cleared }, 'setting reverted');
        }
      }

      if (settledRoot !== null) {
        recomputeMediaMissing(handle, settledRoot);
      }

      return { settings: getSettingViews(handle, config) };
    },
  );
}

/**
 * A key that cannot be written, and *why* it cannot.
 *
 * The two cases are kept apart because they mean different things to a user: an unknown key
 * is a mistake in the request, and a boot-tier key is a real setting they have to restart
 * to change. Collapsing them into "invalid key" would send someone hunting for a typo that
 * is not there.
 */
function requireEditable(key: string): asserts key is EditableSettingKey {
  if (isEditableSettingKey(key)) return;

  const tier = settingTier(key);
  if (tier === 'boot') {
    throw new P80Error(
      ERROR_CODES.SETTING_NOT_EDITABLE,
      `${key} is read at startup, so changing it here would have no effect. Set it in .env.local and restart P80.`,
      { statusCode: 400, details: { key, reason: 'boot_tier' } },
    );
  }
  throw new P80Error(
    ERROR_CODES.SETTING_NOT_EDITABLE,
    `${key} is not a P80 setting.`,
    { statusCode: 400, details: { key, reason: 'unknown_key' } },
  );
}

interface MediaRootImpact {
  videoCount: number;
  resolved: number;
  orphaned: number;
  orphanedSample: Array<{ id: string; title: string }>;
}

/** How many videos would still find their file under a proposed root. Bounded work: one
 *  `statSync` per video, which is a personal library, not a crawl. */
function assessMediaRoot(handle: DatabaseHandle, root: string): MediaRootImpact {
  const profile = ensureProfile(handle);
  const videos = listVideoMediaRefs(handle, profile.id);

  let resolved = 0;
  const orphans: VideoMediaRef[] = [];
  for (const video of videos) {
    if (resolvesUnder(video.mediaPath, root)) resolved += 1;
    else orphans.push(video);
  }

  return {
    videoCount: videos.length,
    resolved,
    orphaned: orphans.length,
    // Enough to name the problem, not enough to be a second list endpoint.
    orphanedSample: orphans.slice(0, 10).map((v) => ({
      id: v.id,
      title: v.title ?? '(untitled)',
    })),
  };
}

/**
 * Whether a stored relative path finds a file under this root.
 *
 * Runs the same containment check the read path does rather than only joining strings: a
 * stored path that escapes the *proposed* root is not resolvable under it, and counting it
 * as resolved would report a video as fine that `GET .../media` will refuse to serve.
 */
function resolvesUnder(mediaPath: string | null, root: string): boolean {
  if (mediaPath === null) return false;
  const contained = resolveMediaPath(mediaPath, root);
  if (!contained.ok) return false;
  try {
    return statSync(contained.absolutePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Bring `videos.media_missing` back in line with the new root.
 *
 * Without this the library list stays stale until each video is opened, which is the
 * failure mode the flag exists to avoid — and after a root change, *every* row is
 * potentially wrong at once rather than one at a time.
 */
function recomputeMediaMissing(handle: DatabaseHandle, root: string): void {
  const profile = ensureProfile(handle);
  for (const video of listVideoMediaRefs(handle, profile.id)) {
    const missing = !resolvesUnder(video.mediaPath, root);
    if (missing !== video.mediaMissing) {
      setMediaLocation(handle, video.id, { mediaMissing: missing });
    }
  }
}

function preflight(handle: DatabaseHandle, config: Config, input: string) {
  const result: MediaRootResult = validateMediaRoot(input, config.P80_STORAGE_PATH);

  if (!result.ok) {
    return {
      path: null,
      valid: false,
      reason: result.reason,
      message: MEDIA_ROOT_MESSAGES[result.reason],
      // The counts are about the proposed root, and there is no proposed root. Zeroes
      // rather than the current library's numbers, which would read as a prediction.
      videoCount: 0,
      resolved: 0,
      orphaned: 0,
      orphanedSample: [],
    };
  }

  return {
    path: result.path,
    valid: true,
    reason: null,
    message: null,
    ...assessMediaRoot(handle, result.path),
  };
}
