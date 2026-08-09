/**
 * Where an uploaded transcript file goes, and why an attacker cannot influence it.
 *
 * Spec §7.2 requires uploaded transcript files to be stored locally. The upload carries a
 * filename, and `CLAUDE.md` rule 8 forbids untrusted input building a path. The resolution
 * here is not to sanitise the filename into a path — it is to **never derive the path from
 * the filename at all**.
 *
 * Pure path arithmetic, no filesystem access, so every case below is testable in isolation.
 * It lives in `packages/core` rather than `packages/database` for the same reason
 * `paths.ts` does: the API writes and the worker reads, and both need the identical answer.
 */

import { resolve, sep } from 'node:path';
import type { TranscriptFormat } from './domain.js';

/**
 * Closed map, keyed on the **sniffed** format rather than the supplied filename. A `.srt`
 * file containing WebVTT is routine, and letting an untrusted filename choose anything —
 * even an extension — is untrusted input reaching control flow.
 */
const FORMAT_EXTENSIONS: Readonly<Record<TranscriptFormat, string>> = {
  vtt: 'vtt',
  srt: 'srt',
  pasted_timestamped: 'txt',
  internal_json: 'json',
};

/**
 * `<root>/transcripts/<videoId>/<transcriptFileId>.<ext>`.
 *
 * Both ids are ULIDs — Crockford base32, so `[0-9A-HJKMNP-TV-Z]` and nothing else. They
 * contain no dot, no slash, no NUL and no `..`, which makes traversal **structurally
 * impossible** rather than filtered. That distinction is the whole design: a filter is a
 * claim about every input anyone will ever send, and an alphabet is a claim about the
 * alphabet.
 *
 * The ids are asserted anyway, because the guarantee is only worth what the caller's id
 * generator is worth, and a caller passing a user-supplied string here is exactly the
 * mistake this function exists to prevent.
 */
export function transcriptStoragePath(args: {
  storageRoot: string;
  videoId: string;
  transcriptFileId: string;
  format: TranscriptFormat;
}): string {
  assertUlid(args.videoId, 'videoId');
  assertUlid(args.transcriptFileId, 'transcriptFileId');
  const ext = FORMAT_EXTENSIONS[args.format];
  return resolve(
    args.storageRoot,
    'transcripts',
    args.videoId,
    `${args.transcriptFileId}.${ext}`,
  );
}

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

function assertUlid(value: string, field: string): void {
  if (!ULID.test(value)) {
    throw new Error(
      `transcriptStoragePath: ${field} is not a ULID. The storage path is built only ` +
        'from generated ids, never from user input.',
    );
  }
}

/**
 * The filename is kept for display — "you uploaded lektion-3.srt" — and for nothing else.
 * It never becomes a path, an `href`, a `download` attribute, or a `Content-Disposition`
 * value, and Stage 2 adds no download endpoint that could turn it into one.
 *
 * Sanitising it anyway is defence in depth: it is rendered, and it is persisted, so it
 * outlives whoever remembers the rule.
 */
/** Controls and DEL. `x.srt\0.png` is the classic — a NUL that truncates the name in one
 *  consumer and not in another. */
const FILENAME_CONTROLS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F]', 'g');

export function sanitizeOriginalFilename(input: string | null | undefined): string | null {
  if (input == null) return null;

  // Basename only, both separator flavours, so a Windows client cannot smuggle a path.
  const base = input.split(/[/\\]/).pop() ?? '';

  const cleaned = base
    .normalize('NFC')
    .replace(FILENAME_CONTROLS, '')
    .replace(/^\.+/, '') // a name that is only dots, and `..` in particular
    .trim()
    .slice(0, 255);

  return cleaned.length > 0 ? cleaned : null;
}

/**
 * The read-side guard: refuse a path that does not live under the configured root.
 *
 * The upload path is generated, so this can only fire on a hand-edited database row or a
 * database restored beside a different storage directory. It costs one string comparison
 * and it is the difference between that mistake being a failed job and being an arbitrary
 * file read.
 *
 * `root + sep` matters — a bare `startsWith(root)` would accept `/data/storage-evil` for a
 * root of `/data/storage`.
 */
export function assertInsideRoot(candidate: string, storageRoot: string): string {
  const root = resolve(storageRoot);
  const target = resolve(candidate);
  if (target !== root && !target.startsWith(root + sep)) {
    throw new Error('Refusing to read a transcript file outside the storage root.');
  }
  return target;
}
