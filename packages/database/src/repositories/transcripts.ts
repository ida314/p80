import {
  P80Error,
  newId,
  now,
  type ParseWarningKind,
  type TimingGranularity,
  type TranscriptFormat,
  type TranscriptSource,
} from '@p80/core';
import type { DatabaseHandle } from '../client.js';

/**
 * Transcript storage — files, segments, and corrections.
 *
 * The invariant that shapes this whole file: **`transcript_segments` is never mutated
 * after ingestion.** A correction is a row in `transcript_corrections`, and the corrected
 * view is produced on read. `06-scoring.md` §4.2 counts corrections as a transcript-quality
 * signal, which only works if they are rows; and §38.4's mitigation for bad captions is
 * source replay, which only works if the original text is still there to replay against.
 */

export interface StoredParseWarning {
  kind: ParseWarningKind;
  segmentIndex: number | null;
  message: string;
}

export interface TranscriptFileRow {
  id: string;
  videoId: string;
  format: TranscriptFormat;
  originalFilename: string | null;
  storagePath: string | null;
  checksum: string;
  parserVersion: string;
  warnings: StoredParseWarning[];
  /** `asr` | `upload` (ADR 0016). Load-bearing for Stage 4's `punct_confidence`. */
  source: TranscriptSource;
  /** `word` | `cue` (ADR 0017). Consumers branch on this rather than on whether a join
   *  returns rows. */
  timingGranularity: TimingGranularity;
  asrModelId: string | null;
  asrAlignmentModelId: string | null;
  detectedLanguage: string | null;
  languageProbability: number | null;
  createdAt: number;
}

interface RawFile {
  id: string;
  video_id: string;
  format: string;
  original_filename: string | null;
  storage_path: string | null;
  checksum: string;
  parser_version: string;
  parse_warnings_json: string | null;
  source: string;
  timing_granularity: string;
  asr_model_id: string | null;
  asr_alignment_model_id: string | null;
  detected_language: string | null;
  language_probability: number | null;
  created_at: number;
}

function toFile(row: RawFile): TranscriptFileRow {
  return {
    id: row.id,
    videoId: row.video_id,
    format: row.format as TranscriptFormat,
    originalFilename: row.original_filename,
    storagePath: row.storage_path,
    checksum: row.checksum,
    parserVersion: row.parser_version,
    warnings: row.parse_warnings_json
      ? (JSON.parse(row.parse_warnings_json) as StoredParseWarning[])
      : [],
    source: row.source as TranscriptSource,
    timingGranularity: row.timing_granularity as TimingGranularity,
    asrModelId: row.asr_model_id,
    asrAlignmentModelId: row.asr_alignment_model_id,
    detectedLanguage: row.detected_language,
    languageProbability: row.language_probability,
    createdAt: row.created_at,
  };
}

export interface InsertTranscriptFileInput {
  /**
   * Supplied by the caller, because the storage path is built from it and the file has to
   * be on disk before the row exists — see the upload route. Minting it here instead would
   * give the path one id and the row another.
   */
  id: string;
  videoId: string;
  format: TranscriptFormat;
  originalFilename: string | null;
  /** Null for `source = 'asr'` — there is no uploaded file to point at. */
  storagePath: string | null;
  checksum: string;
  parserVersion: string;
  /** Defaults to the upload path, which is what every caller but the ASR handler is. */
  source?: TranscriptSource;
  timingGranularity?: TimingGranularity;
  asrModelId?: string | null;
  asrAlignmentModelId?: string | null;
  detectedLanguage?: string | null;
  languageProbability?: number | null;
}

