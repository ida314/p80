import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Media uploads in flight (ADR 0024, migration 0003).
 *
 * The mirror of `0003_media_uploads.sql`, which carries the reasoning. Two things are worth
 * repeating here because they are invariants a reader of this file might otherwise break:
 *
 * - **`receivedBytes` is the authority**, not the partial file's size on disk. The file is
 *   truncated to this before every write, so a crash between the write and the update heals
 *   on the next chunk.
 * - **`mediaRoot` is absolute and stored**, unlike `videos.mediaPath` which is relative on
 *   purpose. The root is editable while P80 runs (ADR 0019), and reading it per use — right
 *   everywhere else — would give a different answer mid-upload.
 */
export const mediaUploads = sqliteTable('media_uploads', {
  id: text('id').primaryKey(),
  profileId: text('profile_id').notNull(),
  /** As the browser sent it, sanitised for display. Never joined onto a path. */
  originalFilename: text('original_filename').notNull(),
  /** What `safeMediaFilename` proposed; a collision may change it at finalise time. */
  filename: text('filename').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  receivedBytes: integer('received_bytes').notNull(),
  /** `in_progress` | `completed` | `aborted` | `failed`. */
  status: text('status').notNull(),
  mediaRoot: text('media_root').notNull(),
  /** Media-root-relative, and null until the file is linked into `uploads/`. */
  mediaPath: text('media_path'),
  videoId: text('video_id'),
  jobId: text('job_id'),
  title: text('title'),
  interestsJson: text('interests_json'),
  /** 0/1. */
  transcribe: integer('transcribe').notNull(),
  errorJson: text('error_json'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  /** Refreshed on every chunk, so a slow upload survives and an abandoned one does not. */
  expiresAt: integer('expires_at').notNull(),
});
