/**
 * Naming an uploaded file, and where its bytes live while it is still arriving (ADR 0024).
 *
 * Two functions with opposite stances, and the difference between them is the whole design:
 *
 * - `uploadPartialPath` **generates** a path from a ULID. No user input reaches it, so
 *   traversal is structurally impossible rather than filtered — the same claim `storage.ts`
 *   makes about transcript paths, for the same reason.
 * - `safeMediaFilename` **proposes** a name derived from user input, and proposes nothing
 *   else. It is a sanitiser, and `CLAUDE.md` rule 4 says a path is never sanitised into
 *   something acceptable. That rule is not being bent here, because the sanitiser is not
 *   what makes this safe. It exists for the user's benefit: a library of ULIDs would be
 *   unusable, and being able to find `Lektion-3.mp4` on disk is the entire reason P80
 *   accepts a name at all.
 *
 * The safety claim is separate, and it is one sentence:
 *
 *   **No byte is written to a path that did not come out of `resolveMediaPath`.**
 *
 * The caller composes them — `resolveMediaPath(UPLOAD_DIRECTORY + '/' + name, root)` — and
 * writes only to the `absolutePath` that comes back. The composition is **total**: after
 * this function the name cannot be absolute, cannot carry an unsupported extension, cannot
 * exceed the length bound, and cannot contain a NUL. So a containment failure downstream is
 * a **bug in this file**, not bad input, and the caller must report it as an internal error
 * rather than a 400. Getting that backwards is how a real hole gets shown to the user as
 * "bad filename" and then ignored.
 *
 * Server-only, and deliberately absent from `browser.ts`: it needs `node:path`, and
 * `browser-surface.test.ts` will fail if anyone adds it. The client never holds a path.
 */

import { resolve, sep } from 'node:path';
import { SUPPORTED_MEDIA_EXTENSIONS, UPLOAD_DIRECTORY, type MediaPathRejection } from './media.js';

/**
 * The stem length bound, **in UTF-8 bytes rather than characters**.
 *
 * Filesystems limit a name to 255 bytes, not 255 characters. A 100-character bound looks
 * safer and is not: a hundred four-byte code points is four hundred bytes, and the write
 * fails with `ENAMETOOLONG` at the one moment the user cannot do anything about it. 180
 * leaves room for an extension and a collision suffix.
 */
const MAX_STEM_BYTES = 180;

/** The name a file gets when sanitising leaves nothing behind — `😀😀😀.mp4`, or a name
 *  that was only punctuation. Not the ULID: an unusable library is precisely what the user
 *  is trying to avoid by uploading through P80 rather than `scp`, and collision suffixing
 *  makes a second `video.mp4` into `video-2.mp4` without any trouble. */
const FALLBACK_STEM = 'video';

/**
 * Device names that are not filenames on Windows, whatever the extension.
 *
 * Irrelevant on ext4, which is where the media root lives on every machine this has run on.
 * Kept because the root is a user-chosen absolute path and nothing stops it being a CIFS or
 * exFAT mount, and because the fix is a one-character prefix rather than a refusal.
 */
const RESERVED_STEMS = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * Everything that is not a letter, a number, or one of `-_.+` becomes a hyphen.
 *
 * `\p{L}` and `\p{N}` rather than ASCII, deliberately. This is a German-learning
 * application and `Übung.mp4` staying readable is the reason a sanitiser exists here
 * instead of a generated id. What makes that defensible is the exclusion below.
 */
const ALLOWED_STEM_CHAR = /[\p{L}\p{N}\-_.+]/u;

/**
 * Unicode categories that must not survive, even though `\p{L}`-adjacent tests can pass
 * them: control, format, surrogate, private-use, and unassigned. This is what stops a
 * zero-width joiner or a right-to-left override from reaching a filename, where it renders
 * as something other than what it is — the reason an allowlist over letters alone is not
 * enough.
 */
const DISALLOWED_CATEGORY = /\p{C}/u;