export function insertTranscriptFile(
  handle: DatabaseHandle,
  input: InsertTranscriptFileInput,
): TranscriptFileRow {
  const { id } = input;
  handle.sqlite
    .prepare(
      `INSERT INTO transcript_files
         (id, video_id, format, original_filename, storage_path, checksum,
          parser_version, parse_warnings_json, source, timing_granularity,
          asr_model_id, asr_alignment_model_id, detected_language, language_probability,
          created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.videoId,
      input.format,
      input.originalFilename,
      input.storagePath,
      input.checksum,
      input.parserVersion,
      input.source ?? 'upload',
      // A `cue` default is the honest one: an uploaded VTT has no word timing and never
      // will, and only the ASR handler is in a position to claim otherwise.
      input.timingGranularity ?? 'cue',
      input.asrModelId ?? null,
      input.asrAlignmentModelId ?? null,
      input.detectedLanguage ?? null,
      input.languageProbability ?? null,
      now(),
    );
  return getTranscriptFile(handle, id)!;
}

export interface WordInput {
  wordIndex: number;
  text: string;
  startMs: number;
  endMs: number;
  confidence: number | null;
}

export interface WordRow extends WordInput {
  id: string;
  videoId: string;
  transcriptFileId: string;
}

/**
 * Delete-then-insert, inside one transaction — the same idempotency argument
 * `replaceSegments` makes. `UNIQUE (transcript_file_id, word_index)` means an insert-only
 * handler trips the constraint on every retry.
 *
 * Scoped to a transcript file rather than to a video, because a video can hold several:
 * an ASR run and a later upload coexist, and the upload winning (ADR 0016 §1) must not
 * delete the evidence the ASR run produced.
 */
export function replaceWords(
  handle: DatabaseHandle,
  args: { videoId: string; transcriptFileId: string; words: readonly WordInput[] },
): number {
  const insert = handle.sqlite.prepare(
    `INSERT INTO transcript_words
       (id, video_id, transcript_file_id, word_index, text, start_ms, end_ms, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return handle.sqlite.transaction(() => {
    handle.sqlite
      .prepare('DELETE FROM transcript_words WHERE transcript_file_id = ?')
      .run(args.transcriptFileId);
    for (const word of args.words) {
      insert.run(
        newId(),
        args.videoId,
        args.transcriptFileId,
        word.wordIndex,
        word.text,
        word.startMs,
        word.endMs,
        word.confidence,
      );
    }
    return args.words.length;
  })();
}

export function listWords(
  handle: DatabaseHandle,
  transcriptFileId: string,
  options: { offset?: number; limit?: number } = {},
): WordRow[] {
  const rows = handle.sqlite
    .prepare(
      `SELECT * FROM transcript_words
        WHERE transcript_file_id = ?
        ORDER BY word_index
        LIMIT ? OFFSET ?`,
    )
    .all(transcriptFileId, options.limit ?? 100_000, options.offset ?? 0) as Array<{
    id: string;
    video_id: string;
    transcript_file_id: string;
    word_index: number;
    text: string;
    start_ms: number;
    end_ms: number;
    confidence: number | null;
  }>;

  return rows.map((r) => ({
    id: r.id,
    videoId: r.video_id,
    transcriptFileId: r.transcript_file_id,
    wordIndex: r.word_index,
    text: r.text,
    startMs: r.start_ms,
    endMs: r.end_ms,
    confidence: r.confidence,
  }));
}

export function countWords(handle: DatabaseHandle, transcriptFileId: string): number {
  return (
    (
      handle.sqlite
        .prepare('SELECT COUNT(*) AS n FROM transcript_words WHERE transcript_file_id = ?')
        .get(transcriptFileId) as { n: number } | undefined
    )?.n ?? 0
  );
}

export function getTranscriptFile(
  handle: DatabaseHandle,
  id: string,
): TranscriptFileRow | null {
  const row = handle.sqlite
    .prepare('SELECT * FROM transcript_files WHERE id = ?')
    .get(id) as RawFile | undefined;
  return row ? toFile(row) : null;
}

/** The transcript in force for a video: the most recently uploaded file. Earlier ones are
 *  kept so a replacement leaves a record of what was there before. */
export function getLatestTranscriptFile(
  handle: DatabaseHandle,
  videoId: string,
): TranscriptFileRow | null {
  const row = handle.sqlite
    .prepare(
      `SELECT * FROM transcript_files
        WHERE video_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .get(videoId) as RawFile | undefined;
  return row ? toFile(row) : null;
}

export function findTranscriptFileByChecksum(
  handle: DatabaseHandle,
  videoId: string,
  checksum: string,
): TranscriptFileRow | null {
  const row = handle.sqlite
    .prepare('SELECT * FROM transcript_files WHERE video_id = ? AND checksum = ? LIMIT 1')
    .get(videoId, checksum) as RawFile | undefined;
  return row ? toFile(row) : null;
}

export function setParseWarnings(
  handle: DatabaseHandle,
  transcriptFileId: string,
  warnings: readonly StoredParseWarning[],
): void {
  handle.sqlite
    .prepare('UPDATE transcript_files SET parse_warnings_json = ? WHERE id = ?')
    .run(JSON.stringify(warnings), transcriptFileId);
}

export interface SegmentInput {
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  rawText: string;
  normalizedText: string;
  sequenceIndex: number;
  /** Half-open range into `transcript_words` (ADR 0017). Undefined for uploads, which
   *  have no word array to index into. */
  wordStartIndex?: number | null;
  wordEndIndex?: number | null;
  confidence?: number | null;
}

export interface SegmentRow extends SegmentInput {
  id: string;
  videoId: string;
  confidence: number | null;
  wordStartIndex: number | null;
  wordEndIndex: number | null;
}

interface RawSegment {
  id: string;
  video_id: string;
  start_ms: number;
  end_ms: number;
  speaker_label: string | null;
  raw_text: string;
  normalized_text: string;
  confidence: number | null;
  sequence_index: number;
  word_start_index: number | null;
  word_end_index: number | null;
}

/**
 * Delete-then-insert, inside one transaction.
 *
 * The delete is what makes a retried `PARSE_TRANSCRIPT` idempotent:
 * `UNIQUE (video_id, sequence_index)` means an insert-only handler trips the constraint on
 * every second run. Doing both inside one transaction means segments never exist in a
 * half-written state, and a crash rolls back to whatever was there before.
 */
export function replaceSegments(
  handle: DatabaseHandle,
  videoId: string,
  segments: readonly SegmentInput[],
): number {
  const insert = handle.sqlite.prepare(
    `INSERT INTO transcript_segments
       (id, video_id, start_ms, end_ms, speaker_label, raw_text, normalized_text,
        confidence, sequence_index, word_start_index, word_end_index)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  return handle.sqlite.transaction(() => {
    handle.sqlite.prepare('DELETE FROM transcript_segments WHERE video_id = ?').run(videoId);
    for (const segment of segments) {
      insert.run(
        newId(),
        videoId,
        segment.startMs,
        segment.endMs,
        segment.speakerLabel,
        segment.rawText,
        segment.normalizedText,
        segment.confidence ?? null,
        segment.sequenceIndex,
        segment.wordStartIndex ?? null,
        segment.wordEndIndex ?? null,
      );
    }
    return segments.length;
  })();
}

export interface ProjectedSegmentRow extends SegmentRow {
  /** Latest correction applied, or `rawText` when there is none. */
  text: string;
  corrected: boolean;
  correctionId: string | null;
}

export interface ListSegmentsOptions {
  limit?: number;
  /** `sequenceIndex` of the last row already fetched. */
  cursor?: number | null;
  includeCorrections?: boolean;
}

export interface ListSegmentsResult {
  segments: ProjectedSegmentRow[];
  nextCursor: number | null;
}

/**
 * Reads segments in **time order** with corrections projected over them.
 *
 * `ORDER BY start_ms, sequence_index` is Stage 2 exit criterion 2. It is deliberately not
 * the storage order: the parser stores file order and records an `out_of_order` warning
 * when the two differ, because reordering a transcript is a decision that belongs to the
 * user, not to the reader.
 *
 * The window function picks the latest correction per segment. Ties on `created_at` are
 * routine — nudging a timestamp with the keyboard produces two corrections inside one
 * millisecond — and they break on `rowid`, which is SQLite's own insertion order and
 * therefore correct no matter which process wrote the row. `@p80/core`'s
 * `projectCorrections` breaks the same tie on the id, which agrees because `newId` is
 * monotonic within a process and corrections are only ever written by the API.
 * `idx_transcript_corrections_segment` already exists for this query.
 */
export function listSegmentsWithCorrections(
  handle: DatabaseHandle,
  videoId: string,
  options: ListSegmentsOptions = {},
): ListSegmentsResult {
  const limit = options.limit ?? 1000;
  const includeCorrections = options.includeCorrections ?? true;
  const params: unknown[] = [videoId];
  let cursorClause = '';
  if (options.cursor != null) {
    cursorClause = 'AND s.sequence_index > ?';
    params.push(options.cursor);
  }

  const correctionJoin = includeCorrections
    ? `LEFT JOIN (
         SELECT transcript_segment_id, id, after_text, after_start_ms, after_end_ms,
                ROW_NUMBER() OVER (
                  PARTITION BY transcript_segment_id
                  ORDER BY created_at DESC, rowid DESC
                ) AS rn
           FROM transcript_corrections
          WHERE video_id = ?
       ) c ON c.transcript_segment_id = s.id AND c.rn = 1`
    : '';
  if (includeCorrections) params.splice(1, 0, videoId);

  const rows = handle.sqlite
    .prepare(
      `SELECT s.*,
              ${includeCorrections ? 'c.id AS correction_id, c.after_text, c.after_start_ms, c.after_end_ms' : 'NULL AS correction_id, NULL AS after_text, NULL AS after_start_ms, NULL AS after_end_ms'}
         FROM transcript_segments s
         ${correctionJoin}
        WHERE s.video_id = ? ${cursorClause}
        ORDER BY s.start_ms ASC, s.sequence_index ASC
        LIMIT ?`,
    )
    .all(...params, limit + 1) as Array<
    RawSegment & {
      correction_id: string | null;
      after_text: string | null;
      after_start_ms: number | null;
      after_end_ms: number | null;
    }
  >;

  const page = rows.slice(0, limit).map((row) => ({
    id: row.id,
    videoId: row.video_id,
    startMs: row.after_start_ms ?? row.start_ms,
    endMs: row.after_end_ms ?? row.end_ms,
    speakerLabel: row.speaker_label,
    rawText: row.raw_text,
    normalizedText: row.normalized_text,
    confidence: row.confidence,
    sequenceIndex: row.sequence_index,
    wordStartIndex: row.word_start_index,
    wordEndIndex: row.word_end_index,
    text: row.after_text ?? row.raw_text,
    corrected: row.correction_id !== null,
    correctionId: row.correction_id,
  }));

  const last = page[page.length - 1];
  return {
    segments: page,
    nextCursor: rows.length > limit && last !== undefined ? last.sequenceIndex : null,
  };
}

export function getSegment(
  handle: DatabaseHandle,
  videoId: string,
  segmentId: string,
): ProjectedSegmentRow | null {
  // Scoped by video as well as by id. Looking up the segment alone would let one video's
  // URL address another video's segments.
  const row = handle.sqlite
    .prepare('SELECT * FROM transcript_segments WHERE id = ? AND video_id = ?')
    .get(segmentId, videoId) as RawSegment | undefined;
  if (!row) return null;

  const correction = handle.sqlite
    .prepare(
      `SELECT id, after_text, after_start_ms, after_end_ms
         FROM transcript_corrections
        WHERE transcript_segment_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(segmentId) as
    | {
        id: string;
        after_text: string | null;
        after_start_ms: number | null;
        after_end_ms: number | null;
      }
    | undefined;

  return {
    id: row.id,
    videoId: row.video_id,
    startMs: correction?.after_start_ms ?? row.start_ms,
    endMs: correction?.after_end_ms ?? row.end_ms,
    speakerLabel: row.speaker_label,
    rawText: row.raw_text,
    normalizedText: row.normalized_text,
    confidence: row.confidence,
    sequenceIndex: row.sequence_index,
    wordStartIndex: row.word_start_index,
    wordEndIndex: row.word_end_index,
    text: correction?.after_text ?? row.raw_text,
    corrected: correction !== undefined,
    correctionId: correction?.id ?? null,
  };
}

/**
 * Records a correction. **Never touches `transcript_segments`.**
 *
 * All four `before_*` and all four `after_*` are written, so the row is self-contained
 * evidence of what changed — a later reader does not have to reconstruct the prior state
 * by replaying every correction before it.
 */
export function insertCorrection(
  handle: DatabaseHandle,
  input: {
    videoId: string;
    segmentId: string;
    beforeText: string;
    afterText: string;
    beforeStartMs: number;
    afterStartMs: number;
    beforeEndMs: number;
    afterEndMs: number;
  },
): string {
  const id = newId();
  handle.sqlite
    .prepare(
      `INSERT INTO transcript_corrections
         (id, video_id, transcript_segment_id, before_text, after_text,
          before_start_ms, after_start_ms, before_end_ms, after_end_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.videoId,
      input.segmentId,
      input.beforeText,
      input.afterText,
      input.beforeStartMs,
      input.afterStartMs,
      input.beforeEndMs,
      input.afterEndMs,
      now(),
    );
  return id;
}

export function countCorrections(handle: DatabaseHandle, videoId: string): number {
  const row = handle.sqlite
    .prepare('SELECT COUNT(*) AS n FROM transcript_corrections WHERE video_id = ?')
    .get(videoId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export function countSegments(handle: DatabaseHandle, videoId: string): number {
  const row = handle.sqlite
    .prepare('SELECT COUNT(*) AS n FROM transcript_segments WHERE video_id = ?')
    .get(videoId) as { n: number } | undefined;
  return row?.n ?? 0;
}

export interface DeleteTranscriptCounts {
  deletedSegments: number;
  deletedCorrections: number;
  deletedFiles: number;
  cancelledJobs: number;
}

/**
 * Removes a video's transcript and says what that cost.
 *
 * Corrections are deleted **explicitly** rather than left to the foreign-key cascade, so
 * the reported count is a fact rather than an inference.
 *
 * Any pending `PARSE_TRANSCRIPT` for this video is cancelled in the same transaction.
 * Without that, a queued job resurrects the segments seconds after the user deleted them.
 * A job already claimed cannot be caught this way, which is why the handler also treats a
 * missing file row as a successful no-op.
 *
 * The uploaded files themselves stay on disk. The source stays recoverable; corrections do
 * not, which is why they are counted out loud.
 */
export function deleteTranscript(
  handle: DatabaseHandle,
  videoId: string,
): DeleteTranscriptCounts {
  return handle.sqlite.transaction(() => {
    const count = (sql: string) =>
      (handle.sqlite.prepare(sql).get(videoId) as { n: number } | undefined)?.n ?? 0;

    const deletedCorrections = count(
      'SELECT COUNT(*) AS n FROM transcript_corrections WHERE video_id = ?',
    );
    const deletedSegments = count(
      'SELECT COUNT(*) AS n FROM transcript_segments WHERE video_id = ?',
    );
    const deletedFiles = count(
      'SELECT COUNT(*) AS n FROM transcript_files WHERE video_id = ?',
    );

    handle.sqlite
      .prepare('DELETE FROM transcript_corrections WHERE video_id = ?')
      .run(videoId);
    handle.sqlite.prepare('DELETE FROM transcript_segments WHERE video_id = ?').run(videoId);
    handle.sqlite.prepare('DELETE FROM transcript_files WHERE video_id = ?').run(videoId);

    const cancelled = handle.sqlite
      .prepare(
        `UPDATE jobs
            SET status = 'cancelled', completed_at = ?, claimed_by = NULL, claimed_at = NULL
          WHERE job_type = 'PARSE_TRANSCRIPT'
            AND entity_id = ?
            AND status = 'pending'`,
      )
      .run(now(), videoId);

    return {
      deletedSegments,
      deletedCorrections,
      deletedFiles,
      cancelledJobs: cancelled.changes,
    };
  })();
}

export function requireVideoScopedSegment(
  handle: DatabaseHandle,
  videoId: string,
  segmentId: string,
): ProjectedSegmentRow {
  const segment = getSegment(handle, videoId, segmentId);
  if (!segment) throw P80Error.notFound('Segment', { videoId, segmentId });
  return segment;
}
