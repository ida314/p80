/**
 * Media-source shapes the clients need.
 *
 * Path *validation* is not here — it needs `node:path` and lives in `media-path.ts`, which
 * the browser barrel deliberately does not re-export. Deciding what counts as a usable
 * source is the server's job (ADR 0007 keeps clients out of it): the add-video form does
 * not validate a path locally, it posts and renders the API's answer.
 *
 * What is here is the descriptor a client renders, which is a pure function of a video id
 * the server already validated.
 */

/** `04-providers.md` §1. The server sends this; a client must never build a player from a
 *  filesystem path, which it does not have and must not learn. */
export interface MediaDescriptor {
  kind: 'local_media';
  /** The API route that serves bytes, with Range support. Not a filesystem path. */
  mediaUrl: string;
  /** True when the referenced file is gone. The client offers repair rather than
   *  attempting playback that will 404 (ADR 0018 §3). */
  missing: boolean;
  startSeconds?: number;
  endSeconds?: number;
}

export function buildMediaDescriptor(
  videoId: string,
  options: { missing: boolean; startMs?: number; endMs?: number },
): MediaDescriptor {
  const descriptor: MediaDescriptor = {
    kind: 'local_media',
    mediaUrl: `/api/videos/${encodeURIComponent(videoId)}/media`,
    missing: options.missing,
  };
  // Fractional seconds, not integers. The keyframe-bounded player this replaces could not
  // honour sub-second precision, so rounding cost nothing; a `<video>` seek is exact, and
  // rounding an end time up would play audio the caller did not ask for.
  if (options.startMs !== undefined) {
    descriptor.startSeconds = Math.max(0, options.startMs / 1000);
  }
  if (options.endMs !== undefined) {
    descriptor.endSeconds = Math.max(0, options.endMs / 1000);
  }
  return descriptor;
}

/**
 * Container formats a `<video>` element can play and `ffmpeg` can decode.
 *
 * A closed list rather than a rejection list: the set of things that are not media is
 * unbounded and includes every file on the disk, while the set of things P80 plays is five
 * entries long. Same argument `storage.ts` makes for choosing an extension from a closed
 * map rather than taking one from a filename.
 *
 * Lives here rather than beside the path resolver because the web client shows it in the
 * add-video form's help text, and two copies of this list would drift.
 */
export const SUPPORTED_MEDIA_EXTENSIONS = ['.mp4', '.m4v', '.mkv', '.webm', '.mov'] as const;

export type MediaPathRejection =
  | 'empty'
  | 'absolute'
  | 'escapes_root'
  | 'escapes_root_via_link'
  | 'null_byte'
  | 'unsupported_extension'
  | 'too_long';

/** Rendered by clients, so it lives on the browser surface. Never contains the resolved
 *  absolute path — the caller supplied a relative one and has no business learning where
 *  the root is. */
export const MEDIA_PATH_MESSAGES: Readonly<Record<MediaPathRejection, string>> = {
  empty: 'A media path is required.',
  absolute: 'Give a path relative to the media library root, not an absolute path.',
  escapes_root: 'That path is outside the media library root.',
  escapes_root_via_link:
    'That path is inside the media library root but links to a file outside it. P80 reads only what is genuinely in the library.',
  null_byte: 'That path contains an illegal character.',
  unsupported_extension: `Supported formats are ${SUPPORTED_MEDIA_EXTENSIONS.join(', ')}.`,
  too_long: 'That path is too long.',
};

/**
 * The one directory P80 writes media into (`CLAUDE.md` rule 3, ADR 0024 §2).
 *
 * Relative to `P80_MEDIA_ROOT`. It is a constant rather than a setting because the rule is
 * what makes the mechanical check in `test/media-policy.test.ts` possible: "exactly one
 * module writes, and it writes here". A configurable answer would make that unprovable.
 */
export const UPLOAD_DIRECTORY = 'uploads';

/**
 * How much of a file goes in one request.
 *
 * Server-chosen and served to the client in the upload session, so the browser holds no
 * number the server also holds — the same reasoning that puts `control` and `editable` on
 * the settings payload rather than in the page.
 *
 * 8 MiB is a compromise between two limits that pull opposite ways. Too large and a
 * reverse proxy's body cap refuses it (nginx defaults to 1 MiB, so a client that cannot
 * negotiate would fail everywhere), and a dropped connection costs more re-sending. Too
 * small and a multi-gigabyte file becomes thousands of round trips, each paying the full
 * request overhead over a VPN link.
 */
export const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * The ceiling on a single upload.
 *
 * A constant rather than a setting, deliberately (ADR 0024). `CONFIG_KEYS` is a closed set
 * with a guard test, and every key costs a tier decision and a documented reason. This
 * exists to bound a runaway — a client that declares a nonsense size, or a mistyped file —
 * not to be tuned. The guard that actually protects the disk is the free-space check at
 * session creation, which knows the real number.
 */
export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024 * 1024;

/**
 * What the client should send next, as a pure function.
 *
 * Extracted from the upload loop because `apps/web` has no test infrastructure and inventing
 * one for this would be a larger decision than the feature. The same reasoning put job-poll
 * pacing in `polling.ts`: the arithmetic that decides how P80 behaves is testable, and the
 * React that renders it is not the interesting part.
 *
 * `receivedBytes` is always the server's number, never a count the client kept of what it
 * sent — that is what makes an offset mismatch self-healing rather than a desynchronisation.
 */
export function nextChunkPlan(args: {
  receivedBytes: number;
  sizeBytes: number;
  chunkBytes: number;
}): { done: true } | { done: false; start: number; end: number } {
  const { receivedBytes, sizeBytes, chunkBytes } = args;
  if (receivedBytes >= sizeBytes) return { done: true };
  // `end` is exclusive, matching `Blob.slice`. Clamping it is what makes the final chunk
  // short rather than a request for bytes past the end of the file.
  return {
    done: false,
    start: receivedBytes,
    end: Math.min(receivedBytes + chunkBytes, sizeBytes),
  };
}
