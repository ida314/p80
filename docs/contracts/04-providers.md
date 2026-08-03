# 04 — Provider and Adapter Interfaces

Source: original spec §8 (media policy), §16 (dictionary and LLM), §7.1 (language scope).

Everything external to P80 sits behind one of four interfaces. No pipeline code calls a
provider SDK directly.

---

## 1. `MediaSourceAdapter`

```ts
interface MediaSourceAdapter {
  readonly kind: MediaSourceKind;
  readonly supportsLocalMedia: boolean;
  readonly supportsAutomaticTranscriptAccess: boolean;

  validate(input: MediaSourceInput): Promise<ValidationResult>;
  getEmbedDescriptor(source: MediaSource): EmbedDescriptor;
  parseTranscript(file: TranscriptInput): Promise<TranscriptParseResult>;
}

type MediaSourceKind =
  | "youtube_embedded"
  | "user_uploaded_transcript"
  | "local_media"              // DEFERRED
  | "licensed_corpus"          // DEFERRED
  | "authorized_youtube_owner"; // DEFERRED

interface EmbedDescriptor {
  provider: "youtube";
  externalVideoId: string;
  startSeconds?: number;
  endSeconds?: number;
}

interface TranscriptParseResult {   // ADDED: the spec returns bare segments, which
  segments: TranscriptSegment[];    // leaves parse warnings nowhere to go, despite
  warnings: ParseWarning[];         // §14.2 requiring them to be recorded.
  format: "vtt" | "srt" | "pasted_timestamped" | "internal_json";
  parserVersion: string;
}

interface ParseWarning {
  kind: "overlapping_timestamps" | "out_of_order" | "missing_punctuation"
      | "malformed_line" | "unparsed_region" | "encoding_fallback"
      | "suspicious_duration";
  segmentIndex: number | null;
  message: string;
}
```

MVP implements `youtube_embedded` and `user_uploaded_transcript` only.

### Hard media rules (§8, §38.8)

These are not negotiable and no ticket may relax them without a policy review recorded in
`docs/decisions/`:

1. **Never download YouTube video or audio.** No `yt-dlp`, no stream extraction, no
   proxying of media bytes.
2. **Never isolate or store an audio track.**
3. **Never scrape public captions.** Transcripts are user-supplied in MVP.
4. Playback happens exclusively through the YouTube IFrame Player API.
5. Playback precision is approximate — the player starts at the nearest keyframe. The UI
   must never claim frame-accurate playback (§19.1).

### Clip playback procedure (§19.1)

1. Load the embedded player near the target interval.
2. Seek to `startMs` once the player reports ready.
3. Poll current time.
4. Pause at `endMs + postRoll`.
5. Let the user nudge the occurrence boundary and persist the adjustment.

Pre-roll and post-roll are user-configurable settings, not constants.

---

## 2. `LanguageAdapter` <!-- ADDED -->

§7.1 lists ten language-specific capabilities and requires that interfaces exist for
additional languages, but never defines the interface. Without it, language rules leak
into pipeline code and the "one language first" constraint becomes permanent.

```ts
interface LanguageAdapter {
  readonly language: string;            // BCP-47
  readonly version: string;             // recorded in pipeline_versions

  segmentSentences(segments: TranscriptSegment[]): Sentence[];
  tokenize(sentence: string): Token[];
  annotate(sentence: string): AnnotatedToken[];   // lemma, POS, morphology, entities
  normalizeOrthography(surface: string): string;

  /** Which POS tags are suppressed as isolated candidates (01-domain-model.md §6). */
  isSuppressedAsIsolatedItem(token: AnnotatedToken): boolean;

  /** Language-specific MWE surface patterns, e.g. verb-particle frames. */
  expressionPatterns(): ExpressionPattern[];

  /** Language-specific construction templates with slots. */
  constructionPatterns(): ConstructionTemplate[];

  frequencyRank(lemma: string): number | null;
  frequencyBand(lemma: string): number | null;
}
```

Rules:

