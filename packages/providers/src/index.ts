/**
 * Provider interfaces — `docs/contracts/04-providers.md`.
 *
 * **Nothing here may be instantiated at startup.** Spec §5.2 requires P80 to be useful
 * with no LLM configured, and during Stages 1–6 the vLLM server is simply down. A startup
 * provider check would turn the ordinary case into a failure.
 *
 * Stage 2 adds the first implementations — the transcript parsers, the `local_media`
 * adapter, and the ASR sidecar client. The dictionary and LLM providers are still
 * interfaces only; they arrive in Stages 6 and 7.
 *
 * The ASR provider is the one implementation here that reaches the network, and only to
 * loopback. It is still not constructed at startup: a sidecar that is down is an ordinary
 * state, and ingestion falls back to the upload path rather than failing to boot.
 */

import type {
  MediaDescriptor,
  MediaPathRejection,
  MediaSourceKind,
  ParseWarningKind,
  Register,
  TranscriptFormat,
} from '@p80/core';

// --- MediaSourceAdapter (§1) -------------------------------------------------------

/**
 * ADR 0014 moved the kind list to `@p80/core`'s `PARSE_WARNING_KINDS` and added an eighth
 * member, `subtitle_boilerplate`. It needs a runtime value rather than an inline union,
 * because this is persisted to `transcript_files.parse_warnings_json` and therefore has to
 * back a Zod schema, a severity map, and an exhaustiveness test.
 */
export interface ParseWarning {
  kind: ParseWarningKind;
  /** `null` for a whole-file anomaly, whose message carries a count instead. */
  segmentIndex: number | null;
  /**
   * Never contains transcript text — only kind names, indices, counts, line numbers, and
   * pattern names. A message reading `cue "..." is empty` would inject attacker-chosen
   * text into a field that is persisted forever and rendered by every client, which is
   * `CLAUDE.md` rule 8 reaching a surface nobody thinks of as a render.
   */
  message: string;
}

export interface ParsedTranscriptSegment {
  startMs: number;
  endMs: number;
  speakerLabel: string | null;
  rawText: string;
  sequenceIndex: number;
}

export interface TranscriptParseResult {
  segments: ParsedTranscriptSegment[];
  warnings: ParseWarning[];
  format: TranscriptFormat;
  parserVersion: string;
}

export interface ValidationResult {
  valid: boolean;
  /** ADR 0018: the content hash, when it is known. Null at validate time — identity is
   *  computed by the ingest job, because hashing a multi-gigabyte file does not belong on
   *  a request that returns a job reference. */
  externalVideoId: string | null;
  /** Normalised and contained, relative to the media root. Null when invalid. */
  relativePath: string | null;
  errors: string[];
  /** Machine-readable, for `details.reason` on the error envelope. */
  reason: MediaPathRejection | null;
}

/**
 * Hard media rules (ADR 0015, replacing spec §8 and §38.8) — not negotiable, and no ticket
 * relaxes them without a policy review recorded in `docs/decisions/`:
 *
 * 1. P80 never acquires media. No downloader, no stream extraction, no URL that resolves
 *    to media bytes. How a file arrived on disk is outside the system.
 * 2. P80 makes no outbound request to obtain a transcript. ASR is local; upload is
 *    user-supplied.
 * 3. P80 never copies media into its own storage. It holds a reference and reads through
 *    it.
 * 4. A media path is untrusted input. It resolves under `P80_MEDIA_ROOT` or it is
 *    rejected.
 *
 * The former rules 2 (*never isolate or store an audio track*) and 5 (*never claim
 * frame-accurate playback*) are deleted. Both described a world with an embedded player
 * and no local file, and ADR 0015 records what each deletion costs. Do not reintroduce
 * either as a hedge.
 */
export interface MediaSourceAdapter {
  readonly kind: MediaSourceKind;
  readonly supportsLocalMedia: boolean;
  readonly supportsAutomaticTranscriptAccess: boolean;

  validate(input: { path: string }): Promise<ValidationResult>;
  getMediaDescriptor(source: {
    videoId: string;
    mediaMissing: boolean;
    startMs?: number;
    endMs?: number;
  }): MediaDescriptor;
  parseTranscript(file: {
    content: string;
    filename: string | null;
  }): Promise<TranscriptParseResult>;
}

// --- AsrProvider (§1a) -------------------------------------------------------------
//
// ADR 0016. Transcription is a provider like any other: the worker depends on this
// interface, and the sidecar client that implements it is one file.

export interface AsrWord {
  text: string;
  startMs: number;
  endMs: number;
  /** 0..1, or null where the aligner could not place the word. A number meaning "unknown"
   *  would be indistinguishable from a bad score, and the two have different consequences:
   *  a low score is a doubtful clip, an unplaced word has no clip at all. */
  confidence: number | null;
}

