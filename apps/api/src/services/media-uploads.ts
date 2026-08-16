import {
  closeSync,
  ftruncateSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  statSync,
  statfsSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ERROR_CODES,
  MAX_UPLOAD_BYTES,
  P80Error,
  PARTIAL_DIRECTORY,
  PARTIAL_FILENAME,
  mediaFilenameCandidates,
  partialDirectoryPath,
  resolveMediaPath,
  uploadDirectoryPath,
  uploadPartialPath,
  uploadRelativePath,
} from '@p80/core';
import {
  listInFlightUploads,
  settleUpload,
  type DatabaseHandle,
  type UploadRow,
} from '@p80/database';

/**
 * **The only module in P80 that writes into the media root** (`CLAUDE.md` rule 3,
 * ADR 0024 §2).
 *
 * That is not a description, it is an assertion: `test/media-policy.test.ts` names this
 * file and requires the list to have exactly one entry. A second writer fails the build,
 * and so does deleting this one, because a rule that is checked is worth more than a rule
 * that is stated — the argument ADR 0015 already made when it replaced *never isolate an
 * audio track* with *never copy media into storage*.
 *
 * Everything here is **synchronous**, and that is correctness rather than taste.
 * `better-sqlite3` is synchronous and Node is single-threaded, so a block of code
 * containing no `await` runs to completion against every other request. The chunk write
 * reads `received_bytes`, checks it, writes at that offset, and updates the row — and
 * because nothing in that sequence yields, no second request can interleave between the
 * check and the write. The alternative is a lock. **Do not "modernise" this to
 * `fs.promises`**: it would silently reintroduce a race that nothing about the call site
 * looks fragile enough to warn you about.
 *
 * The cost is roughly ten milliseconds of blocked event loop per eight-megabyte chunk on a
 * local disk, for a single-user application. That is the trade, and it is a good one.
 */

/** Leave this much headroom when deciding whether a declared upload fits. A media
 *  filesystem run to absolutely zero is unpleasant for everything else living on it, and
 *  P80 filling it is a bad way to find that out. */
const FREE_SPACE_RESERVE_BYTES = 1024 * 1024 * 1024;

/**
 * Reject an upload that cannot fit, before a byte is written.
 *
 * Advisory only, and deliberately so — another process can fill the disk a second later.
 * The guard that actually protects the write is `ENOSPC` handling in `writeChunk`. What
 * this buys is that the common case fails immediately and legibly, rather than twenty
 * minutes into an upload.
 */
export function assertRoomFor(mediaRoot: string, sizeBytes: number): void {
  if (sizeBytes > MAX_UPLOAD_BYTES) {
    throw P80Error.tooLarge(
      `That file is larger than the ${formatBytes(MAX_UPLOAD_BYTES)} upload limit.`,
      { maxBytes: MAX_UPLOAD_BYTES, actual: sizeBytes },
      ERROR_CODES.UPLOAD_TOO_LARGE,
    );
  }

  let free: number;
  try {
    const stats = statfsSync(mediaRoot);
    free = stats.bavail * stats.bsize;
  } catch {
    // A root we cannot stat is a problem the media-root validator reports properly. Not
    // being able to *count* free space is not a reason to refuse the upload.
    return;
  }

  if (sizeBytes + FREE_SPACE_RESERVE_BYTES > free) {
    throw new P80Error(
      ERROR_CODES.UPLOAD_STORAGE_FULL,
      `There is not enough free space for that file — ${formatBytes(sizeBytes)} needed, ` +
        `${formatBytes(free)} available.`,
      { statusCode: 507, retryable: true, details: { sizeBytes, freeBytes: free } },
    );
  }
}

/** Created lazily, on session creation rather than at boot. The media root is editable
 *  while P80 runs (ADR 0019), so a directory created at startup would appear in whichever
 *  library happened to be configured then — and creating a directory inside somebody's
 *  media collection because a service restarted is bad manners. */
export function ensureUploadDirectories(mediaRoot: string): void {
  mkdirSync(partialDirectoryPath(mediaRoot), { recursive: true });
}

/**
 * Write one chunk at a declared offset.
 *
 * The ordering is the whole design and every step is load-bearing:
 *
 * 1. **Truncate to the row's count first.** This heals a crash between a previous write and
 *    its database update, which leaves the file longer than the row believes. The row is
 *    the authority; the file is made to agree with it.
 * 2. **Write positionally**, not by appending. `flags: 'a'` means *wherever the file
 *    currently ends*, which is a different claim from *at offset N* — and after step 1 they
 *    can disagree. Writing at an explicit offset lets the two be checked against each other
 *    instead of hoping.
 * 3. **Rewind on a short write.** A partial write must leave no trace, or the next chunk
 *    lands on top of bytes that were never acknowledged.
 *
 * No `fsync` here. Per-chunk flushing on a multi-gigabyte upload is a large cost for data
 * that is resumable by construction — power loss mid-upload means re-sending the tail,
 * which is the protocol's entire job. The flush that matters happens once, in `finalize`.
 */