- No `if (language === "...")` anywhere outside an adapter implementation.
- Pipeline stages depend on the interface only.
- A language is not "supported" until it has an adapter passing the full fixture suite
  (§34.2) — having an adapter object is not sufficient.

---

## 3. `DictionaryProvider`

```ts
interface DictionaryProvider {
  readonly name: string;
  readonly version: string;
  lookup(query: DictionaryQuery): Promise<DictionaryEntry[]>;
}

interface DictionaryQuery {
  lemma: string;
  surfaceForm: string;
  partOfSpeech: string | null;
  targetLanguage: string;
  nativeLanguage: string;
}

interface DictionaryEntry {
  providerEntryId: string | null;
  senses: Array<{
    senseId: string;
    definition: string;
    partOfSpeech: string | null;
    register: Register | null;
    region: string | null;
    examples: string[];
    isOffensiveOrSensitive: boolean;
  }>;
  retrievedAt: Date;
}
```

**The dictionary is the lexical authority; the LLM is not** (§14.9). A definition with no
dictionary evidence is marked unverified and cannot be presented as confident.

Failure behaviour (§27.4): a lookup failure marks the candidate as needing manual sense
selection. It never falls through to an LLM-only definition presented as verified.

---

## 4. `LlmProvider`

```ts
interface LlmProvider {
  readonly name: string;
  readonly modelId: string;
  generateStructured<T>(
    request: StructuredLlmRequest<T>
  ): Promise<StructuredLlmResponse<T>>;
}

interface StructuredLlmRequest<T> {
  promptVersion: string;
  systemPrompt: string;
  /** Untrusted content — transcripts, sentences, user notes. Never concatenated
   *  into systemPrompt. */
  untrustedFields: Record<string, string>;
  /** Trusted structured context — dictionary senses, POS tags, frequency data. */
  trustedFields: Record<string, unknown>;
  schema: JsonSchema<T>;
  maxRetries: number;
}

interface StructuredLlmResponse<T> {
  value: T | null;
  valid: boolean;
  validationErrors: string[];
  confidence: number;
  attempts: number;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}
```

### Explanation output schema (§16.3)

```ts
interface CandidateExplanation {
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
```

### Injection resistance (§16.4, §32.6)

Transcript text is attacker-controlled for the purposes of this design, even though the
attacker is usually just an odd subtitle.

1. Untrusted content goes only in `untrustedFields`, rendered inside delimited blocks.
2. The system prompt states that content inside those blocks is data, never instructions.
3. Output must validate against the schema. Invalid output is rejected, not repaired by
   hand-parsing.
4. Retries are bounded (`maxRetries`, default 2). Exhausted retries leave the candidate
   pending, not approved.
5. The LLM has **no tools, no browsing, and no code execution** in MVP.
6. Every call is written to `provider_calls` with keys redacted.
7. Uncertainty is displayed, never smoothed into confident prose.

### Cost control (§38.10)

- Deterministic processing runs first; only candidates that survive the quality gates are
  sent to the LLM.
- Requests are batched where the schema allows.
- Results are cached by `(canonicalForm, senseContextHash, promptVersion, modelId)`.
- Generated examples are limited.
- Cost per approved item and per retained item is tracked from the beginning, not added
  later (§31.3).

### Degraded mode (§5.2)

P80 must remain useful with **no LLM configured**. Without a provider:

- Extraction, scoring, dictionary lookup, cards, review, and difficulty all work.
- Sense selection falls back to the manual UI built in Stage 6.
- The UI states that automatic disambiguation is unavailable — it does not silently
  degrade quality.

This is a standing test requirement, not a one-time check: the integration suite runs
once with a provider configured and once without.

---

## 5. Slang policy (§16.5)

MVP: use dictionary evidence where it exists; allow LLM contextual explanation; label
unsupported slang explanations **unverified**; require human approval; run no autonomous
web search.

Post-MVP additions (approved web lookup with citations, regional usage tracking,
dated/offensive/reclaimed flags) are DEFERRED and are not to be started early.
