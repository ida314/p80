import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  ERROR_CODES,
  P80Error,
  PARSE_TRANSCRIPT_JOB_VERSION,
  assertInsideRoot,
  normalizeTranscriptText,
  parseTranscriptInput,
  type Config,
  type ParseTranscriptOutput,
} from '@p80/core';
import {
  countCorrections,
  getTranscriptFile,
  getVideo,
  replaceSegments,
  setParseWarnings,
  setProcessingStatus,
  setTranscriptStatus,
} from '@p80/database';
import { parseTranscriptContent } from '@p80/providers';
import type { JobContext, JobHandler } from '../registry.js';

/**
 * `PARSE_TRANSCRIPT` — turns an uploaded file into `transcript_segments`.
 *
 * **Idempotent by construction.** `replaceSegments` deletes and re-inserts inside one
 * transaction, because `UNIQUE (video_id, sequence_index)` means an insert-only handler
 * trips the constraint on every second run. A crash after `COMMIT` but before the job is
 * marked done leaves the job `running`; `reclaimStaleJobs` returns it to `pending`, it
 * re-runs, and it produces an identical segment set.
 *
 * **No partial state.** Segments only ever exist inside the transaction that also flips
 * `transcript_status`, so "ready" and "segments present" cannot disagree. A crash mid-write
 * rolls back to `parsing`, which is visible and retryable.
 *
 * **Failure is preserved, never fabricated** (§27.4). A file that cannot be used sets
 * `transcript_status = 'failed'` and still writes its warnings, so the user can see *why*
 * rather than only that something went wrong. Nothing invents a fallback transcript.
 */
export function createParseTranscriptHandler(deps: { config: Config }): JobHandler {
  return async (ctx: JobContext): Promise<ParseTranscriptOutput> => {
    // `jobVersion` is how a payload written by a previous release is detected rather than
    // mis-read. A queued job outlives the code that enqueued it.
    const input = parseTranscriptInput.parse(ctx.job.inputJson);

    const file = getTranscriptFile(ctx.handle, input.transcriptFileId);
    const video = getVideo(ctx.handle, input.videoId);

    // The DELETE race. A user who deletes a transcript while its parse is queued must not
    // have the segments reappear a moment later. Deletion cancels pending jobs, but that
    // loses to a job already claimed, so the handler treats a missing row as *success with
    // nothing to do* rather than as an error — there is no failure here to report.
    if (file === null || video === null) {
      ctx.logger.info(
        { jobId: ctx.job.id, videoId: input.videoId },
        'transcript or video deleted while the parse was queued; nothing to do',
      );
      return skipped(input, file === null ? 'file_row_deleted' : 'video_deleted');
    }

    setTranscriptStatus(ctx.handle, video.id, 'parsing');

    // A hand-edited row, or a database restored beside a different storage directory,
    // cannot make the worker read outside the storage root.
    const path = assertInsideRoot(file.storagePath ?? '', deps.config.P80_STORAGE_PATH);
    const content = readFileSync(path, 'utf8');

    // Cheap, and the only way to notice a truncated write or a file swapped underneath.
    const checksum = createHash('sha256').update(content, 'utf8').digest('hex');
    if (checksum !== file.checksum) {
      setTranscriptStatus(ctx.handle, video.id, 'failed');
      throw new P80Error(
        ERROR_CODES.TRANSCRIPT_FILE_CORRUPT,
        'The stored transcript file no longer matches its checksum. Upload it again.',
        { statusCode: 500, retryable: false, details: { transcriptFileId: file.id } },
      );
    }

    const result = parseTranscriptContent(content, {
      filename: file.originalFilename,
      formatHint: file.format,
    });

    // Checked after parsing and before any write, so cancellation never leaves a video
    // half-parsed.
    if (ctx.isCancelled()) {
      throw new Error('Cancelled before writing; nothing was changed.');
    }

    if (result.fatal !== null) {
      // Warnings are written even on failure — the preview and detail screens need to say
      // what was wrong, and "it failed" on its own is not actionable.
      setParseWarnings(ctx.handle, file.id, result.warnings);
      setTranscriptStatus(ctx.handle, video.id, 'failed');
      throw new P80Error(result.fatal.code, result.fatal.message, {
        statusCode: 422,
        retryable: false,
        details: result.fatal.details,
      });
    }

    // A stale retry must not take the user's hand corrections with it through the FK
    // cascade. Only the replace path — which has already told the user how many
    // corrections it is about to destroy — sets this flag.
    const corrections = countCorrections(ctx.handle, video.id);
    if (corrections > 0 && !input.allowDiscardCorrections) {
      setTranscriptStatus(ctx.handle, video.id, 'failed');
      throw P80Error.conflict(
        ERROR_CODES.TRANSCRIPT_HAS_CORRECTIONS,
        'This transcript has corrections that re-parsing would discard. Replace it explicitly if that is what you want.',
        { corrections },
      );
    }

    const segments = result.segments.map((segment) => ({
      startMs: segment.startMs,
      endMs: segment.endMs,
      speakerLabel: segment.speakerLabel,
      rawText: segment.rawText,
      // The one place normalization happens: between parsing and insertion.
      // `ParsedTranscriptSegment` carries no `normalizedText`, deliberately — the parser's
      // job is the file's shape, not the text's canonical form.
      normalizedText: normalizeTranscriptText(segment.rawText),
      sequenceIndex: segment.sequenceIndex,
    }));

    ctx.handle.sqlite.transaction(() => {
      replaceSegments(ctx.handle, video.id, segments);
      setParseWarnings(ctx.handle, file.id, result.warnings);
      setTranscriptStatus(ctx.handle, video.id, 'ready');
      setProcessingStatus(ctx.handle, video.id, 'transcript_ready');
    })();

    const last = segments[segments.length - 1];
    return {
      jobVersion: PARSE_TRANSCRIPT_JOB_VERSION,
      transcriptFileId: file.id,
      parserVersion: result.parserVersion,
      format: result.format,
      segmentCount: segments.length,
      warningCount: result.warnings.length,
      warningsByKind: result.warningsByKind,
      // Deliberately not written to `videos.duration_ms`: the transcript's end is not the
      // video's end, and a wrong duration in a displayed field is worse than a null one.
      // The web client fills it from `player.getDuration()`, which is the only lawful
      // source — the Data API needs a key, and rule 14 forbids keys.
      lastEndMs: last?.endMs ?? null,
      skipped: null,
    };
  };
}

function skipped(
  input: { transcriptFileId: string; parserVersion: string },
  reason: 'file_row_deleted' | 'video_deleted',
): ParseTranscriptOutput {
  return {
    jobVersion: PARSE_TRANSCRIPT_JOB_VERSION,
    transcriptFileId: input.transcriptFileId,
    parserVersion: input.parserVersion,
    format: 'vtt',
    segmentCount: 0,
    warningCount: 0,
    warningsByKind: {},
    lastEndMs: null,
    skipped: reason,
  };
}