export interface AsrRequest {
  /** Absolute, and already resolved under `P80_MEDIA_ROOT` by the caller. The provider
   *  does not re-derive it from user input — containment is checked once, where the
   *  untrusted value enters. */
  mediaPath: string;
  /** Pinned from `profile.target_language`, never detected (ADR 0016 §3). */
  language: string;
}

export interface AsrResult {
  /** Flat and in time order — THE source of truth under ADR 0017. Whisper's own segment
   *  boundaries are discarded: they come from the 30-second decoding window rather than
   *  from linguistics, and routinely fall nowhere near the punctuation the model itself
   *  emitted. Stage 4 decides sentences from this array. */
  words: AsrWord[];
  detectedLanguage: string;
  languageProbability: number;
  /** Confidence anomalies. Never a dropped word (§14.2). */
  warnings: ParseWarning[];
  durationMs: number;
}

export interface AsrProvider {
  readonly name: string;
  /** Recorded on the transcript so it is attributable and recomputable across a model
   *  change — the same requirement §27.5 places on annotations. */
  readonly modelId: string;
  readonly alignmentModelId: string | null;
  transcribe(request: AsrRequest): Promise<AsrResult>;
}

// --- DictionaryProvider (§3) -------------------------------------------------------

export interface DictionaryQuery {
  lemma: string;
  surfaceForm: string;
  partOfSpeech: string | null;
  targetLanguage: string;
  nativeLanguage: string;
}

export interface DictionarySense {
  senseId: string;
  definition: string;
  /** The language `definition` is written in. When this is not the profile's native
   *  language, the gloss shown to the learner is an LLM bridge translation and MUST be
   *  labelled unverified (§16.5). This is the single failure mode two Wiktionary editions
   *  introduce (ADR 0003). */
  definitionLanguage: string;
  partOfSpeech: string | null;
  register: Register | null;
  region: string | null;
  examples: string[];
  isOffensiveOrSensitive: boolean;
}

export interface DictionaryEntry {
  providerEntryId: string | null;
  /** Sense inventories differ between editions and are NEVER merged (ADR 0003). */
  edition: 'en' | 'de';
  senses: DictionarySense[];
  retrievedAt: Date;
}

export interface MultiwordHeadword {
  language: string;
  lemmaSeq: string[];
  senseCount: number;
}

/** The dictionary is the lexical authority; the LLM is an explainer (§14.9). A definition
 *  with no dictionary evidence is unverified and cannot be presented as confident. */
export interface DictionaryProvider {
  readonly name: string;
  readonly version: string;
  lookup(query: DictionaryQuery): Promise<DictionaryEntry[]>;
  multiwordHeadwords(language: string): AsyncIterable<MultiwordHeadword>;
}

// --- LlmProvider (§4) ---------------------------------------------------------------

export interface StructuredLlmRequest<T> {
  promptVersion: string;
  systemPrompt: string;
  /** Untrusted content — transcripts, sentences, user notes. Never concatenated into
   *  `systemPrompt` (§16.4, §32.6). */
  untrustedFields: Record<string, string>;
  /** Trusted structured context — dictionary senses, POS tags, frequency data. */
  trustedFields: Record<string, unknown>;
  schema: Record<string, unknown>;
  maxRetries: number;
  __resultType?: T;
}

export interface StructuredLlmResponse<T> {
  value: T | null;
  valid: boolean;
  validationErrors: string[];
  confidence: number;
  attempts: number;
  tokensIn: number;
  tokensOut: number;
  /** DEAD under local inference (ADR 0005) — always null. Never synthesize a dollar
   *  figure: an invented number is worse than an absent one. */
  costUsd: number | null;
  /** Wall-clock. Seconds of inference, not dollars, is the scarce resource. */
  latencyMs: number;
}

export interface LlmProvider {
  readonly name: string;
  readonly modelId: string;
  generateStructured<T>(
    request: StructuredLlmRequest<T>,
  ): Promise<StructuredLlmResponse<T>>;
}

export interface CandidateExplanation {
  selectedSenseId: string | null;
  shortMeaning: string;
  naturalTranslation: string | null;
  literalTranslation: string | null;
  register: Register;
  dialectRegion: string | null;
  sensitiveUsageNote: string | null;
  contextualRationale: string;
  nearSynonyms: Array<{ form: string; distinction: string }>;
  confidence: number;
  needsHumanReview: boolean;
}

// --- Implementations ------------------------------------------------------------------
//
// Re-exported at the end so the interfaces above stay readable as a contract. The
// dictionary and LLM providers have none yet; they arrive in Stages 6 and 7.

export {
  BOILERPLATE_PATTERNS,
  LIMITS as TRANSCRIPT_LIMITS,
  TRANSCRIPT_PARSER_VERSION,
  detectBoilerplate,
  detectTranscriptFormat,
  parseTranscriptContent,
  type DetectionResult,
  type FatalValidation,
  type FullParseResult,
} from './transcript/index.js';

export { LocalMediaSourceAdapter, createLocalMediaSource } from './media/local.js';

export { SidecarAsrProvider, createAsrProvider } from './asr/sidecar.js';
