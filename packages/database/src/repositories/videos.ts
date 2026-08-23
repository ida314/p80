import {
  ERROR_CODES,
  P80Error,
  TRANSCRIPT_STATUS_TRANSITIONS,
  newId,
  now,
  type MediaSourceKind,
  type ProcessingStatus,
  type TranscriptStatus,
} from '@p80/core';
import type { DatabaseHandle } from '../client.js';

/**
 * Video storage.
 *
 * Two things here are load-bearing beyond ordinary CRUD:
 *
 * **Duplicate detection is the unique constraint**, not application logic — the migration
 * says so in a comment. A pre-check alone would be TOCTOU, so the insert is attempted and
 * the constraint violation is translated; the pre-check exists only to produce a message
 * that names the video the user already has.
 *
 * **`transcript_status` has exactly one write path**, and it asserts the transition.
 * Neither status column carries a CHECK constraint, and adding one would need a migration
 * that would break three Stage 1 tests for no gain: a CHECK can only police membership,
 * and what actually goes wrong is a *transition*. `none -> ready` means segments appeared
 * without a parse, which is the bug this guard catches and a CHECK never would.
 */

export interface VideoRow {
  id: string;
  profileId: string;
  sourceType: MediaSourceKind;
  externalVideoId: string;
  url: string;
  title: string | null;
  targetLanguage: string;
  durationMs: number | null;
  speakerLabel: string | null;
  regionLabel: string | null;
  transcriptStatus: TranscriptStatus;
  processingStatus: ProcessingStatus;
  estimatedCoverage: number | null;
  difficultyLabel: string | null;
  pipelineVersion: string | null;
  /** Relative to `P80_MEDIA_ROOT` (ADR 0015). Null until the row is pointed at a file. */
  mediaPath: string | null;
  /** The file was not there last time P80 looked. Repairable, never a cascade. */
  mediaMissing: boolean;
  mediaBytes: number | null;
  createdAt: number;
  updatedAt: number;
}

interface RawVideo {
  id: string;
  profile_id: string;
  source_type: string;
  external_video_id: string;
  url: string;
  title: string | null;
  target_language: string;
  duration_ms: number | null;
  speaker_label: string | null;
  region_label: string | null;
  transcript_status: string;
  processing_status: string;
  estimated_coverage: number | null;
  difficulty_label: string | null;
  pipeline_version: string | null;
  media_path: string | null;
  media_missing: number;
  media_bytes: number | null;
  created_at: number;
  updated_at: number;
}

