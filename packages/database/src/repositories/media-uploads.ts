import { newId, now, type UploadStatus } from '@p80/core';
import type { DatabaseHandle } from '../client.js';

/**
 * Upload sessions (ADR 0024, migration 0003).
 *
 * One function here carries the whole concurrency story, and it is `advanceUpload`.
 *
 * Every other repository in P80 can update a row unconditionally, because two requests
 * racing to write the same field is either impossible or harmless. Chunk arrival is
 * neither: two chunks claiming the same offset would both write, both succeed, and the
 * second would silently overwrite bytes the first had already counted. So the update
 * carries the offset it expects to find, and a caller that gets `false` back knows its
 * chunk lost the race and must not be counted.
 *
 * That is belt to the braces of the API's own strict-append check. The check makes the race
 * nearly impossible; this makes it *actually* impossible, and the two cost one WHERE clause
 * between them.
 */

export interface UploadRow {
  id: string;
  profileId: string;
  originalFilename: string;
  filename: string;
  sizeBytes: number;
  /** The authority for how much has arrived. The partial file heals toward it. */
  receivedBytes: number;
  status: UploadStatus;
  /** Absolute, and stored rather than read per use — see the migration. */
  mediaRoot: string;
  /** Media-root-relative, null until the file is linked into `uploads/`. */
  mediaPath: string | null;
  videoId: string | null;
  jobId: string | null;
  title: string | null;
  interestsJson: string | null;
  transcribe: boolean;
  errorJson: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}

interface RawUpload {
  id: string;
  profile_id: string;
  original_filename: string;
  filename: string;
  size_bytes: number;
  received_bytes: number;
  status: string;
  media_root: string;
  media_path: string | null;
  video_id: string | null;
  job_id: string | null;
  title: string | null;
  interests_json: string | null;
  transcribe: number;
  error_json: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number;
}

function toRow(raw: RawUpload): UploadRow {
  return {
    id: raw.id,
    profileId: raw.profile_id,
    originalFilename: raw.original_filename,
    filename: raw.filename,
    sizeBytes: raw.size_bytes,
    receivedBytes: raw.received_bytes,
    status: raw.status as UploadStatus,
    mediaRoot: raw.media_root,
    mediaPath: raw.media_path,
    videoId: raw.video_id,
    jobId: raw.job_id,
    title: raw.title,
    interestsJson: raw.interests_json,
    transcribe: raw.transcribe === 1,
    errorJson: raw.error_json,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    expiresAt: raw.expires_at,
  };
}

/** How long an untouched session survives. Refreshed on every chunk, so this is a bound on
 *  *inactivity*, not on total upload time — a file that takes nine hours over a slow link
 *  is fine, and a tab closed mid-upload is reaped tomorrow. */
export const UPLOAD_TTL_MS = 24 * 60 * 60 * 1000;

export function createUpload(
  handle: DatabaseHandle,
  input: {
    profileId: string;
    originalFilename: string;
    filename: string;
    sizeBytes: number;
    mediaRoot: string;
    title: string | null;
    interestsJson: string | null;
    transcribe: boolean;
  },
): UploadRow {
  const id = newId();
  const timestamp = now();
  handle.sqlite
    .prepare(
      `INSERT INTO media_uploads (
         id, profile_id, original_filename, filename, size_bytes, received_bytes,
         status, media_root, media_path, video_id, job_id, title, interests_json,
         transcribe, error_json, created_at, updated_at, expires_at
       ) VALUES (?, ?, ?, ?, ?, 0, 'in_progress', ?, NULL, NULL, NULL, ?, ?, ?, NULL, ?, ?, ?)`,
    )
    .run(
      id,
      input.profileId,
      input.originalFilename,
      input.filename,
      input.sizeBytes,
      input.mediaRoot,
      input.title,
      input.interestsJson,
      input.transcribe ? 1 : 0,
      timestamp,
      timestamp,
      timestamp + UPLOAD_TTL_MS,
    );
  const created = getUpload(handle, id);
  if (created === null) throw new Error('createUpload: the row vanished immediately after insert.');
  return created;
}

export function getUpload(handle: DatabaseHandle, id: string): UploadRow | null {
  const raw = handle.sqlite.prepare('SELECT * FROM media_uploads WHERE id = ?').get(id) as
    | RawUpload
    | undefined;
  return raw ? toRow(raw) : null;
}

