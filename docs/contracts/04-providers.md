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

### Provider independence

**YouTube is one adapter, not the foundation.** The unit P80 reasons about is a *timed
media source plus a transcript* — an `.mp4` or equivalent, with an interval to play.
`youtube_embedded` is the MVP implementation of that shape because it is the cheapest
lawful route to a large library, not because the domain depends on it. Nothing above
`MediaSourceAdapter` may assume YouTube: video IDs, the IFrame API, and `youtu.be` URLs
all live behind the interface.

This keeps `local_media` (user-supplied `.mp4`) and further embedded providers available
later as new adapters rather than as a refactor. Two constraints on that path, recorded so
they are not rediscovered:

- **The hard rules below govern acquisition, not playback surface.** Rules 1–3 forbid P80
  from *obtaining* media it was not given. A file the user already holds is not in that
  category. Rule 4 *is* playback-surface and would need amending for `local_media` — an
  ADR when that adapter is built, not a change now.
- **DRM-protected services stay out of reach regardless of adapter design.** Provider
  independence means the interface does not preclude a provider; it does not make one
  possible where there is no embeddable player or lawful programmatic seek.

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

**This procedure is browser-only.** The IFrame Player API cannot run in a terminal, which
is why review sessions and the video loop live in the web client while management surfaces
live in the TUI (ADR 0007). `MediaRecorder` (§19.3–19.4) is browser-only for the same
reason; voice is optional in MVP (§21.5), so this does not block TUI coverage elsewhere.

