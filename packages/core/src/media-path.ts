/**
 * Where a media file may live, and why an attacker cannot point P80 anywhere else.
 *
 * `CLAUDE.md` rule 4: a media path is untrusted input. It resolves under `P80_MEDIA_ROOT`
 * or it is rejected — never sanitised into something acceptable. A sanitiser is a claim
 * about every input anyone will ever send; a containment check is a claim about a prefix.
 *
 * Pure path arithmetic, no filesystem access, so every case below is testable in isolation.
 * It lives in `packages/core` rather than in the API for the same reason `storage.ts` does:
 * the API validates on add and on repair, the worker resolves on ingest, and both need the
 * identical answer. `paths.ts` records what happens when two processes disagree about a
 * root.
 *
 * Not re-exported from `@p80/core/browser`. The client never holds a path.
 */

import { isAbsolute, normalize, resolve, sep } from 'node:path';
import { SUPPORTED_MEDIA_EXTENSIONS, type MediaPathRejection } from './media.js';

const MAX_PATH_LENGTH = 1024;

export type MediaPathResult =
  | { ok: true; relativePath: string; absolutePath: string }
  | { ok: false; reason: MediaPathRejection };

/**
 * Resolve a user-supplied path against the media root, or say why not.
 *
 * The order of the checks is load-bearing. Null bytes go first, before anything else
 * touches the string, because a NUL truncates a path in one consumer and not in another —
 * the classic way a check and a use end up looking at different things. Absolute paths are
 * rejected outright rather than accepted when they happen to fall inside: a caller sending
 * `/etc/passwd` is asking a different question than one sending `lektion-3.mp4`, and
 * collapsing the two makes the rejection log useless.
 *
 * `root + sep` in the containment test is not a detail. A bare `startsWith(root)` accepts
 * `/media/library-evil` for a root of `/media/library`.
 */
export function resolveMediaPath(input: string, mediaRoot: string): MediaPathResult {
  if (input.includes('\0')) return { ok: false, reason: 'null_byte' };

  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_PATH_LENGTH) return { ok: false, reason: 'too_long' };
  if (isAbsolute(trimmed)) return { ok: false, reason: 'absolute' };

  const lower = trimmed.toLowerCase();
  if (!SUPPORTED_MEDIA_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return { ok: false, reason: 'unsupported_extension' };
  }

  const root = resolve(mediaRoot);
  const absolutePath = resolve(root, trimmed);
  // `resolve` has already collapsed `..`; this catches the ones that collapsed past the
  // root. The root itself is not a file, so equality is a rejection too.
  if (absolutePath === root || !absolutePath.startsWith(root + sep)) {
    return { ok: false, reason: 'escapes_root' };
  }

  // Store the normalised relative form, not the string as typed. `a//b/./c.mp4` and
  // `a/b/c.mp4` are the same file and must not become two videos — the content hash would
  // catch it eventually, but only after paying for a full ingest.
  const relativePath = normalize(absolutePath.slice(root.length + 1));
  return { ok: true, relativePath, absolutePath };
}

/**
 * The read-side guard, for code that already holds a stored `media_path`.
 *
 * Stored paths were validated on the way in, so this can only fire on a hand-edited
 * database row or a database restored beside a different media root. It costs one string
 * comparison and it is the difference between that mistake being a failed request and
 * being an arbitrary file read. Same shape and same reasoning as `assertInsideRoot` in
 * `storage.ts`.
 */
export function assertInsideMediaRoot(relativePath: string, mediaRoot: string): string {
  const result = resolveMediaPath(relativePath, mediaRoot);
  if (!result.ok) {
    throw new Error(
      `Refusing to read media outside the media root (${result.reason}). A stored path ` +
        'failed the check it passed on the way in.',
    );
  }
  return result.absolutePath;
}