export function listUploads(
  handle: DatabaseHandle,
  args: { profileId: string; status?: UploadStatus; limit?: number },
): UploadRow[] {
  const limit = args.limit ?? 50;
  const rows = args.status
    ? (handle.sqlite
        .prepare(
          `SELECT * FROM media_uploads WHERE profile_id = ? AND status = ?
             ORDER BY created_at DESC LIMIT ?`,
        )
        .all(args.profileId, args.status, limit) as RawUpload[])
    : (handle.sqlite
        .prepare(
          'SELECT * FROM media_uploads WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?',
        )
        .all(args.profileId, limit) as RawUpload[]);
  return rows.map(toRow);
}

/**
 * Record that a chunk landed — **only if the row still says what the caller thinks it
 * says.**
 *
 * Returns `false` when the conditional update matched nothing, which means one of two
 * things and the caller does not need to distinguish them: another chunk got there first,
 * or the session stopped being `in_progress` between the read and the write. Either way the
 * bytes just written must not be counted, and the client must re-read the session.
 */
export function advanceUpload(
  handle: DatabaseHandle,
  args: { id: string; fromReceivedBytes: number; toReceivedBytes: number },
): boolean {
  const timestamp = now();
  const result = handle.sqlite
    .prepare(
      `UPDATE media_uploads
          SET received_bytes = ?, updated_at = ?, expires_at = ?
        WHERE id = ? AND received_bytes = ? AND status = 'in_progress'`,
    )
    .run(
      args.toReceivedBytes,
      timestamp,
      timestamp + UPLOAD_TTL_MS,
      args.id,
      args.fromReceivedBytes,
    );
  return result.changes === 1;
}

/** The upload became a video. `mediaPath` is set here and nowhere else, which is what makes
 *  a row with a null path unambiguously one that never finished. */
export function completeUpload(
  handle: DatabaseHandle,
  args: { id: string; mediaPath: string; videoId: string; jobId: string },
): UploadRow | null {
  handle.sqlite
    .prepare(
      `UPDATE media_uploads
          SET status = 'completed', media_path = ?, video_id = ?, job_id = ?, updated_at = ?
        WHERE id = ? AND status = 'in_progress'`,
    )
    .run(args.mediaPath, args.videoId, args.jobId, now(), args.id);
  return getUpload(handle, args.id);
}

/**
 * Settle a session without a video: the user cancelled, or something refused.
 *
 * `aborted` and `failed` are kept apart because they read differently in a list — one is
 * something the user did and one is something that happened to them.
 */
export function settleUpload(
  handle: DatabaseHandle,
  args: { id: string; status: Extract<UploadStatus, 'aborted' | 'failed'>; error?: unknown },
): UploadRow | null {
  handle.sqlite
    .prepare('UPDATE media_uploads SET status = ?, error_json = ?, updated_at = ? WHERE id = ?')
    .run(
      args.status,
      args.error === undefined ? null : JSON.stringify(args.error),
      now(),
      args.id,
    );
  return getUpload(handle, args.id);
}

/** The reaper's query. Everything in flight that nobody has touched inside the TTL. */
export function listExpiredUploads(handle: DatabaseHandle, at = now()): UploadRow[] {
  const rows = handle.sqlite
    .prepare(`SELECT * FROM media_uploads WHERE status = 'in_progress' AND expires_at < ?`)
    .all(at) as RawUpload[];
  return rows.map(toRow);
}

/** Every in-flight session, across profiles — the reaper runs before a profile is in
 *  scope, at API start. */
export function listInFlightUploads(handle: DatabaseHandle): UploadRow[] {
  const rows = handle.sqlite
    .prepare(`SELECT * FROM media_uploads WHERE status = 'in_progress'`)
    .all() as RawUpload[];
  return rows.map(toRow);
}

/** True when another live session already intends to write this name. Cheap pre-check
 *  only: the real collision guard is `link(2)` failing atomically at finalise time, because
 *  two sessions can pass this simultaneously. It exists to tell the user *before* they
 *  spend twenty minutes uploading, not to make the write safe. */
export function findInFlightByFilename(
  handle: DatabaseHandle,
  args: { profileId: string; filename: string },
): UploadRow | null {
  const raw = handle.sqlite
    .prepare(
      `SELECT * FROM media_uploads
        WHERE profile_id = ? AND filename = ? AND status = 'in_progress' LIMIT 1`,
    )
    .get(args.profileId, args.filename) as RawUpload | undefined;
  return raw ? toRow(raw) : null;
}