Timestamped links — `https://youtu.be/<id>?t=<seconds>`, or `embed/<id>?start=&end=` — are
within policy and are the right mechanism for **navigation** from any client ("open this
occurrence"). They are not a substitute for the audio-recognition card, which needs
programmatic seek-and-stop, replay, and a hidden-then-revealed transcript.

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

  /** Dependency relations that mark a lexicalized attachment — particle, fixed, flat,
   *  verb-preposition frames. MWE generation runs on the dependency graph, NOT on the
   *  token sequence: German separable verbs are discontinuous (`Ich fange … an`) and no
   *  n-gram window recovers them. See ADR 0009. */
  mweRelations(): MweRelationSpec[];

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

### Registry, not singleton <!-- ADDED: ADR 0001 -->

Adapters are resolved from a registry keyed by `profile.target_language`, never imported
directly:

```ts
interface LanguageAdapterRegistry {
  register(adapter: LanguageAdapter): void;
  /** Throws if the language has no registered adapter. Never returns a fallback —
   *  a missing adapter is a configuration error, not a degraded mode. */
  get(language: string): LanguageAdapter;
  supported(): string[];
}
```

**MVP registers exactly one adapter: German** (ADR 0001). The registry is the single hook
that keeps Portuguese, Spanish, and French a registration rather than a refactor, and it is
the *only* cost the multi-language ambition imposes on MVP. No profile switcher, no second
adapter implementation, no second evaluation corpus — those are the real expense and they
stay out of scope (spec §6, Phase E).

`get()` throwing rather than falling back is deliberate. A silent fallback to the German
adapter for a Spanish profile would produce plausible, wrong lemmas — and every downstream
symptom would point somewhere else.

### Implementation: Python sidecar <!-- ADDED: ADR 0002 -->

`segmentSentences`, `tokenize`, and `annotate` are served by a stateless Python sidecar
(FastAPI + spaCy `de_core_news_lg`), reachable on loopback only, exposing one narrow HTTP
interface matching this contract. `frequencyRank` / `frequencyBand` are served from the
local OpenSubtitles-derived index (ADR 0004) and do not cross the process boundary.

- The sidecar's model version is recorded in `pipeline_versions.language_adapter_version`,
  so annotations are recomputable and comparable across a model change (§27.5).
- **Integration tests must run with the sidecar unavailable and fail visibly.** Spec §35
  Stage 4 requires annotation failures to be visible rather than silently ignored; a
  sidecar that is down must not degrade into whitespace tokenization.
- ADR 0001 records German lemmatization as this stack's weak point. Swapping German to
  Stanza inside the same sidecar is a version bump, not a contract change.

---

## 3. `DictionaryProvider`

```ts
interface DictionaryProvider {
  readonly name: string;
  readonly version: string;
  lookup(query: DictionaryQuery): Promise<DictionaryEntry[]>;

  /** ADDED (ADR 0009): every multiword headword for a language, emitted once at
   *  index-build time and compiled into a lemma trie. This is layer 1 of the MWE funnel
   *  and the single largest precision lever available — its output is dictionary-attested,
   *  so it arrives pre-grounded under §14.9. Matching is one pass over the sentence. */
  multiwordHeadwords(language: string): AsyncIterable<MultiwordHeadword>;
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
  /** ADDED (ADR 0003): which Wiktionary edition this entry came from. Sense inventories
   *  differ between editions and are NEVER merged, so provenance under §16.2 stays exact
   *  and coverage can be attributed to the right source. */
  edition: "en" | "de";
  senses: Array<{
    senseId: string;
    definition: string;
    /** ADDED (ADR 0003): the language `definition` is written in. When this is not the
     *  profile's native language, the gloss shown to the learner is an LLM bridge
     *  translation and MUST be labelled unverified (§16.5). */
    definitionLanguage: string;
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

### Two editions, one index <!-- ADDED: ADR 0003 -->

MVP indexes **both** the English and German Wiktextract dumps into one local SQLite FTS
store with an `edition` discriminator. `lookup()` applies a fixed precedence:

1. Prefer an English-edition sense — it is directly presentable to an English native.
2. Fall back to the German edition where English has no entry or no POS-matching sense.
3. A German-edition sense **grounds** the item under §14.9, but its English rendering comes
   from the LLM and is therefore **unverified** under §16.5.

**Rule 3 is the one to get right.** The LLM's bridge translation must never be presented as
the dictionary's definition — that is the single failure mode two editions introduce, and it
would quietly convert the lexical authority into an explainer while every UI surface still
claimed it was grounded.

`multiwordHeadwords()` draws from both editions; the German edition is the richer source of
multiword and phraseme headwords, which is layer 1 of the MWE funnel (ADR 0009).

---

## 4. `LlmProvider`

**All inference is local** (ADR 0005): vLLM with an OpenAI-compatible endpoint, bound to
loopback, behind this interface. **No cloud adapter exists** — not configured, not written,
not tested. The interface stays provider-shaped so one remains possible; that is not the
same as one being present.

The consequence worth stating at the contract level: **there is no API key anywhere in
P80.** Spec §32.3 and `CLAUDE.md` rule 14 are satisfied structurally rather than by
discipline, §15's external-request disclosure list is empty for this path, and transcript
text never leaves the machine.

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
  /** DEAD under local inference (ADR 0005) — always null. Retained for interface
   *  stability. `provider_calls.latency_ms` is the live cost signal; seconds of
   *  inference, not dollars, is the scarce resource. Never synthesize a dollar figure:
   *  an invented number is worse than an absent one. */
  costUsd: number | null;
  /** ADDED (ADR 0005): wall-clock for this call. Feeds the §31.3 cost-per-retained-item
   *  metric and the uselimit wall-clock ceiling. */
  latencyMs: number;
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

The two translation fields are scalar **here only** — this is a transient per-call DTO, and
one call translates into exactly one language, the `nativeLanguage` given in the request.
On persistence they become `item_translations` rows keyed by that language, never columns
on `learning_items` (ADR 0010). Do not mirror this shape into storage.

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

**Schema enforcement is at the decoder** (ADR 0005). vLLM guided decoding makes malformed
JSON structurally impossible rather than rejected after the fact — strictly stronger than
rule 3 requires. Rule 3 still governs *semantic* validity: a schema-valid response naming a
`senseId` that does not exist is rejected and retried, never repaired.

### Resource control (§38.10)

Local inference makes tokens free and **time** the scarce resource. The mechanisms are
unchanged; what they conserve is not.

- Deterministic processing runs first; only candidates that survive the validity gates are
  enriched (ADR 0008 — lazy enrichment, per candidate, never across the observed pool).
- Requests are batched where the schema allows. vLLM continuous batching is the throughput
  lever: submit a video's promoted candidates as one batch, not a loop of single calls.
- Prefix caching requires the stable system prompt and instruction block to come **first**;
  candidate, context, and dictionary senses go after.
- Results are cached by `(canonicalForm, senseContextHash, promptVersion, modelId)`.
- Generated examples are limited.
- Time per approved item and per retained item is tracked from the beginning, not added
  later (§31.3).
- Two ceilings are enforced via `uselimit` before enrichment starts: **100 candidates per
  video** (hard) and **45 minutes per job** (hard, resumable). A monthly 40-hour figure
  warns in diagnostics but does not pause — pausing a local job protects nothing.

### Degraded mode (§5.2)

P80 must remain useful with **no LLM configured**. Without a provider:

- Extraction, scoring, dictionary lookup, cards, review, and difficulty all work.
- Sense selection falls back to the manual UI built in Stage 6.
- The UI states that automatic disambiguation is unavailable — it does not silently
  degrade quality.

This is a standing test requirement, not a one-time check: the integration suite runs
once with a provider configured and once without.

Under local inference "no provider configured" is mostly "the vLLM server is not running",
which is a state that occurs naturally rather than one that has to be simulated — and
during Stages 1–6 it will be the common case. **This is a benefit, not a hazard:** the
degraded path gets exercised continuously instead of once in a test nobody reruns.

---

## 5. Slang policy (§16.5)

MVP: use dictionary evidence where it exists; allow LLM contextual explanation; label
unsupported slang explanations **unverified**; require human approval; run no autonomous
web search.

Post-MVP additions (approved web lookup with citations, regional usage tracking,
dated/offensive/reclaimed flags) are DEFERRED and are not to be started early.
