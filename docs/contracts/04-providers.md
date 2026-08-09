# 04 — Provider and Adapter Interfaces

Source: original spec §8 (media policy), §16 (dictionary and LLM), §7.1 (language scope).

Everything external to P80 sits behind one of four interfaces. No pipeline code calls a
provider SDK directly.

---

## 1. `MediaSourceAdapter`

<!-- RESOLVED (ADR 0015): spec §8 describes an embedded-YouTube media path and the
     acquisition prohibitions that follow from it. P80 no longer has that path. The unit is
     a local media file the user already holds, referenced and never copied. The spec is
     frozen and stays wrong here; this section is authoritative. -->

```ts
interface MediaSourceAdapter {
  readonly kind: MediaSourceKind;
  /** Whether this adapter reads bytes the user already holds. True for `local_media`. */
  readonly supportsLocalMedia: boolean;
  /** Whether P80 can obtain a transcript without the user supplying one. True since
   *  ADR 0016 — by transcribing the media locally, never by fetching one. */
  readonly supportsAutomaticTranscriptAccess: boolean;

  validate(input: MediaSourceInput): Promise<ValidationResult>;
  getMediaDescriptor(source: MediaSource): MediaDescriptor;
  parseTranscript(file: TranscriptInput): Promise<TranscriptParseResult>;
}

type MediaSourceKind =
  | "local_media"
  | "user_uploaded_transcript"
  | "licensed_corpus";         // DEFERRED

/** ADR 0015: replaces `EmbedDescriptor`. The client renders this rather than constructing
 *  a player from a path — the same rule as before, with a different player. */
interface MediaDescriptor {
  kind: "local_media";
  /** The API route that serves bytes, with Range support. Never a filesystem path: the
   *  client must not learn where media lives, and a path is not a URL. */
  mediaUrl: string;
  /** True when the referenced file is gone. The client shows a repair affordance and does
   *  not attempt playback (ADR 0018). */
  missing: boolean;
  startSeconds?: number;
  endSeconds?: number;
}

interface MediaSourceInput {
  /** User-supplied, therefore untrusted (rule 4 below). Resolved under `P80_MEDIA_ROOT`
   *  or rejected — never normalised into something acceptable. */
  path: string;
}

interface TranscriptParseResult {   // ADDED: the spec returns bare segments, which
  segments: TranscriptSegment[];    // leaves parse warnings nowhere to go, despite
  warnings: ParseWarning[];         // §14.2 requiring them to be recorded.
  format: "vtt" | "srt" | "pasted_timestamped" | "internal_json";
  parserVersion: string;
}

interface ParseWarning {
  kind: ParseWarningKind;           // ADR 0014: the list lives in `packages/core`
  segmentIndex: number | null;      // null for a whole-file anomaly
  message: string;                  // never contains transcript text
}
```

<!-- ADDED: not in original spec -->
**ADR 0014** amends `ParseWarning` in two ways. It adds an eighth kind,
`subtitle_boilerplate` — ADR 0013 §4 requires a countable, user-visible warning for
subtitle-distribution noise, and none of the original seven fits, because the cue is
well-formed and nothing was unparsed. And it moves the vocabulary to
`PARSE_WARNING_KINDS` in `packages/core/src/domain.ts`, beside every other contract enum,
because this is persisted to `transcript_files.parse_warnings_json` and so needs a runtime
value that can back a Zod schema, a severity map, and an exhaustiveness test.

```
overlapping_timestamps · out_of_order · missing_punctuation · malformed_line
unparsed_region · encoding_fallback · suspicious_duration · subtitle_boilerplate
low_asr_confidence · unaligned_words
```

<!-- ADDED: ADR 0016 -->
**ADR 0016 adds the last two, for the ASR path.** ADR 0013 took a list of
subtitle-boilerplate regexes from a sibling project and noted that the confidence checks
around them — no-speech probability, average log-probability, and a repeat-window check for
a stuck decoder — did *not* transfer, because user-supplied transcripts carry no such
signals. ASR output does, so they transfer now and report as `low_asr_confidence`.