export type MediaFilenameRejection = Extract<
  MediaPathRejection,
  'empty' | 'null_byte' | 'unsupported_extension'
>;

export type MediaFilenameResult =
  | { ok: true; filename: string; stem: string; extension: string }
  | { ok: false; reason: MediaFilenameRejection };

/**
 * Reduce a browser-supplied filename to one P80 is willing to create.
 *
 * The order matters, and each step is doing something the next one relies on.
 */
export function safeMediaFilename(input: string): MediaFilenameResult {
  // Before anything else touches the string, for the reason `resolveMediaPath` gives: a NUL
  // truncates a name in one consumer and not in another, which is how a check and a use end
  // up looking at different things.
  if (input.includes('\0')) return { ok: false, reason: 'null_byte' };

  // Basename over both separator flavours, as `sanitizeOriginalFilename` already does, so a
  // Windows client cannot smuggle a path. Note this is *not* the containment guarantee —
  // that is `resolveMediaPath`'s job. It is here so the common case produces a sensible
  // name rather than a refusal.
  const base = (input.split(/[/\\]/).pop() ?? '').normalize('NFC').trim();
  if (base.length === 0) return { ok: false, reason: 'empty' };

  // The extension is *looked up*, never carried. A `.MP4` becomes `.mp4`, and anything not
  // in the closed list is refused rather than coerced — exactly `storage.ts`'s argument for
  // keying its extension map on the sniffed format instead of the supplied name.
  const lower = base.toLowerCase();
  const extension = SUPPORTED_MEDIA_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  if (extension === undefined) return { ok: false, reason: 'unsupported_extension' };

  const rawStem = base.slice(0, base.length - extension.length);

  let stem = [...rawStem]
    .map((character) => {
      if (DISALLOWED_CATEGORY.test(character)) return '-';
      return ALLOWED_STEM_CHAR.test(character) ? character : '-';
    })
    .join('')
    // A run of replaced characters is one separator, not eight. `a   b.mp4` should be
    // `a-b.mp4`, not `a---b.mp4`.
    .replace(/-{2,}/g, '-')
    // Leading dots would make a hidden file, which the library browser deliberately does not
    // show — an uploaded file the user cannot then see is worse than a renamed one. Trailing
    // dots and hyphens are just untidy.
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '');

  stem = truncateUtf8(stem, MAX_STEM_BYTES);
  // Truncation can re-expose a trailing separator that was fine mid-name.
  stem = stem.replace(/[.\-]+$/, '');

  if (stem.length === 0) stem = FALLBACK_STEM;
  if (RESERVED_STEMS.has(stem.toLowerCase())) stem = `_${stem}`;

  return { ok: true, filename: `${stem}${extension}`, stem, extension };
}

/**
 * Truncate to a byte budget without splitting a code point in half.
 *
 * `slice` counts UTF-16 units and would happily cut an astral character into a lone
 * surrogate, which is not valid UTF-8 and which some filesystems will reject and others
 * will store as a replacement character. Counting encoded bytes and stopping before the
 * boundary is the only version that is right for both.
 */
function truncateUtf8(value: string, maxBytes: number): string {
  const encoder = new TextEncoder();
  if (encoder.encode(value).length <= maxBytes) return value;

  let out = '';
  let used = 0;
  for (const character of value) {
    const size = encoder.encode(character).length;
    if (used + size > maxBytes) break;
    out += character;
    used += size;
  }
  return out;
}

/**
 * Candidate names for a collision, in the order they should be tried.
 *
 * `name.mp4`, `name-2.mp4`, `name-3.mp4`, … The caller races each one with `link(2)`, which
 * fails atomically if it is taken — so this generator does not need to know what exists,
 * and there is no window between checking and creating.
 *
 * Bounded rather than unbounded. A thousand files with the same name is not a collision, it
 * is a loop somewhere, and failing loudly beats spinning.
 */