function toVideo(row: RawVideo): VideoRow {
  return {
    id: row.id,
    profileId: row.profile_id,
    sourceType: row.source_type as MediaSourceKind,
    externalVideoId: row.external_video_id,
    url: row.url,
    title: row.title,
    targetLanguage: row.target_language,
    durationMs: row.duration_ms,
    speakerLabel: row.speaker_label,
    regionLabel: row.region_label,
    transcriptStatus: row.transcript_status as TranscriptStatus,
    processingStatus: row.processing_status as ProcessingStatus,
    estimatedCoverage: row.estimated_coverage,
    difficultyLabel: row.difficulty_label,
    pipelineVersion: row.pipeline_version,
    mediaPath: row.media_path,
    mediaMissing: row.media_missing === 1,
    mediaBytes: row.media_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateVideoInput {
  profileId: string;
  sourceType: MediaSourceKind;
  /**
   * The content hash (ADR 0018). **Omit it at add time** — identity is computed by the
   * ingest job, because hashing a multi-gigabyte file does not belong on a request that
   * returns a job reference.
   *
   * When omitted, the row gets `pending:<id>`, which is unique per row on purpose. A
   * shared placeholder — `''` or `NULL` — would either collapse every un-ingested video
   * into one duplicate collision, or (for `NULL`, which SQLite treats as distinct every
   * time) stop constraining at all. `pending:` is neither: several videos can await ingest
   * at once, and none of them can collide with a 64-character hex digest.
   */
  externalVideoId?: string;
  url: string;
  title?: string | null;
  targetLanguage: string;
  speakerLabel?: string | null;
  regionLabel?: string | null;
  mediaPath?: string | null;
}

/** Identity before the ingest job has read the file. Unique per row, and structurally
 *  incapable of colliding with a hex digest. */
export function pendingIdentity(videoId: string): string {
  return `pending:${videoId}`;
}

export function isPendingIdentity(externalVideoId: string): boolean {
  return externalVideoId.startsWith('pending:');
}

export function createVideo(handle: DatabaseHandle, input: CreateVideoInput): VideoRow {
  const id = newId();
  const ts = now();
  const externalVideoId = input.externalVideoId ?? pendingIdentity(id);
  try {
    handle.sqlite
      .prepare(
        `INSERT INTO videos
           (id, profile_id, source_type, external_video_id, url, title, target_language,
            transcript_status, processing_status, media_path, media_missing,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'none', 'none', ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.profileId,
        input.sourceType,
        externalVideoId,
        input.url,
        input.title ?? null,
        input.targetLanguage,
        input.mediaPath ?? null,
        ts,
        ts,
      );
  } catch (error) {
    if (isUniqueViolation(error)) {
      const existing = findByExternalId(
        handle,
        input.profileId,
        input.sourceType,
        externalVideoId,
      );
      throw P80Error.conflict(
        ERROR_CODES.DUPLICATE_VIDEO,
        'You have already added this video.',
        {
          // The client navigates to it rather than making the user search for it.
          videoId: existing?.id ?? null,
          externalVideoId,
        },
      );
    }
    throw error;
  }

  if (input.speakerLabel != null || input.regionLabel != null) {
    updateVideo(handle, id, {
      speakerLabel: input.speakerLabel ?? null,
      regionLabel: input.regionLabel ?? null,
    });
  }
  return getVideo(handle, id)!;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    String((error as { code: unknown }).code).startsWith('SQLITE_CONSTRAINT')
  );
}

export function getVideo(handle: DatabaseHandle, id: string): VideoRow | null {
  const row = handle.sqlite.prepare('SELECT * FROM videos WHERE id = ?').get(id) as
    | RawVideo
    | undefined;
  return row ? toVideo(row) : null;
}

export function findByExternalId(
  handle: DatabaseHandle,
  profileId: string,
  sourceType: MediaSourceKind,
  externalVideoId: string,
): VideoRow | null {
  const row = handle.sqlite
    .prepare(
      `SELECT * FROM videos
        WHERE profile_id = ? AND source_type = ? AND external_video_id = ?`,
    )
    .get(profileId, sourceType, externalVideoId) as RawVideo | undefined;
  return row ? toVideo(row) : null;
}

/**
 * Duplicate detection *before* the bytes have been read.
 *
 * ADR 0018 makes identity the content hash, which catches the interesting case — the same
 * file added twice under two names — but only in the worker, after a full read. This
 * catches the boring case at the API: the same path added twice. Without it, the second
 * add creates a row, spends minutes hashing and transcribing, and is then discarded as a
 * duplicate, which looks like a bug from the outside.
 *
 * Path equality only. Two paths pointing at one file through a symlink are the hash's
 * problem, not this function's.
 */
export function findByMediaPath(
  handle: DatabaseHandle,
  profileId: string,
  mediaPath: string,
): VideoRow | null {
  const row = handle.sqlite
    .prepare('SELECT * FROM videos WHERE profile_id = ? AND media_path = ?')
    .get(profileId, mediaPath) as RawVideo | undefined;
  return row ? toVideo(row) : null;
}

export interface ListVideosFilter {
  profileId: string;
  transcriptStatus?: TranscriptStatus;
  processingStatus?: ProcessingStatus;
  q?: string;
  limit?: number;
  cursor?: string | null;
}

export interface ListVideosResult {
  videos: VideoRow[];
  nextCursor: string | null;
}

export function listVideos(
  handle: DatabaseHandle,
  filter: ListVideosFilter,
): ListVideosResult {
  const where = ['profile_id = ?'];
  const params: unknown[] = [filter.profileId];

  if (filter.transcriptStatus) {
    where.push('transcript_status = ?');
    params.push(filter.transcriptStatus);
  }
  if (filter.processingStatus) {
    where.push('processing_status = ?');
    params.push(filter.processingStatus);
  }
  if (filter.q) {
    // Parameterized, with the LIKE wildcards escaped so a title search for `100%` does not
    // become a match-everything query.
    const escaped = filter.q.replace(/[\\%_]/g, (c) => `\\${c}`);
    where.push("(title LIKE ? ESCAPE '\\' OR external_video_id LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`);
  }
  // Opaque to the client: `createdAt|id`, so paging is stable when two videos share a
  // timestamp.
  if (filter.cursor) {
    const [createdAt, id] = filter.cursor.split('|');
    where.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(Number(createdAt), Number(createdAt), id ?? '');
  }

  const limit = filter.limit ?? 50;
  const rows = handle.sqlite
    .prepare(
      `SELECT * FROM videos
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as RawVideo[];

  const page = rows.slice(0, limit).map(toVideo);
  const last = page[page.length - 1];
  return {
    videos: page,
    nextCursor:
      rows.length > limit && last !== undefined ? `${last.createdAt}|${last.id}` : null,
  };
}

export interface VideoMediaRef {
  id: string;
  title: string | null;
  /** Relative to whichever media root is current. Null on a row never pointed at a file. */
  mediaPath: string | null;
  mediaMissing: boolean;
}

/**
 * Every video's media reference, unpaged (ADR 0019 §4).
 *
 * Unpaged because both callers need the whole set to answer a question about it: how many
 * videos a proposed media root would orphan, and which flags to recompute after it changed.
 * A cursor would turn a count into a loop that can be interrupted halfway, leaving the
 * `media_missing` column half-true — which is worse than the memory, since four columns
 * across a personal library is nothing.
 */
export function listVideoMediaRefs(
  handle: DatabaseHandle,
  profileId: string,
): VideoMediaRef[] {
  const rows = handle.sqlite
    .prepare(
      `SELECT id, title, media_path, media_missing FROM videos
        WHERE profile_id = ? ORDER BY created_at DESC, id DESC`,
    )
    .all(profileId) as Array<{
    id: string;
    title: string | null;
    media_path: string | null;
    media_missing: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    mediaPath: r.media_path,
    mediaMissing: r.media_missing === 1,
  }));
}

export interface UpdateVideoInput {
  title?: string | null;
  speakerLabel?: string | null;
  regionLabel?: string | null;
  durationMs?: number | null;
}

/** `url` and `external_video_id` are deliberately not patchable — changing a video's
 *  identity would orphan its transcript and every occurrence built on it. */
export function updateVideo(
  handle: DatabaseHandle,
  id: string,
  patch: UpdateVideoInput,
): VideoRow {
  const sets: string[] = [];
  const params: unknown[] = [];
  for (const [column, value] of [
    ['title', patch.title],
    ['speaker_label', patch.speakerLabel],
    ['region_label', patch.regionLabel],
    ['duration_ms', patch.durationMs],
  ] as const) {
    if (value !== undefined) {
      sets.push(`${column} = ?`);
      params.push(value);
    }
  }
  if (sets.length > 0) {
    sets.push('updated_at = ?');
    params.push(now());
    handle.sqlite
      .prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
  }
  const video = getVideo(handle, id);
  if (!video) throw P80Error.notFound('Video', { id });
  return video;
}

/**
 * The single write path for `transcript_status`.
 *
 * An illegal transition is a bug in P80, not a user error, so it throws rather than
 * returning an envelope-shaped failure — there is no request the user could have made
 * differently.
 */
export function setTranscriptStatus(
  handle: DatabaseHandle,
  id: string,
  next: TranscriptStatus,
): void {
  const video = getVideo(handle, id);
  if (!video) throw P80Error.notFound('Video', { id });

  const allowed = TRANSCRIPT_STATUS_TRANSITIONS[video.transcriptStatus];
  if (!allowed.includes(next)) {
    throw new Error(
      `Illegal transcript_status transition ${video.transcriptStatus} -> ${next} ` +
        `for video ${id}. Legal: ${allowed.join(', ')}.`,
    );
  }
  handle.sqlite
    .prepare('UPDATE videos SET transcript_status = ?, updated_at = ? WHERE id = ?')
    .run(next, now(), id);
}

/** Stage 2 writes only `none` and `transcript_ready`; the rest of the vocabulary is
 *  declared for Stage 4 so it does not have to be reopened. No transition table yet,
 *  because the pipeline that would move through it does not exist. */
export function setProcessingStatus(
  handle: DatabaseHandle,
  id: string,
  next: ProcessingStatus,
): void {
  handle.sqlite
    .prepare('UPDATE videos SET processing_status = ?, updated_at = ? WHERE id = ?')
    .run(next, now(), id);
}

/**
 * The ingest job's write: identity, size, and duration, in one statement.
 *
 * Separate from `updateVideo` because that function deliberately refuses to patch
 * `external_video_id` — changing a video's identity orphans its transcript and every
 * occurrence built on it. The exception this makes is narrow and one-directional: it fills
 * in an identity that was `pending:`, and it refuses to overwrite a real hash with a
 * different one. That guard is the whole reason this is not a general setter.
 */
export function setMediaIdentity(
  handle: DatabaseHandle,
  id: string,
  input: { contentHash: string; mediaBytes: number; durationMs: number | null },
): VideoRow {
  const video = getVideo(handle, id);
  if (!video) throw P80Error.notFound('Video', { id });

  if (!isPendingIdentity(video.externalVideoId) && video.externalVideoId !== input.contentHash) {
    throw new Error(
      `Refusing to change video ${id} from ${video.externalVideoId} to ` +
        `${input.contentHash}. Re-pointing a video at different content is the repair ` +
        'path, which verifies the hash and reports a mismatch to the user.',
    );
  }

  handle.sqlite
    .prepare(
      `UPDATE videos
          SET external_video_id = ?, media_bytes = ?, duration_ms = COALESCE(?, duration_ms),
              media_missing = 0, updated_at = ?
        WHERE id = ?`,
    )
    .run(input.contentHash, input.mediaBytes, input.durationMs, now(), id);

  return getVideo(handle, id)!;
}

/**
 * Re-point a video at a moved file, or record that its file is gone.
 *
 * Never cascades. The transcript, word array, items, and review history do not need the
 * bytes; only playback does (ADR 0018 §3). A video whose media is missing is still one you
 * can study from — it is one you cannot replay.
 *
 * **`url` follows a re-point, because it is what the clients display.** For `local_media`
 * it holds the same relative path `media_path` does — set from one value at creation — and
 * it is the fallback name on `/videos` and the transcript page for a video with no title.
 * Left behind, it names a file the video no longer reads, and the library names the other
 * one: two surfaces disagreeing about which file belongs to which video is how somebody
 * tidying up duplicates deletes the wrong one.
 *
 * A *missing* file does not move it. `media_path = null` means the reference is gone, and
 * the last known location is the most useful thing left to show.
 */
export function setMediaLocation(
  handle: DatabaseHandle,
  id: string,
  input: { mediaPath?: string | null; mediaMissing: boolean },
): VideoRow {
  const sets = ['media_missing = ?', 'updated_at = ?'];
  const params: unknown[] = [input.mediaMissing ? 1 : 0, now()];
  if (input.mediaPath !== undefined) {
    sets.unshift('media_path = ?');
    params.unshift(input.mediaPath);
  }
  if (input.mediaPath) {
    sets.unshift('url = ?');
    params.unshift(input.mediaPath);
  }
  handle.sqlite.prepare(`UPDATE videos SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);

  const video = getVideo(handle, id);
  if (!video) throw P80Error.notFound('Video', { id });
  return video;
}

export interface TranscriptRowCounts {
  deletedSegments: number;
  deletedCorrections: number;
  deletedFiles: number;
}

export interface DeleteVideoCounts extends TranscriptRowCounts {
  /** Items whose last occurrence went with the video. Reported because the user is
   *  entitled to know that deleting a video retired part of their curriculum. */
  archivedItems: number;
}

/**
 * Counts are taken inside the transaction rather than read from the cascade, so the number
 * reported to the user is the number actually removed.
 *
 * **Approved `learning_items` survive** (`01-domain-model.md` §7 invariant 5), and an item
 * whose last occurrence goes becomes `archived` rather than being deleted, so review
 * history stays interpretable.
 *
 * The archival is done here, explicitly. It used to say the schema enforced it, and the
 * schema does not: the foreign keys cascade `item_occurrences` away and leave the item row
 * `active` with nothing to play — which is the state invariant 2 forbids, reachable through
 * the ordinary Delete button. Nothing could have caught it before Stage 3, because there
 * were no items; the first end-to-end run that created one and then deleted its video
 * found it immediately.
 *
 * `status = 'archived'` is enough to take the item out of scheduling — every session query
 * filters on `active` — so the cards are left alone and keep their history.
 */
export function deleteVideo(handle: DatabaseHandle, id: string): DeleteVideoCounts {
  return handle.sqlite.transaction(() => {
    const counts = countTranscriptRows(handle, id);
    handle.sqlite.prepare('DELETE FROM videos WHERE id = ?').run(id);

    // After the cascade, not before: which items lost their last occurrence is only
    // knowable once the occurrences are gone.
    const archived = handle.sqlite
      .prepare(
        `UPDATE learning_items
            SET status = 'archived', updated_at = ?
          WHERE status <> 'archived'
            AND NOT EXISTS (SELECT 1 FROM item_occurrences o WHERE o.item_id = id)`,
      )
      .run(now());

    return { ...counts, archivedItems: archived.changes };
  })();
}

export function countTranscriptRows(
  handle: DatabaseHandle,
  videoId: string,
): TranscriptRowCounts {
  const one = (sql: string) =>
    (handle.sqlite.prepare(sql).get(videoId) as { n: number } | undefined)?.n ?? 0;
  return {
    deletedSegments: one('SELECT COUNT(*) AS n FROM transcript_segments WHERE video_id = ?'),
    deletedCorrections: one(
      'SELECT COUNT(*) AS n FROM transcript_corrections WHERE video_id = ?',
    ),
    deletedFiles: one('SELECT COUNT(*) AS n FROM transcript_files WHERE video_id = ?'),
  };
}