export function writeChunk(args: {
  mediaRoot: string;
  uploadId: string;
  offset: number;
  data: Buffer;
  /** The row's count, which the caller has already checked against `offset`. */
  knownReceivedBytes: number;
}): number {
  const partialPath = uploadPartialPath({
    mediaRoot: args.mediaRoot,
    uploadId: args.uploadId,
  });

  // `r+` needs the file to exist; the first chunk creates it. `w+` on a later chunk would
  // truncate everything already received, which is the worst possible way to be wrong here.
  const flags = args.offset === 0 ? 'w+' : 'r+';
  let fd: number;
  try {
    fd = openSync(partialPath, flags);
  } catch (error) {
    throw writeFailed(error);
  }

  try {
    ftruncateSync(fd, args.knownReceivedBytes);
    const written = writeSync(fd, args.data, 0, args.data.length, args.offset);
    if (written < args.data.length) {
      ftruncateSync(fd, args.offset);
      throw new P80Error(
        ERROR_CODES.UPLOAD_WRITE_FAILED,
        'Only part of that chunk could be written. Nothing already received was lost; send it again.',
        { statusCode: 500, retryable: true },
      );
    }
    return written;
  } catch (error) {
    if (error instanceof P80Error) throw error;
    // Rewind so a failed chunk leaves the file exactly where the row says it is.
    try {
      ftruncateSync(fd, args.knownReceivedBytes);
    } catch {
      // The next chunk truncates again anyway. Nothing useful to do here, and throwing
      // would replace a specific error with a confusing one.
    }
    throw writeFailed(error);
  } finally {
    closeSync(fd);
  }
}

function writeFailed(error: unknown): P80Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOSPC') {
    return new P80Error(
      ERROR_CODES.UPLOAD_STORAGE_FULL,
      'The disk filled up. Nothing you have already sent is lost — free some space and the upload resumes from where it stopped.',
      { statusCode: 507, retryable: true },
    );
  }
  return new P80Error(
    ERROR_CODES.UPLOAD_WRITE_FAILED,
    'That chunk could not be written to disk.',
    { statusCode: 500, retryable: true, details: { cause: code ?? null } },
  );
}

/**
 * Move the finished partial into the library under a name that is free.
 *
 * **`link(2)`, not `rename(2)`.** This is the single most important line in the file.
 * `rename` overwrites an existing destination silently and without error, so the obvious
 * implementation — check with `existsSync`, then rename — does not merely lose a race, it
 * **destroys a file and tells nobody**. `link` fails `EEXIST` atomically, which turns the
 * race into a retry with the next candidate name and closes the window entirely rather
 * than narrowing it.
 *
 * Both paths are under `P80_MEDIA_ROOT` and therefore on one filesystem, which is what
 * makes `link` legal. It is also the second reason the partial must not be staged in
 * `P80_STORAGE_PATH`: `validateMediaRoot` guarantees the two roots are disjoint, so that
 * version of this function could not be atomic even if rule 3 permitted it.
 *
 * The `fsync` before linking is the one that matters — it is what stops a `videos` row
 * from pointing at a file whose tail is still in a write cache.
 */
