import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  ERROR_CODES,
  MEDIA_PATH_MESSAGES,
  P80Error,
  SUPPORTED_MEDIA_EXTENSIONS,
  isInsideUploadDirectory,
  libraryDeleteResponse,
  libraryListingResponse,
  resolveMediaDir,
  type Config,
  type LibraryEntryPayload,
} from '@p80/core';
import {
  ensureProfile,
  getRuntimeSettings,
  listVideoMediaRefs,
  setMediaLocation,
  type DatabaseHandle,
} from '@p80/database';
import type { App } from '../app.js';
import { deleteLibraryFile } from '../services/media-uploads.js';
import { requireMediaPath } from './media.js';

/**
 * Looking at the media library, and removing what P80 put in it (ADR 0024 §§5, 8).
 *
 * Until now nothing enumerated `P80_MEDIA_ROOT`. Adding a video meant typing a relative
 * path into a text field with no way to check what was actually there — which is tolerable
 * when the browser and the library are on one machine and is not when they are not. The
 * `canAdd` flag on each entry makes this a second, better route to `POST /api/videos`, and
 * that is arguably the more valuable half of this feature.
 *
 * **One directory level per request.** A recursive walk is unbounded work on every request
 * for a library that may be hundreds of gigabytes, and the interface wants a directory
 * browser anyway.
 *
 * The listing never leaves the root, never follows a symlink, and never shows a dotfile —
 * which is also what keeps the in-flight `.p80-partial` directory out of sight without a
 * special case for it.
 */

const listQuery = z.object({
  /** Media-root-relative. Empty is the root, which is the first screen. */
  path: z.string().max(1024).default(''),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
  cursor: z.coerce.number().int().min(0).default(0),
});

const deleteQuery = z.object({
  path: z.string().min(1).max(1024),
  /** The second half of the two-step refusal, matching `acknowledgeOrphans` on
   *  `PUT /api/settings` and `replace` on a transcript upload. */
  acknowledgeVideos: z.coerce.boolean().default(false),
});

export async function registerLibraryRoutes(
  app: App,
  deps: { handle: DatabaseHandle; config: Config },
): Promise<void> {
  const { handle, config } = deps;

  app.get(
    '/api/library',
    { schema: { querystring: listQuery, response: { 200: libraryListingResponse } } },
    async (request) => {
      const profile = ensureProfile(handle);
      const { mediaRoot } = getRuntimeSettings(handle, config);

      const target = resolveMediaDir(request.query.path, mediaRoot);
      if (!target.ok) {
        throw new P80Error(ERROR_CODES.INVALID_MEDIA_PATH, MEDIA_PATH_MESSAGES[target.reason], {
          statusCode: 400,
          details: { reason: target.reason },
        });
      }

      let names: string[];
      try {
        names = readdirSync(target.absolutePath);
      } catch {
        throw new P80Error(
          ERROR_CODES.MEDIA_FILE_NOT_FOUND,
          target.relativePath === ''
            ? 'The media library folder could not be read. Check the media root in Settings.'
            : `There is no folder at ${target.relativePath} inside the media library.`,
          { statusCode: 404, details: { path: target.relativePath } },
        );
      }

      // One scan of `videos`, turned into a lookup. The settings preflight already does a
      // full scan per request for the same reason: four columns across a personal library
      // is nothing. If a library ever passes a few thousand videos this becomes a
      // `WHERE media_path IN (...)`, which is a change to this line and nothing else.
      const byPath = new Map(
        listVideoMediaRefs(handle, profile.id)
          .filter((ref): ref is typeof ref & { mediaPath: string } => ref.mediaPath !== null)
          .map((ref) => [ref.mediaPath, ref]),
      );

      const entries = names
        // A dotfile in a media library is not media. This is also what hides
        // `.p80-partial`, so a half-received upload never looks like something playable.
        .filter((name) => !name.startsWith('.'))
        .map((name) => describeEntry({ name, dir: target, byPath }))
        .filter((entry): entry is LibraryEntryPayload => entry !== null)
        .sort(compareEntries);

      const page = entries.slice(request.query.cursor, request.query.cursor + request.query.limit);
      const nextIndex = request.query.cursor + page.length;

      return {
        path: target.relativePath,
        parent: parentOf(target.relativePath),
        entries: page,
        truncated: nextIndex < entries.length,
        nextCursor: nextIndex < entries.length ? String(nextIndex) : null,
      };
    },
  );

  /**
   * `DELETE /api/library/file` — remove a file P80 wrote.
   *
   * **Query parameters rather than a body**, for a reason ADR 0023 made live: some reverse
   * proxies strip a body from a DELETE, and a confirmation flag that silently vanishes in
   * transit would turn a refusal into an unacknowledged deletion.
   *
   * Two guards, in this order. The path must be under `uploads/`, because P80 deletes what
   * P80 wrote and a file the user copied in is theirs. Then, if any video references it,
   * the first call is refused with those videos named and only an acknowledged second call
   * proceeds.
   *
   * When it does proceed **nothing cascades**. Each referencing video is marked
   * `media_missing`, which is exactly ADR 0018 §3's repairable dangling link: the
   * transcript, the items, the cards, and the review history all survive, and the repair
   * affordance the UI already has appears on the next load. `media_path` is deliberately
   * left in place, so the listing can say *"lektion-3.mp4 — missing"* rather than
   * *"missing"*, and so repair can pre-fill.
   */
  app.delete(
    '/api/library/file',
    { schema: { querystring: deleteQuery, response: { 200: libraryDeleteResponse } } },
    async (request) => {
      const profile = ensureProfile(handle);
      const { mediaRoot } = getRuntimeSettings(handle, config);

      // The same containment check `POST /api/videos` runs. One implementation, one story.
      const resolved = requireMediaPath(request.query.path, mediaRoot);

      if (!isInsideUploadDirectory(resolved.relativePath)) {
        throw new P80Error(
          ERROR_CODES.MEDIA_DELETE_REFUSED,
          'P80 only removes files it put in the library itself, which live in the uploads folder. Delete anything else with your own file manager.',
          { statusCode: 403, details: { path: resolved.relativePath } },
        );
      }

      const referencing = listVideoMediaRefs(handle, profile.id).filter(
        (ref) => ref.mediaPath === resolved.relativePath,
      );

      if (referencing.length > 0 && !request.query.acknowledgeVideos) {
        throw P80Error.conflict(
          ERROR_CODES.MEDIA_FILE_IN_USE,
          referencing.length === 1
            ? 'A video still uses this file. Deleting it leaves that video without playback; its transcript, items, and review history are unaffected.'
            : `${referencing.length} videos still use this file. Deleting it leaves them without playback; their transcripts, items, and review history are unaffected.`,
          {
            // Fall back to the filename when a video was never given a title. This
            // message is the whole basis on which the user decides whether to go ahead,
            // and "a video" with a blank name tells them nothing they can act on.
            videos: referencing.map((ref) => ({
              id: ref.id,
              title: ref.title ?? resolved.relativePath.split('/').pop() ?? resolved.relativePath,
            })),
          },
        );
      }

      deleteLibraryFile(resolved.absolutePath);

      for (const ref of referencing) {
        setMediaLocation(handle, ref.id, { mediaMissing: true });
      }

      return {
        deleted: true as const,
        path: resolved.relativePath,
        markedMissing: referencing.length,
      };
    },
  );
}

