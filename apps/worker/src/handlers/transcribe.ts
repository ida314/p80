import { createHash } from 'node:crypto';
import {
  ERROR_CODES,
  P80Error,
  TRANSCRIBE_JOB_VERSION,
  assertInsideMediaRoot,
  groupWords,
  newId,
  normalizeTranscriptText,
  transcribeInput,
  type Config,
  type TranscribeOutput,
} from '@p80/core';
import {
  getLatestTranscriptFile,
  getVideo,
  insertTranscriptFile,
  replaceSegments,
  replaceWords,
  setMediaLocation,
  setParseWarnings,
  setProcessingStatus,
  setTranscriptStatus,
} from '@p80/database';
import type { AsrProvider } from '@p80/providers';
import type { JobContext, JobHandler } from '../registry.js';

/**
 * `TRANSCRIBE` — local ASR over the referenced media file (ADR 0016).
 *
 * The first job in P80 that takes minutes rather than milliseconds, which changes what its
 * failure handling has to be good at.
 *
 * **Idempotent, at the cost of re-running the model.** A retry re-transcribes and replaces;
 * `replaceWords` and `replaceSegments` both delete-then-insert inside a transaction, so a
 * second run produces one transcript rather than two or a constraint violation. There is
 * no resume point inside the ASR call itself — the sidecar either returns a word array or
 * it does not.
 *
 * **The upload always wins** (ADR 0016 §1). A user-supplied transcript arriving while this
 * job was queued or running means the ASR result is discarded, not merged and not written
 * over the top. The job succeeds: nothing failed, and the user got what they asked for.
 *
 * **Nothing is fabricated** (§27.4). A sidecar that is down, has no model, or disagrees
 * about the language leaves `transcript_status = 'failed'` and a message saying which. It
 * never produces an empty transcript, which is indistinguishable from a silent video and
 * sends the user looking in the wrong place.
 */