`unaligned_words` covers the forced aligner failing to place a word in time. It is the one
warning that changes what downstream consumers can do rather than merely what they should
believe, because an unaligned word has no timestamp to build a clip from.

Both follow the existing rule: a warning never causes a row to be dropped. Whisper
fabricates fluent, correctly formatted speech over music and silence, and the answer to that
is a visible warning on a stored row, not a silent deletion.

Two rules govern what a warning may contain, both enforced by the collector's API rather
than by discipline:

- **A message never contains transcript text** — only kind names, indices, counts, line
  numbers, and pattern names. This column is persisted forever and re-served on every
  transcript read, which makes it a render surface even though nothing about it looks like
  one (`CLAUDE.md` rule 8).
- **Warnings are capped per kind**, with the suppressed count preserved. A three-thousand
  cue auto-caption file would otherwise turn an unbounded `TEXT` column into a stored
  amplification vector.

A warning never causes a cue to be dropped. §14.2 forbids discarding transcript content
silently, and a boilerplate match in particular is stored like any other row — ADR 0013
takes the pattern list and explicitly rejects the filter it came wrapped in.

MVP implements `local_media` and `user_uploaded_transcript` only.

### Provider independence

**The domain unit is a timed media source plus a transcript** — an `.mp4` or equivalent,
with an interval to play. `local_media` is the MVP implementation of that shape: a file the
user already holds, referenced by path, identified by content (ADR 0018). Nothing above
`MediaSourceAdapter` may assume a local file any more than it was allowed to assume a
YouTube id — paths, byte ranges, and container formats all live behind the interface.

The interface earned its keep once already: ADR 0015 removed the `youtube_embedded` adapter
by deleting it, not by refactoring the system around it. Two constraints on any future
adapter, recorded so they are not rediscovered:

- **The hard rules below govern acquisition, not playback surface.** They forbid P80 from
  *obtaining* media it was not given. A file the user already holds is not in that category,
  which is the entire basis of `local_media`.
- **DRM-protected services stay out of reach regardless of adapter design.** Provider
  independence means the interface does not preclude a provider; it does not make one
  possible where there is no lawful programmatic seek.

### Hard media rules (ADR 0015)

<!-- RESOLVED (ADR 0015): these replace spec §8 and §38.8's five rules, which were written
     against embedded YouTube. The prohibitions that had a subject were kept; the two that
     described the old playback surface were deleted along with it. -->

These are not negotiable and no ticket may relax them without a policy review recorded in
`docs/decisions/`:

1. **P80 never acquires media.** No downloader, no stream extraction, no URL that resolves
   to media bytes. How a file arrived on disk is outside the system.
2. **P80 makes no outbound request to obtain a transcript.** ASR is local (ADR 0016);
   upload is user-supplied. Neither path leaves the machine.
3. **P80 never copies media into its own storage.** It holds a reference and reads through
   it. The storage root holds transcripts and derived artifacts, never media.
4. **A media path is untrusted input.** It resolves under `P80_MEDIA_ROOT` or it is
   rejected — never sanitised into something acceptable.

The old rule 2, *never isolate or store an audio track*, is **deleted**. It existed to stop
stream extraction becoming an audio-download path by increments, and with user-supplied
local files it has no subject: the user holds the audio and decoding it is the whole of what
ASR does. Rule 3 is what now protects the storage directory, and unlike rule 2 it is
mechanically checkable. ADR 0015 records the cost of the deletion.

The old rule 5, *never claim frame-accurate playback*, is **deleted** because the condition
that required it is gone. Seeking a decoded local file is sample-accurate.

### Clip playback procedure (§19.1)

<!-- RESOLVED (ADR 0015): the spec's procedure is written around the IFrame player's
     ready/poll lifecycle and its keyframe-bounded seek. Steps 1-4 collapse against a
     `<video>` element, which seeks precisely and reports its own state. -->