export function finalize(args: {
  mediaRoot: string;
  uploadId: string;
  filename: string;
}): { relativePath: string; absolutePath: string; filename: string } {
  const partialPath = uploadPartialPath({
    mediaRoot: args.mediaRoot,
    uploadId: args.uploadId,
  });

  const fd = openSync(partialPath, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }

  for (const candidate of mediaFilenameCandidates(args.filename)) {
    const relativePath = uploadRelativePath(candidate);
    // The containment guarantee. `safeMediaFilename` proposed the name; this is what
    // decides whether it may be written, and it is the same check a typed path gets.
    const resolved = resolveMediaPath(relativePath, args.mediaRoot);
    if (!resolved.ok) {
      // Unreachable by construction — the composition of `safeMediaFilename` and this
      // resolver is total (ADR 0024 §4). So this is a bug in the sanitiser rather than
      // bad input, and it must not be reported to the user as a bad filename.
      throw new Error(
        `finalize: a sanitised filename failed containment (${resolved.reason}). ` +
          'This is a defect in safeMediaFilename, not user error.',
      );
    }

    try {
      linkSync(partialPath, resolved.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }

    unlinkSync(partialPath);
    return { relativePath, absolutePath: resolved.absolutePath, filename: candidate };
  }

  throw P80Error.conflict(
    ERROR_CODES.CONFLICT,
    'There are already too many files with that name in the library. Rename the file and upload it again.',
    { filename: args.filename },
  );
}

/** How many bytes are actually on disk for a session, or zero if the partial is gone. Used
 *  to report what a cancellation threw away rather than pretending nothing happened. */
export function partialSize(mediaRoot: string, uploadId: string): number {
  try {
    return statSync(uploadPartialPath({ mediaRoot, uploadId })).size;
  } catch {
    return 0;
  }
}

export function discardPartial(mediaRoot: string, uploadId: string): void {
  try {
    unlinkSync(uploadPartialPath({ mediaRoot, uploadId }));
  } catch {
    // Already gone is the desired state.
  }
}

/**
 * Sweep abandoned uploads.
 *
 * Runs on API start and on session creation. **No job type and no timer**: uploads are not
 * frequent enough to earn a unit that has to be installed, enabled, and remembered, and the
 * sweep is one indexed query plus one `readdir` of one hidden directory.
 *
 * Two passes, because there are two ways to be abandoned. A row past its expiry is a tab
 * somebody closed. A `.part` file with no row at all is what a restored-from-backup
 * database leaves behind — the rows went back in time and the files did not.
 *
 * **The second pass is deliberately paranoid.** It only ever unlinks something matching
 * `PARTIAL_FILENAME` inside `PARTIAL_DIRECTORY`. A sweep that took a glob, or that trusted
 * the directory to contain only its own files, is one configuration mistake away from
 * being pointed at somebody's library.
 */
export function reapAbandonedUploads(
  handle: DatabaseHandle,
  mediaRoot: string,
  at = Date.now(),
): { sessions: number; files: number } {
  let sessions = 0;
  let files = 0;

  const inFlight = listInFlightUploads(handle);
  const live = new Set<string>();

  for (const row of inFlight) {
    if (row.expiresAt < at) {
      settleUpload(handle, { id: row.id, status: 'aborted', error: { reason: 'expired' } });
      discardPartial(row.mediaRoot, row.id);
      sessions += 1;
    } else {
      live.add(`${row.id}.part`);
    }
  }

  const partialDir = partialDirectoryPath(mediaRoot);
  let entries: string[];
  try {
    entries = readdirSync(partialDir);
  } catch {
    return { sessions, files };
  }

  for (const entry of entries) {
    if (!PARTIAL_FILENAME.test(entry)) continue;
    if (live.has(entry)) continue;
    try {
      unlinkSync(join(partialDir, entry));
      files += 1;
    } catch {
      // Racing the sweep with a completing upload is fine — one of them wins and the
      // other finds the file gone.
    }
  }

  return { sessions, files };
}

/**
 * Remove a file from the library.
 *
 * The containment decision is **not** made here — the caller has already run the path
 * through `requireMediaPath` and confirmed it is under `uploads/`. What this adds is the
 * refusal to follow a link or descend into a directory: `lstat`, never `stat`, because a
 * symlink to a directory must not be traversed and a directory must not be removed at all.
 * `rmSync` with `recursive` is deliberately absent from this file.
 */
export function deleteLibraryFile(absolutePath: string): void {
  const stats = lstatOrThrow(absolutePath);
  if (!stats.isFile()) {
    throw new P80Error(
      ERROR_CODES.MEDIA_DELETE_REFUSED,
      'That is not a regular file. P80 removes uploaded media files and nothing else.',
      { statusCode: 403 },
    );
  }
  unlinkSync(absolutePath);
}

/** `lstat`, never `stat`. `stat` follows a symlink and would report the *target's* type,
 *  so a link pointing at a regular file outside the library would pass the `isFile` check
 *  above and be unlinked — removing the link, which is harmless, after having been told it
 *  was something it was not. Reporting the link itself is the honest answer. */
function lstatOrThrow(absolutePath: string) {
  try {
    return lstatSync(absolutePath, { throwIfNoEntry: true });
  } catch {
    throw new P80Error(ERROR_CODES.MEDIA_FILE_NOT_FOUND, 'There is no file at that path.', {
      statusCode: 404,
    });
  }
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export { uploadDirectoryPath, PARTIAL_DIRECTORY };
export type { UploadRow };