export function* mediaFilenameCandidates(
  filename: string,
  limit = 1000,
): Generator<string> {
  const result = splitExtension(filename);
  if (result === null) {
    yield filename;
    return;
  }
  const { stem, extension } = result;
  yield `${stem}${extension}`;
  for (let n = 2; n <= limit; n += 1) {
    yield `${truncateUtf8(stem, MAX_STEM_BYTES - String(n).length - 1)}-${n}${extension}`;
  }
}

function splitExtension(filename: string): { stem: string; extension: string } | null {
  const lower = filename.toLowerCase();
  const extension = SUPPORTED_MEDIA_EXTENSIONS.find((candidate) => lower.endsWith(candidate));
  if (extension === undefined) return null;
  return { stem: filename.slice(0, filename.length - extension.length), extension };
}

/**
 * `<mediaRoot>/uploads/.p80-partial/<uploadId>.part`.
 *
 * Four properties, each chosen rather than fallen into:
 *
 * - **No user input.** The id is a ULID — Crockford base32, so `[0-9A-HJKMNP-TV-Z]` and
 *   nothing else. No dot, no slash, no NUL, no `..`. Asserted below, because the guarantee
 *   is only worth what the caller's id generator is worth.
 * - **Hidden, and one level down.** A partially received file must not appear in the
 *   library browser as though it were something you could play, and a dedicated directory
 *   gives the reaper exactly one place to look and never a glob over the user's library.
 * - **The same filesystem as the final destination**, which is what makes the finalising
 *   `link(2)` legal and atomic. Staging under `P80_STORAGE_PATH` would break rule 3 *and*
 *   guarantee a cross-device move, since `validateMediaRoot` refuses a root inside storage.
 * - **`.part`, which is not a supported media extension**, so `resolveMediaPath` would
 *   reject this path. That is correct and worth stating: the partial is built here, from an
 *   id, and must never be routed through the resolver meant for user-supplied paths.
 */
export function uploadPartialPath(args: { mediaRoot: string; uploadId: string }): string {
  assertUlid(args.uploadId, 'uploadId');
  return resolve(args.mediaRoot, UPLOAD_DIRECTORY, PARTIAL_DIRECTORY, `${args.uploadId}.part`);
}

/** `<mediaRoot>/uploads` — the only directory P80 writes media into. */
export function uploadDirectoryPath(mediaRoot: string): string {
  return resolve(mediaRoot, UPLOAD_DIRECTORY);
}

/** `<mediaRoot>/uploads/.p80-partial` — swept by the reaper, hidden from the browser. */
export function partialDirectoryPath(mediaRoot: string): string {
  return resolve(mediaRoot, UPLOAD_DIRECTORY, PARTIAL_DIRECTORY);
}

/** Leading dot so the library browser's dotfile skip hides it without a special case. */
export const PARTIAL_DIRECTORY = '.p80-partial';

/** The reaper only ever unlinks something matching this, inside `PARTIAL_DIRECTORY`. A
 *  sweep that took a glob would eventually be pointed at a user's library. */
export const PARTIAL_FILENAME = /^[0-9A-HJKMNP-TV-Z]{26}\.part$/;

/** Media-root-relative, for storing on the row and for the containment check. */
export function uploadRelativePath(filename: string): string {
  return `${UPLOAD_DIRECTORY}/${filename}`;
}

/** True when a stored `media_path` names a file P80 itself wrote — which is the only kind
 *  it is willing to delete (ADR 0024 §5). */
export function isInsideUploadDirectory(relativePath: string): boolean {
  const normalized = relativePath.split(/[/\\]/).join(sep);
  return normalized.startsWith(`${UPLOAD_DIRECTORY}${sep}`);
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function assertUlid(value: string, field: string): void {
  if (!ULID.test(value)) {
    throw new Error(
      `uploadPartialPath: ${field} is not a ULID. The partial path is built only from ` +
        'generated ids, never from user input.',
    );
  }
}
