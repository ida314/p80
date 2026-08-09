-- 0002_local_media — ADR 0015, 0016, 0017, 0018.
--
-- P80 stops embedding YouTube and starts referencing local media files. Three things
-- change and one of them is new:
--
--   1. `videos` learns where a file is (`media_path`), whether it is still there
--      (`media_missing`), and how big it was (`media_bytes`). `external_video_id` stops
--      holding a YouTube id and starts holding a SHA-256 of the file's bytes — the column
--      does not change, so the existing UNIQUE becomes content-based duplicate detection
--      for free (ADR 0018).
--   2. `transcript_files` learns where a transcript came from and how precise its timing
--      is (ADR 0016, 0017). `source` is load-bearing for Stage 4, not bookkeeping.
--   3. `transcript_words` is new: the per-word forced alignment that ADR 0017 makes the
--      source of truth, with `transcript_segments` becoming index ranges over it.
--
-- §3 rule 1: hand-authored, forward-only, reviewed. The Drizzle definitions in
-- src/schema/ mirror this file and `schema-parity.test.ts` compares them against SQLite's
-- own introspection, so the mirror cannot drift silently.
--
-- ---------------------------------------------------------------------------------
-- WHY THE TWO CHECK CONSTRAINTS ARE *STILL* DEFERRED
-- ---------------------------------------------------------------------------------
-- `02-database.md` says to add CHECKs on `videos.transcript_status` and
-- `processing_status` "when a migration is next needed for another reason". This is that
-- migration, and they are still not here. The reason is worth recording, because it is a
-- trap rather than a preference:
--
-- SQLite cannot add a CHECK to an existing table. It requires the 12-step rebuild —
-- create, copy, drop, rename — and `DROP TABLE videos` with `PRAGMA foreign_keys = ON`
-- (which `src/client.ts` sets) performs an implicit DELETE that **fires ON DELETE CASCADE
-- on every child table**. That silently destroys every transcript, segment, correction,
-- sentence, token, and occurrence in the database. `PRAGMA defer_foreign_keys` does not
-- help: it defers constraint *violations*, not cascade *actions*, and `PRAGMA
-- foreign_keys` is a no-op inside a transaction, which is where every migration runs.
--
-- Adding them safely needs the migration runner to support a file that opts out of the
-- transaction and toggles the pragma around itself. That is real machinery for a
-- constraint that polices membership only — and membership is not what goes wrong here;
-- transitions are, and those are enforced in code by `setTranscriptStatus`. Do not "just
-- add the CHECK" without reading this paragraph.

-- ===================================================================================
-- 1. videos — a reference to a file, not an embed
-- ===================================================================================

-- ADR 0015/0018. Relative to P80_MEDIA_ROOT: an absolute path would break the moment the
-- library moved, which is the class of event this design exists to survive.
ALTER TABLE videos ADD COLUMN media_path TEXT;

-- Set when the file was not there last time P80 looked. Never cascades — the transcript,
-- word array, items, and review history do not need the bytes; only playback does.
ALTER TABLE videos ADD COLUMN media_missing INTEGER NOT NULL DEFAULT 0;

-- Size at ingest. A cheap mismatch check before paying for a re-hash.
ALTER TABLE videos ADD COLUMN media_bytes INTEGER;

-- `youtube_embedded` is gone from MEDIA_SOURCE_KINDS (ADR 0015), so a surviving row would
-- fail the z.enum() on every read and 500 the list endpoint. Such a row has no media file
-- and cannot get one, so it becomes a `local_media` video whose media P80 cannot reach —
-- which is exactly what it is. Its transcript and any items built on it survive, per
-- ADR 0018 §3, and the user can re-point it at a real file.
--
-- Its `external_video_id` stays the old YouTube id. That is not a SHA-256 and never will
-- be, but it cannot collide with one either: an 11-character YouTube id and a 64-character
-- hex digest share no values, so the UNIQUE constraint keeps working and the row stays
-- addressable. Re-pointing it writes a real hash.
UPDATE videos
   SET source_type = 'local_media',
       media_missing = 1
 WHERE source_type <> 'local_media';

CREATE INDEX idx_videos_profile_created ON videos(profile_id, created_at DESC);
CREATE INDEX idx_videos_media_missing ON videos(profile_id, media_missing);

-- ===================================================================================
-- 2. transcript_files — provenance and timing tier
-- ===================================================================================

-- ADR 0016. 'upload' is the default, so the existing rows — which are all uploads — are
-- correct without a data migration.
ALTER TABLE transcript_files ADD COLUMN source TEXT NOT NULL DEFAULT 'upload';

-- ADR 0017. A stored column rather than an inference from the absence of word rows: the
-- difference is a *capability* that consumers branch on, and a capability read off a
-- missing join is one nobody can see in a schema diagram.
ALTER TABLE transcript_files ADD COLUMN timing_granularity TEXT NOT NULL DEFAULT 'cue';

-- §27.5: recorded so a transcript is attributable and recomputable across a model change.
ALTER TABLE transcript_files ADD COLUMN asr_model_id TEXT;
ALTER TABLE transcript_files ADD COLUMN asr_alignment_model_id TEXT;
-- Detection still runs even though the decode language is pinned; a disagreement fails the
-- job (ADR 0016 §3), and these two columns are the evidence for that decision.
ALTER TABLE transcript_files ADD COLUMN detected_language TEXT;
ALTER TABLE transcript_files ADD COLUMN language_probability REAL;

-- ===================================================================================
-- 3. transcript_words — the source of truth where timing is word-level
-- ===================================================================================
--
-- ADR 0017. Written once by the ASR job; never rewritten. `transcript_segments` carries
-- denormalised text and timing for debuggability and for queries, rebuilt from these
-- indices rather than edited — an index range cannot desynchronise from the timing its
-- text is bound to, and every alternative can.

CREATE TABLE transcript_words (
  id                 TEXT PRIMARY KEY,
  video_id           TEXT    NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  transcript_file_id TEXT    NOT NULL REFERENCES transcript_files(id) ON DELETE CASCADE,
  -- Position in the flat array. The array is the unit of truth; this is its index.
  word_index         INTEGER NOT NULL,
  text               TEXT    NOT NULL,
  start_ms           INTEGER NOT NULL,
  end_ms             INTEGER NOT NULL,
  -- Alignment confidence 0..1, NULL where the aligner could not place the word. A number
  -- meaning "unknown" would be indistinguishable from a bad score, and the difference
  -- matters: an unplaced word has no clip, a low-confidence one has a doubtful clip.
  confidence         REAL,
  UNIQUE (transcript_file_id, word_index)
);
CREATE INDEX idx_transcript_words_video_time ON transcript_words(video_id, start_ms);

-- Half-open range into transcript_words. NULL at timing_granularity = 'cue', which is
-- every uploaded VTT and SRT and always will be.
ALTER TABLE transcript_segments ADD COLUMN word_start_index INTEGER;
ALTER TABLE transcript_segments ADD COLUMN word_end_index INTEGER;