export function createTranscribeHandler(deps: {
  config: Config;
  asr: AsrProvider;
}): JobHandler {
  return async (ctx: JobContext): Promise<TranscribeOutput> => {
    const input = transcribeInput.parse(ctx.job.inputJson);
    const video = getVideo(ctx.handle, input.videoId);

    if (video === null) {
      ctx.logger.info(
        { jobId: ctx.job.id, videoId: input.videoId },
        'video deleted while transcription was queued; nothing to do',
      );
      return skipped(input.videoId, 'video_deleted');
    }

    // Checked before the expensive part, not after. Spending four minutes on a transcript
    // that is going to be thrown away is the kind of waste that only shows up as a slow
    // machine.
    const existing = getLatestTranscriptFile(ctx.handle, video.id);
    if (existing !== null && existing.source === 'upload') {
      ctx.logger.info(
        { videoId: video.id },
        'an uploaded transcript arrived first; discarding the ASR run',
      );
      return skipped(video.id, 'upload_won');
    }

    const absolutePath = assertInsideMediaRoot(
      video.mediaPath ?? '',
      deps.config.P80_MEDIA_ROOT,
    );

    setTranscriptStatus(ctx.handle, video.id, 'parsing');

    let result;
    try {
      result = await deps.asr.transcribe({
        mediaPath: absolutePath,
        language: input.language,
      });
    } catch (error) {
      // `failed` rather than a silent revert to `none`: the user asked for a transcript and
      // is entitled to see that the attempt happened and did not work. The upload path is
      // still open, which is what the UI offers next.
      setTranscriptStatus(ctx.handle, video.id, 'failed');
      throw error;
    }

    /**
     * An empty result is a failure to transcribe, not a transcript of silence.
     *
     * The sidecar already refuses this case, so reaching here means a provider disagreed
     * with its own contract. Checking anyway is the whole point of the rule: an empty
     * transcript stored as `ready` is indistinguishable from a silent video, and the
     * difference decides whether the user goes looking for a subtitle file or for a bug.
     */
    if (result.words.length === 0) {
      setTranscriptStatus(ctx.handle, video.id, 'failed');
      throw new P80Error(
        ERROR_CODES.ASR_FAILED,
        'Transcription returned no words. The file may have no speech track, or the audio may not be readable.',
        { statusCode: 422, retryable: false, details: { videoId: video.id } },
      );
    }

    if (ctx.isCancelled()) {
      setTranscriptStatus(ctx.handle, video.id, 'none');
      throw new Error('Cancelled before writing; nothing was changed.');
    }

    // The precedence check again, because minutes have passed since the first one and an
    // upload is exactly the kind of thing a user does while waiting.
    const arrivedDuring = getLatestTranscriptFile(ctx.handle, video.id);
    if (arrivedDuring !== null && arrivedDuring.source === 'upload') {
      ctx.logger.info(
        { videoId: video.id },
        'an uploaded transcript arrived during transcription; discarding the ASR run',
      );
      setTranscriptStatus(ctx.handle, video.id, 'ready');
      return skipped(video.id, 'upload_won');
    }

    const groups = groupWords(result.words);
    const transcriptFileId = newId();

    ctx.handle.sqlite.transaction(() => {
      insertTranscriptFile(ctx.handle, {
        id: transcriptFileId,
        videoId: video.id,
        // The word array is P80's own representation, not a subtitle file's.
        format: 'internal_json',
        originalFilename: null,
        // No uploaded file exists. The transcript is reproducible from the media plus the
        // recorded model ids, which is a better guarantee than a stored copy of the output.
        storagePath: null,
        checksum: checksumOf(result.words),
        parserVersion: `asr/${deps.asr.modelId}`,
        source: 'asr',
        timingGranularity: 'word',
        asrModelId: deps.asr.modelId,
        asrAlignmentModelId: deps.asr.alignmentModelId,
        detectedLanguage: result.detectedLanguage,
        languageProbability: result.languageProbability,
      });

      replaceWords(ctx.handle, {
        videoId: video.id,
        transcriptFileId,
        words: result.words.map((w, index) => ({
          wordIndex: index,
          text: w.text,
          startMs: w.startMs,
          endMs: w.endMs,
          confidence: w.confidence,
        })),
      });

      replaceSegments(
        ctx.handle,
        video.id,
        groups.map((group, index) => ({
          startMs: group.startMs,
          endMs: group.endMs,
          speakerLabel: null,
          rawText: group.text,
          normalizedText: normalizeTranscriptText(group.text),
          sequenceIndex: index,
          // The index range is what makes these segments a *view* of the word array
          // rather than a second copy of it (ADR 0017).
          wordStartIndex: group.wordStartIndex,
          wordEndIndex: group.wordEndIndex,
          confidence: group.confidence,
        })),
      );

      setParseWarnings(ctx.handle, transcriptFileId, result.warnings);
      setTranscriptStatus(ctx.handle, video.id, 'ready');
      setProcessingStatus(ctx.handle, video.id, 'transcript_ready');
      // The file was readable a moment ago, which is worth recording: a video marked
      // missing and then successfully transcribed is no longer missing.
      setMediaLocation(ctx.handle, video.id, { mediaMissing: false });
    })();

    const warningsByKind: Record<string, number> = {};
    for (const warning of result.warnings) {
      warningsByKind[warning.kind] = (warningsByKind[warning.kind] ?? 0) + 1;
    }

    return {
      jobVersion: TRANSCRIBE_JOB_VERSION,
      videoId: video.id,
      transcriptFileId,
      wordCount: result.words.length,
      segmentCount: groups.length,
      warningCount: result.warnings.length,
      warningsByKind,
      detectedLanguage: result.detectedLanguage,
      modelId: deps.asr.modelId,
      alignmentModelId: deps.asr.alignmentModelId,
      durationMs: result.durationMs,
      skipped: null,
    };
  };
}

/**
 * Over the word array, not over a file — there is no file.
 *
 * It exists for the same reason the upload path's checksum does: to make two runs
 * comparable. Re-transcribing after a model change and getting an identical checksum says
 * the change did not affect this video, which is worth knowing before re-running Stage 4
 * on it.
 */
function checksumOf(words: readonly { text: string; startMs: number; endMs: number }[]): string {
  const canonical = words.map((w) => `${w.startMs}:${w.endMs}:${w.text}`).join('\n');
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function skipped(videoId: string, reason: TranscribeOutput['skipped']): TranscribeOutput {
  return {
    jobVersion: TRANSCRIBE_JOB_VERSION,
    videoId,
    transcriptFileId: null,
    wordCount: 0,
    segmentCount: 0,
    warningCount: 0,
    warningsByKind: {},
    detectedLanguage: null,
    modelId: null,
    alignmentModelId: null,
    durationMs: null,
    skipped: reason,
  };
}
