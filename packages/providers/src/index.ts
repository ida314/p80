/**
 * Provider interfaces — `docs/contracts/04-providers.md`.
 *
 * **Stage 1 ships interfaces and no implementations.** No dictionary index, no vLLM
 * client, no YouTube adapter. Nothing here may be instantiated at startup: spec §5.2
 * requires P80 to be useful with no LLM configured, and during Stages 1–6 the vLLM server
 * will simply be down. A startup provider check would turn the ordinary case into a
 * failure.
 */

import type {
  MediaSourceKind,
  Register,
  TranscriptFormat,
} from '@p80/core';

// --- MediaSourceAdapter (§1) -------------------------------------------------------

export interface EmbedDescriptor {
  provider: 'youtube';
  externalVideoId: string;
  startSeconds?: number;
  endSeconds?: number;
}

export interface ParseWarning {
  kind:
    | 'overlapping_timestamps'
    | 'out_of_order'
    | 'missing_punctuation'
    | 'malformed_line'
    | 'unparsed_region'
    | 'encoding_fallback'
    | 'suspicious_duration';
  segmentIndex: number | null;
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
  externalVideoId: string | null;
  errors: string[];
}

/**
 * Hard media rules (spec §8, §38.8) — not negotiable, and no ticket relaxes them without
 * a policy review recorded in `docs/decisions/`:
 *
 * 1. Never download YouTube video or audio. No `yt-dlp`, no stream extraction, no
 *    proxying of media bytes.
 * 2. Never isolate or store an audio track.
 * 3. Never scrape public captions. Transcripts are user-supplied in MVP.
 * 4. Playback happens exclusively through the YouTube IFrame Player API.
 * 5. Playback precision is approximate. UI copy must never claim frame accuracy.
 */
export interface MediaSourceAdapter {
  readonly kind: MediaSourceKind;
  readonly supportsLocalMedia: boolean;
  readonly supportsAutomaticTranscriptAccess: boolean;

  validate(input: { url: string }): Promise<ValidationResult>;
  getEmbedDescriptor(source: { externalVideoId: string }): EmbedDescriptor;
  parseTranscript(file: {
    content: string;
    filename: string | null;
  }): Promise<TranscriptParseResult>;
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