function describeEntry(args: {
  name: string;
  dir: { relativePath: string; absolutePath: string };
  byPath: Map<string, { id: string; title: string | null; mediaMissing: boolean }>;
}): LibraryEntryPayload | null {
  const { name, dir, byPath } = args;
  const relativePath = dir.relativePath === '' ? name : `${dir.relativePath}/${name}`;

  let stats;
  try {
    // `lstat`, so a symlink is reported as itself rather than as whatever it points at.
    // Following one would let a link inside the library present a file outside it as an
    // ordinary entry — the hole `realPathEscapesRoot` closes on the read side, and there
    // is no reason to open it again here.
    stats = lstatSync(join(dir.absolutePath, name));
  } catch {
    // Vanished between the readdir and the stat. Nothing useful to show.
    return null;
  }

  const kind = stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file';
  const supported =
    kind === 'file' && SUPPORTED_MEDIA_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext));
  const video = byPath.get(relativePath) ?? null;

  return {
    name,
    path: relativePath,
    kind,
    sizeBytes: kind === 'file' ? stats.size : null,
    modifiedAt: Math.floor(stats.mtimeMs),
    supported,
    video: video
      ? { id: video.id, title: video.title ?? name, mediaMissing: video.mediaMissing }
      : null,
    canAdd: supported && video === null,
    // Only ever true under `uploads/`. The client renders no button for anything else,
    // rather than offering one that comes back 403.
    deletable: kind === 'file' && isInsideUploadDirectory(relativePath),
  };
}

/** Directories first, then by name. A media library is browsed by walking into things, so
 *  burying the folders among two hundred files makes the common action the hard one. */
function compareEntries(a: LibraryEntryPayload, b: LibraryEntryPayload): number {
  if (a.kind !== b.kind) {
    if (a.kind === 'directory') return -1;
    if (b.kind === 'directory') return 1;
  }
  return a.name.localeCompare(b.name);
}

function parentOf(relativePath: string): string | null {
  if (relativePath === '') return null;
  const cut = relativePath.lastIndexOf('/');
  return cut === -1 ? '' : relativePath.slice(0, cut);
}
