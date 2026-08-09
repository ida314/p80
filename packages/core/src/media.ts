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
  null_byte: 'That path contains an illegal character.',
  unsupported_extension: `Supported formats are ${SUPPORTED_MEDIA_EXTENSIONS.join(', ')}.`,
  too_long: 'That path is too long.',
};