1. Point the player at `MediaDescriptor.mediaUrl`; the byte range for the target interval is
   fetched on demand.
2. Seek to `startMs`. The seek is exact.
3. Pause at `endMs + postRoll`.
4. Let the user nudge the occurrence boundary and persist the adjustment.

Pre-roll and post-roll are user-configurable settings, not constants.

**This procedure is browser-only**, which is unchanged by ADR 0015 and is still why review
sessions and the video loop live in the web client while management surfaces live in the TUI
(ADR 0007). The reasoning never depended on the IFrame API: a terminal has no video surface.
`MediaRecorder` (§19.3–19.4) is browser-only for the same reason; voice is optional in MVP
(§21.5), so this does not block TUI coverage elsewhere.

For **navigation** from a client that cannot play media — "open this occurrence" from the
TUI — the mechanism is a deep link into the web client at a timestamp, not a media URL. The
TUI must not be handed a path to hand to an external player: that would put media access
outside the one route that enforces rule 4.

### Media serving

One route reads the filesystem for media: `GET /api/videos/:id/media` (`03-api.md` §3).

- It resolves `videos.media_path` under `P80_MEDIA_ROOT` and refuses anything outside, with
  the same prefix test `storage.ts` uses for transcripts.
- It supports HTTP Range, because `<video>` requires it to seek.
- It streams. Media files are gigabytes; nothing buffers a whole one.
- It produces no copy. A missing file is a 404 and sets `videos.media_missing`, never a
  cached duplicate.

---

## 1a. `AsrProvider` <!-- ADDED: ADR 0016 -->

```ts
interface AsrProvider {
  readonly name: string;
  /** Recorded on the transcript so it is attributable and recomputable across a model
   *  change — the same requirement §27.5 places on annotations. */
  readonly modelId: string;
  readonly alignmentModelId: string | null;

  transcribe(request: AsrRequest): Promise<AsrResult>;
}

interface AsrRequest {
  /** Absolute, already resolved under `P80_MEDIA_ROOT` by the caller. The provider does
   *  not re-derive it from user input. */
  mediaPath: string;
  /** Pinned from `profile.target_language`, never detected. A detected language that
   *  disagrees fails the job with both values named (ADR 0016 §3). */
  language: string;
}

interface AsrResult {
  /** Flat, in time order. THE source of truth (ADR 0017) — Whisper's own segment
   *  boundaries are discarded, because they come from the decoding window rather than
   *  from linguistics. */
  words: AsrWord[];
  detectedLanguage: string;
  languageProbability: number;
  /** Confidence anomalies, as warnings. Never a dropped word (§14.2). */
  warnings: ParseWarning[];
  durationMs: number;
}

interface AsrWord {
  text: string;
  startMs: number;
  endMs: number;
  /** Alignment confidence, 0..1. Null where the aligner could not place the word — a
   *  number that means "unknown" would be indistinguishable from a bad score. */
  confidence: number | null;
}
```

Failure behaviour, all three of which are cases where the system would otherwise report
success while being wrong (ADR 0016 §3):

- **A sidecar with no ASR model returns 501**, matching `/annotate`. It never degrades to an
  empty transcript.
- **It never falls back to CPU silently.** GPU configured and unavailable is a refusal
  naming which, not a job that runs twenty times slower and looks healthy.
- **A language mismatch is an error**, not a guess.

Degraded mode: with no ASR available, ingestion falls back to the user-supplied upload path
and says so. This is a standing test requirement, like §5.2's no-LLM case — the suite runs
once with ASR available and once without.

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

<!-- ADDED: ADR 0016 -->
The sidecar also serves `POST /transcribe` (§1a). Same process for the same reason — Python
only where the models are — but with one property the annotation endpoints do not have: an
ASR call holds the process for minutes, while `annotate` is called per sentence. Once
extraction runs concurrently with ingestion, transcription needs its own process or the
endpoint needs a queue. ADR 0016 records this as the condition that reverses the placement.

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
