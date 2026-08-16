-- 0003_media_uploads — ADR 0024.
--
-- A browser may now push a file into `<P80_MEDIA_ROOT>/uploads/`, in chunks, resumably.
-- One row per upload in flight.
--
-- WHY THIS IS A TABLE AND NOT THE .part FILE'S SIZE
-- ------------------------------------------------
-- Deriving progress from the partial file on disk is the obvious design and it cannot
-- carry six things that have nowhere else to live. The decisive one is **the filename**:
-- the browser sends a name, the server needs it at completion, and the only place to keep
-- it without a table is *in the partial file's own name* — which is untrusted input back
-- inside a path, the single thing this feature must not do. So the name lives in a column
-- and the partial is named from a ULID. Same argument `transcript_files.original_filename`
-- already makes.
--
-- The others: the declared size (without it, completion cannot tell *finished* from
-- *truncated*, and creation has no number to check free space against), the title and
-- interests supplied at creation and consumed at completion, `created_at`/`expires_at` for
-- the reaper, a terminal status so an aborted upload is distinguishable from a stalled one,
-- and `video_id` so a client that reloaded can be told where its upload went.
--
-- THE ROW IS THE AUTHORITY, AND THE FILE HEALS TOWARD IT
-- -----------------------------------------------------
-- `received_bytes` is what a resume is measured from, and the partial file is truncated to
-- it before every write. A crash between writing bytes and updating this column therefore
-- leaves the file long and the row short, and the next chunk corrects it. The mirror-image
-- design — trust the file — has no correction available, because a file that is longer than
-- it should be looks exactly like a file that is the right length.
--
-- WHY THE CHECK CONSTRAINTS ARE FINE HERE
-- ---------------------------------------
-- 0002 records at length why two CHECKs on `videos` are still deferred: SQLite cannot ADD
-- one to an existing table, and the 12-step rebuild fires ON DELETE CASCADE across every
-- child. **That hazard does not apply to a CREATE TABLE.** Nothing is being rebuilt and
-- nothing cascades, so the constraints go in at the start where they are free. Do not read
-- 0002's warning as a project-wide ban on CHECK.
--
-- §3 rule 1: hand-authored, forward-only, reviewed. The Drizzle definitions in
-- src/schema/uploads.ts mirror this file and `schema-parity.test.ts` compares them against
-- SQLite's own introspection, so the mirror cannot drift silently.

CREATE TABLE media_uploads (
  id                TEXT    PRIMARY KEY,
  profile_id        TEXT    NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,

  -- Exactly what the browser sent, sanitised for display only. Never joined onto a path.
  original_filename TEXT    NOT NULL,
  -- What `safeMediaFilename` proposed. The name actually used may differ, because a
  -- collision is resolved by trying the next candidate at the moment of finalising.
  filename          TEXT    NOT NULL,

  size_bytes        INTEGER NOT NULL CHECK (size_bytes >= 0),
  received_bytes    INTEGER NOT NULL DEFAULT 0 CHECK (received_bytes >= 0),

  status            TEXT    NOT NULL DEFAULT 'in_progress'
                      CHECK (status IN ('in_progress', 'completed', 'aborted', 'failed')),

  -- Absolute, and deliberately unlike `videos.media_path`, which is relative on purpose.
  -- This records where the partial physically is. ADR 0019 makes the media root editable
  -- while P80 runs, so reading it per use — correct everywhere else — would give a
  -- *different answer* mid-upload, leaving the partial under one root while completion
  -- moved it into another. Storing it is how that is detected rather than performed.
  media_root        TEXT    NOT NULL,

  -- Media-root-relative, written only once the file is linked into `uploads/`. NULL until
  -- then, which is what makes a reaped row unambiguous.
  media_path        TEXT,

  video_id          TEXT    REFERENCES videos(id) ON DELETE SET NULL,
  job_id            TEXT,

  title             TEXT,
  interests_json    TEXT,
  -- 0/1. ASR can be minutes per file on a CPU-only build, so uploading a batch and
  -- transcribing later is a real workflow rather than a hypothetical one.
  transcribe        INTEGER NOT NULL DEFAULT 1,
  error_json        TEXT,

  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  -- Refreshed on every chunk, so a slow overnight upload survives and an abandoned tab
  -- does not. An orphaned partial is the user's disk being consumed, not P80's.
  expires_at        INTEGER NOT NULL
);

-- `GET /api/uploads` — what is in flight for this profile, newest first.
CREATE INDEX idx_media_uploads_profile_status
  ON media_uploads (profile_id, status, created_at DESC);

-- The reaper's query, which runs on API start and on every session creation.
CREATE INDEX idx_media_uploads_expires
  ON media_uploads (status, expires_at);
