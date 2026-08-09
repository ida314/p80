/**
 * The ASR provider — a thin client over `services/nlp`'s `POST /transcribe` (ADR 0016).
 *
 * Thin on purpose. Everything interesting about transcription is a model, and models are
 * Python, which is the boundary ADR 0002 drew. What is here is the wire format, the
 * timeout, and the translation of the sidecar's failure modes into P80 errors — because
 * the one thing this layer must not do is turn a refusal into an empty transcript.
 *
 * The sidecar is on loopback. `CLAUDE.md` rule 15's external-request list stays empty:
 * `127.0.0.1` is not external.
 */

import { ERROR_CODES, P80Error, type ParseWarningKind } from '@p80/core';
import type { AsrProvider, AsrRequest, AsrResult, AsrWord, ParseWarning } from '../index.js';

/**
 * Generous, and not a mistake. Transcribing an hour of video with a large model takes
 * minutes on a GPU and much longer without one — a timeout tuned for an HTTP request would
 * abort every real job. The protection against a genuinely hung sidecar is the job
 * ceiling in `04-providers.md` §4, which is resumable; this only stops a socket leaking.
 */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;

interface WireWord {
  text: string;
  start_ms: number;
  end_ms: number;
  confidence: number | null;
}

interface WireWarning {
  kind: string;
  segment_index: number | null;
  message: string;
}

interface WireResponse {
  words: WireWord[];
  detected_language: string;
  language_probability: number;
  duration_ms: number;
  warnings: WireWarning[];
  model_id: string;
  alignment_model_id: string | null;
}

export class SidecarAsrProvider implements AsrProvider {
  readonly name = 'nlp-sidecar';

  /**
   * Reported by the sidecar on its first successful call rather than configured here.
   *
   * The model that actually ran is the one worth recording on the transcript (§27.5), and
   * a value copied from this process's environment is a claim about what the *other*
   * process was configured with. Those disagree exactly when it matters — after someone
   * changes one of them.
   */
  private observedModelId: string | null = null;
  private observedAlignmentModelId: string | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {}

  get modelId(): string {
    return this.observedModelId ?? 'unknown';
  }

  get alignmentModelId(): string | null {
    return this.observedAlignmentModelId;
  }

  async transcribe(request: AsrRequest): Promise<AsrResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    let response: Response;
    try {
      response = await fetch(new URL('/transcribe', this.baseUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          media_path: request.mediaPath,
          language: request.language,
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      // A sidecar that is down is an ordinary state, not a crash. It is 503 rather than
      // 500 so the API can say "transcription is unavailable, upload a transcript
      // instead" — which is the designed fallback, not a degraded mode.
      throw new P80Error(
        ERROR_CODES.ASR_UNAVAILABLE,
        'The NLP sidecar is not reachable. Start it, or upload a transcript instead.',
        { statusCode: 503, cause, retryable: true },
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      throw await this.toError(response);
    }

    const body = (await response.json()) as WireResponse;
    this.observedModelId = body.model_id;
    this.observedAlignmentModelId = body.alignment_model_id;

    return {
      words: body.words.map(toWord),
      detectedLanguage: body.detected_language,
      languageProbability: body.language_probability,
      durationMs: body.duration_ms,
      warnings: body.warnings.map(toWarning),
    };
  }

  /**
   * The sidecar's refusals are distinguishable on purpose, and none of them is recoverable
   * by retrying with different arguments — ADR 0016 §3 requires each to be visible rather
   * than absorbed:
   *
   * - `501` — no model installed. Not retryable; installing it is a setup step.
   * - `409` — the decode language and the detected language disagree. Not retryable: the
   *   video is not in the language the profile studies, and transcribing it anyway would
   *   produce a plausible curriculum of the wrong language.
   * - `503` — GPU was configured and is unavailable. Retryable, because it usually is.
   */
  private async toError(response: Response): Promise<P80Error> {
    const detail = await response.text().catch(() => '');
    const message = detail.slice(0, 500) || `The NLP sidecar returned ${response.status}.`;

    if (response.status === 501) {
      return new P80Error(
        ERROR_CODES.ASR_UNAVAILABLE,
        `No ASR model is installed in the sidecar. ${message}`,
        { statusCode: 503, retryable: false },
      );
    }
    if (response.status === 409) {
      return new P80Error(ERROR_CODES.ASR_LANGUAGE_MISMATCH, message, {
        statusCode: 422,
        retryable: false,
      });
    }
    return new P80Error(ERROR_CODES.ASR_FAILED, message, {
      statusCode: 502,
      retryable: response.status === 503,
    });
  }
}

function toWord(w: WireWord): AsrWord {
  return {
    text: w.text,
    startMs: Math.round(w.start_ms),
    endMs: Math.round(w.end_ms),
    confidence: w.confidence,
  };
}

/**
 * The sidecar chooses from the same closed vocabulary the parsers do, and an unrecognized
 * kind is rejected rather than passed through. This column is persisted forever and
 * re-served on every transcript read (ADR 0014), so it is a render surface, and a kind
 * invented on the other side of an HTTP boundary is untrusted input reaching one.
 */
function toWarning(w: WireWarning): ParseWarning {
  return {
    kind: w.kind as ParseWarningKind,
    segmentIndex: w.segment_index,
    message: w.message.slice(0, 500),
  };
}

export function createAsrProvider(baseUrl: string, timeoutMs?: number): SidecarAsrProvider {
  return new SidecarAsrProvider(baseUrl, timeoutMs);
}
