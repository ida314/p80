/**
 * What may become the media root, now that a client can set one (ADR 0019 §3).
 *
 * `media-path.ts` answers "may this path be read, given a root". This file answers the
 * question underneath it: "may this be the root". Those were the same question while the
 * root came from a file only the operator could edit; they stopped being the same question
 * the moment a `PUT` could change it.
 *
 * **The refusal list below is not a security boundary and is not claimed as one.** A caller
 * that can reach the API can still choose a directory full of media, and no list of prefixes
 * changes that. The actual boundary is unchanged: loopback binding, strict CORS, and the
 * extension allowlist in `media-path.ts`. What this buys is that the worst single keystroke
 * is not `/` — a mistyped root that would expose every media file on the machine is
 * refused rather than accepted with a shrug.
 *
 * Unlike `media-path.ts`, this touches the filesystem: a root that does not exist is a typo,
 * and reporting it as a typo beats reporting it as an empty library.
 */

import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute, normalize, resolve, sep } from 'node:path';

const MAX_PATH_LENGTH = 1024;

export type MediaRootRejection =
  | 'empty'
  | 'null_byte'
  | 'too_long'
  | 'not_absolute'
  | 'filesystem_root'
  | 'system_directory'
  | 'inside_storage'
  | 'not_found'
  | 'not_a_directory'
  | 'not_readable';

export type MediaRootResult =
  | { ok: true; path: string }
  | { ok: false; reason: MediaRootRejection };

/**
 * Directories whose contents are the operating system's, not a media library's.
 *
 * A root at or inside any of them is refused. `/home`, `/mnt`, `/media`, `/srv`, `/opt`,
 * and `/tmp` are deliberately absent — all of them are places a person reasonably keeps
 * video, and refusing them would make the list a nuisance rather than a guard.
 */
const SYSTEM_PREFIXES = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/usr',
  '/var',
  '/run',
] as const;

/** Human-readable, safe to display, and specific about what to do instead. These reach the
 *  user through the error envelope, so a message that only says "invalid" would be a
 *  rejection they cannot act on. */
export const MEDIA_ROOT_MESSAGES: Readonly<Record<MediaRootRejection, string>> = {
  empty: 'A media root is required. It has no default, because a default would silently make an empty directory your library.',
  null_byte: 'That path contains a null byte and was not read any further.',
  too_long: `A media root must be at most ${MAX_PATH_LENGTH} characters.`,
  not_absolute:
    'A media root must be an absolute path. A relative one would mean something different in each of P80’s processes, and they would disagree about what is reachable.',
  filesystem_root:
    'The filesystem root cannot be a media library. Choose the directory your videos are actually in.',
  system_directory:
    'That is a system directory. Choose a directory that holds your own media.',
  inside_storage:
    'That is inside P80’s own storage directory, which holds transcripts and never media. Choose a directory outside it.',
  not_found: 'There is no directory at that path.',
  not_a_directory: 'That path is a file, not a directory.',
  not_readable: 'That directory exists but cannot be read with P80’s permissions.',
};

/**
 * Validate a proposed media root.
 *
 * Order matters for the same reason it does in `resolveMediaPath`: the NUL check runs
 * before anything else touches the string, because a NUL truncates a path in one consumer
 * and not in another, and the structural checks run before the filesystem ones so a
 * hostile value is rejected without a syscall.
 *
 * `storagePath` is passed rather than read from config so this stays a pure argument-in,
 * answer-out function that a test can drive without an environment.
 */
export function validateMediaRoot(input: string, storagePath: string): MediaRootResult {
  if (input.includes('\0')) return { ok: false, reason: 'null_byte' };

  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_PATH_LENGTH) return { ok: false, reason: 'too_long' };
  if (!isAbsolute(trimmed)) return { ok: false, reason: 'not_absolute' };

  const path = normalize(resolve(trimmed));

  if (path === sep) return { ok: false, reason: 'filesystem_root' };
  if (SYSTEM_PREFIXES.some((prefix) => isAtOrInside(path, prefix))) {
    return { ok: false, reason: 'system_directory' };
  }
  // Rule 3: `P80_STORAGE_PATH` holds transcripts and derived artifacts, never media. A root
  // that contained it would make that statement false by construction.
  if (isAtOrInside(path, resolve(storagePath))) {
    return { ok: false, reason: 'inside_storage' };
  }

  let stats;
  try {
    stats = statSync(path);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!stats.isDirectory()) return { ok: false, reason: 'not_a_directory' };

  try {
    // Both bits: readable lists the directory, executable traverses into it. A directory
    // with one and not the other fails later, in a job, with a much worse message.
    accessSync(path, constants.R_OK | constants.X_OK);
  } catch {
    return { ok: false, reason: 'not_readable' };
  }

  return { ok: true, path };
}

/**
 * `prefix + sep` for the same reason `resolveMediaPath` uses it: a bare `startsWith`
 * treats `/usr-videos` as being inside `/usr`.
 */
function isAtOrInside(path: string, prefix: string): boolean {
  return path === prefix || path.startsWith(prefix.endsWith(sep) ? prefix : prefix + sep);
}
