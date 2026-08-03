# P80 Language Learning Platform

## Complete MVP Product, Learning, and Engineering Specification

**Document status:** Build specification
**Product stage:** Pre-implementation
**Application form:** Minimal local web application
**Primary user:** Independent language learner
**Verified external constraints:** August 3, 2026

---

# 1. Executive summary

P80 is a local-first language-learning application that converts videos selected by a learner into a personalized curriculum of useful words, multiword expressions, and grammatical constructions.

The application is designed around a central hypothesis:

> Learners will retain and use interest-specific language more efficiently when vocabulary retrieval is connected to the original audiovisual context, prioritized by personal relevance and linguistic usefulness, and later tested in new contexts.

The core product loop is:

1. The user adds a video and an authorized or user-supplied transcript.
2. P80 segments the transcript and identifies candidate learning items.
3. Dictionaries, language-processing tools, and an LLM enrich those candidates.
4. Low-quality, redundant, overly obscure, or inappropriate candidates are filtered.
5. The user approves or rejects the remaining candidates.
6. P80 introduces a small number of high-value items.
7. Each skill is reviewed separately through listening recognition, contextual completion, and productive recall.
8. The learner returns to the original source clip after retrieval.
9. P80 later tests the item in a different context.
10. Review results update the learner model, item schedule, video difficulty estimate, and source recommendations.

P80 is not intended to extract every possible word from a video. It is intended to create the **smallest high-value curriculum** that helps a learner understand and discuss subjects they care about.

---

# 2. Problem statement

General-purpose language-learning applications prioritize broadly useful beginner vocabulary and scripted scenarios. They rarely provide deep coverage of the learner’s personal interests, academic field, profession, or hobbies.

Traditional sentence-mining systems partially solve this problem, but they often require significant manual work and commonly produce several weaknesses:

* Too many cards
* Duplicate or overlapping cards
* Unreliable machine-generated definitions
* Words presented without their original pronunciation
* Recognition practice without productive recall
* Vocabulary learned in only one source context
* No estimate of whether a source is appropriate for the learner
* Review queues dominated by rare or low-value expressions
* No systematic connection between review performance and future content

P80 addresses these weaknesses by combining:

* User-selected audiovisual content
* Source-linked playback
* Dictionary-grounded explanations
* Automatic candidate generation
* Human approval
* Learner-specific item ranking
* Spaced retrieval
* Listening and production practice
* Contextual transfer
* Video-level difficulty estimation
* Struggle-driven source recommendations

---

# 3. Product thesis

P80 should not be defined as:

> An application that automatically makes flashcards from YouTube videos.

It should be defined as:

> A personalized language-learning system that turns user-selected audiovisual material into a small curriculum of verified words, expressions, and constructions, then trains recognition, production, and contextual transfer while reconnecting each item to its original source.

The distinction matters. Automatic card generation is a feature. The product’s actual value is the instructional loop built around those cards.

---

# 4. Learning-science foundation

P80’s product behavior should reflect four complementary forms of language practice:

1. **Meaning-focused input:** understanding videos and transcript passages.
2. **Meaning-focused output:** summarizing, responding, and constructing messages.
3. **Language-focused learning:** deliberately studying vocabulary, expressions, pronunciation, and grammar.
4. **Fluency development:** repeating familiar tasks until retrieval becomes faster and more automatic.

This balance follows Nation’s Four Strands framework.

P80 should also follow these principles.

## 4.1 Retrieval before restudy

The learner should attempt to retrieve an answer before seeing it. Reading a definition or repeatedly replaying a phrase is exposure, not a retrieval rep.

Testing and retrieval practice improve later retention more effectively than repeated restudy in many learning conditions.

## 4.2 Spacing rather than cramming

Reviews should be distributed over increasing intervals. Failed items may reappear later in the same session, but not immediately after the answer is revealed.

Distributed practice has a strong general memory advantage over massed practice.

## 4.3 Comprehensible source material

P80 should estimate how much of a video’s language the learner is likely to know.

Lexical coverage does not guarantee comprehension, but comprehension generally falls as the proportion of unknown words increases. Research on short audiovisual material found stronger comprehension at higher coverage and identified approximately 95% as an effective target for adequate comprehension in the studied conditions.

The application should treat coverage thresholds as product heuristics, not universal scientific laws.

Recommended labels:

* **95% or higher:** productive
* **90–95%:** stretch
* **85–90%:** heavily scaffolded
* **Below 85%:** usually too difficult for the standard loop

## 4.4 Multiword expressions as first-class items

P80 should teach expressions and constructions such as:

* “run into someone”
* “it turns out that”
* “as far as I know”
* “be responsible for”
* “the reason why”
* `for + duration`

These often carry more communicative value than isolated translations. Research supports a relationship between multiword-sequence knowledge, processing, and perceived fluency, although the size and exact mechanism vary.

## 4.5 Contextual diversity

Ten appearances in one video are not equivalent to appearances across several speakers and contexts.

P80 should represent:

* Raw occurrence frequency
* Number of distinct videos
* Number of distinct speakers, when known
* Number of semantic contexts
* Number of interest domains

Contextual diversity can contribute information beyond raw frequency in vocabulary learning and lexical production.

## 4.6 Separate recognition from production

Knowing what an item means when heard is not the same as producing it during a conversation.

P80 should maintain separate states for:

* Audio recognition
* Written recognition
* Contextual completion
* Productive recall
* Pronunciation practice
* Contextual use

## 4.7 Repetition with changed conditions

Repetition should progress from:

1. Original source
2. Original source without support
3. Similar sentence
4. Different speaker or video
5. Personal use
6. Short communicative task

Task repetition can support fluency, but endless immediate repetition of the same material can produce short-term performance gains without equivalent delayed transfer.

## 4.8 Focused pronunciation feedback

Automatic speech recognition may be useful, but generic transcription success is not a reliable full measure of pronunciation.

Research suggests ASR-supported pronunciation practice can be beneficial, particularly when it provides explicit rather than merely indirect feedback.

Automated pronunciation grading is therefore deferred from the MVP. The first release will support recording, playback, comparison, and self-evaluation.

---

# 5. Goals

## 5.1 Primary goals

The MVP must allow a learner to:

1. Create a local language-learning profile.
2. Define a native language, target language, approximate proficiency, and interests.
3. Add a YouTube video through a URL.
4. Attach a timestamped transcript through VTT, SRT, or pasted timestamped text.
5. View the video through an embedded YouTube player.
6. Extract potential learning items from the transcript.
7. Review candidate definitions, source occurrences, register, and confidence.
8. Approve, reject, merge, or edit candidates.
9. Introduce a limited number of new items per day.
10. Review items through several retrieval modes.
11. Replay the original source segment during review.
12. Maintain independent schedules for different skills.
13. Estimate source difficulty for the current learner.
14. Recommend source clips and videos when the learner repeatedly struggles.
15. Display delayed retention, listening recognition, review burden, and transfer metrics.

## 5.2 Secondary goals

The MVP should:

* Be usable without cloud deployment.
* Store all application data locally.
* Support configurable external LLM and dictionary providers.
* Remain useful when no LLM provider is configured.
* Preserve provenance for every machine-generated explanation.
* Support one carefully implemented target language before adding more.
* Make extraction and ranking decisions inspectable.
* Export learner data and review history.

---

# 6. Non-goals

The following are explicitly outside the first MVP:

* Downloading arbitrary YouTube videos
* Downloading or isolating YouTube audio
* Automatically downloading arbitrary public YouTube transcripts
* Automated YouTube search and recommendation
* Full multilingual support
* Automatic pronunciation pass/fail grading
* Fully autonomous web research for slang
* Unrestricted AI conversation
* AI-generated full lesson plans
* Social features
* Cloud synchronization
* Mobile applications
* Accounts or multi-user authentication
* Teacher dashboards
* Gamified leaderboards
* Streak-based coercive engagement
* Fully automatic candidate approval
* One-number fluency scoring
* Certification or CEFR-level claims
* Native-like accent scoring

---

# 7. MVP constraints

## 7.1 One target language first

The production MVP should support:

* One native language
* One target language
* One primary tokenizer and lemmatizer
* One frequency-data source
* One dictionary provider
* One set of language-specific extraction rules

The code should expose interfaces for additional languages, but multilingual behavior should not be claimed until each language has appropriate:

* Sentence segmentation
* Tokenization
* Lemmatization
* Part-of-speech tagging
* Function-word rules
* Frequency data
* Dictionary integration
* Expression extraction
* Orthographic normalization
* Speech-recognition behavior

## 7.2 Local-first operation

The application must:

* Bind to `localhost` by default.
* Use a local SQLite database.
* Store uploaded transcript files locally.
* Store API keys in environment configuration, not the database.
* Avoid requiring user authentication.
* Avoid remote analytics by default.
* Clearly identify every external request.

## 7.3 Human approval

No automatically extracted item should enter the active learning queue without either:

* Explicit user approval, or
* A future configurable automatic-approval rule that remains disabled in the MVP.

---

# 8. YouTube and media-source policy

P80 must not build its core architecture around downloading arbitrary YouTube media or captions.

Current YouTube developer guidance prohibits enabling users to download videos for offline playback outside the permitted YouTube experience and prohibits offering separated audio tracks or modified audio/video portions.

The official caption-download endpoint can return a forbidden response when the requesting user lacks sufficient permission for the caption track. It should not be treated as a universal transcript downloader.

The YouTube IFrame Player API supports timestamped playback through `startSeconds` and `endSeconds`, although playback begins at the closest keyframe rather than guaranteeing sample-level precision.

## 8.1 Allowed MVP source flow

For a YouTube source:

1. User provides a YouTube URL.
2. P80 extracts and stores the video ID.
3. User uploads a VTT or SRT transcript, or pastes timestamped transcript text.
4. P80 stores transcript timestamps and textual content.
5. During review, P80 uses the embedded YouTube player to play the relevant interval.
6. P80 does not save a local audio or video copy.

## 8.2 Optional authorized flow

A later version may allow the user to authenticate and retrieve captions for videos they own or are authorized to manage.

This flow requires:

* OAuth
* Scope review
* Permission handling
* Token storage
* Revocation
* Policy review
* Explicit error handling for insufficient permissions

It is not required for MVP validation.

## 8.3 Additional media adapters

The source system must use an adapter interface:

```ts
interface MediaSourceAdapter {
  validate(input: MediaSourceInput): Promise<ValidationResult>;
  getEmbedDescriptor(source: MediaSource): EmbedDescriptor;
  parseTranscript(file: TranscriptInput): Promise<TranscriptSegment[]>;
  supportsLocalMedia: boolean;
  supportsAutomaticTranscriptAccess: boolean;
}
```

Planned adapters:

* `youtube_embedded`
* `local_media`
* `user_uploaded_transcript`
* `licensed_corpus`
* `authorized_youtube_owner`

The MVP implements:

* `youtube_embedded`
* `user_uploaded_transcript`

---

# 9. Core terminology

## 9.1 Source

A video, audio recording, or transcript from which language is extracted.

## 9.2 Transcript segment

A timestamped block of transcript text.

## 9.3 Sentence

A complete utterance or syntactically complete transcript unit.

A subtitle line is not automatically a sentence. Several subtitle lines may form one sentence.

## 9.4 Learning item

The canonical object representing something the learner may study.

Types:

* Single lexical word
* Multiword expression
* Grammatical or lexical construction

## 9.5 Surface form

A form that appears in a source.

Example:

```text
Canonical item: run into someone
Surface forms:
- ran into him
- keep running into
- might run into her
```

## 9.6 Occurrence

One appearance of an item in a source, including:

* Transcript segment
* Start timestamp
* End timestamp
* Sentence context
* Surface form
* Extraction confidence

## 9.7 Candidate

A proposed learning item that has not yet been approved.

## 9.8 Card

A particular retrieval task generated from a learning item.

## 9.9 Rep

One retrieval attempt made before the answer is revealed.

## 9.10 Successful rep

A retrieval attempt that meets the card’s success criteria.

## 9.11 Set

A group of related reps followed by feedback, transition, or rest.

## 9.12 Transfer rep

A retrieval attempt in a context different from the original source occurrence.

---

# 10. Information architecture

The local web application will contain seven primary sections.

## 10.1 Today

The default dashboard.

Displays:

* Due reviews
* New-item allowance
* Recommended video loop
* Current struggling items
* Estimated session length
* Seven-day retention
* Review burden
* Recent source additions

Primary action:

> Start today’s session

## 10.2 Review

The focused card-review interface.

Supports:

* Audio or source-clip recognition
* Contextual cloze
* Productive recall
* Error repair
* Recording and playback
* Manual rating
* Answer inspection
* Source expansion

## 10.3 Videos

Displays:

* Added videos
* Processing state
* Transcript state
* Number of candidates
* Number of approved items
* Words contributed
* Expressions contributed
* Constructions contributed
* Estimated known-word coverage
* Difficulty label
* Learner performance
* Number of current struggle items
* Last watched date

## 10.4 Video detail

Displays:

* Embedded player
* Transcript synchronized to playback
* Candidate highlights
* Approved-item highlights
* Timeline markers
* Source statistics
* Difficulty dimensions
* Extracted items
* Review performance
* Rewatch actions
* Transcript corrections

## 10.5 Candidate inbox

Displays proposed items requiring a decision.

Actions:

* Approve
* Reject
* Edit
* Merge
* Mark known
* Mark important
* Change item type
* Change canonical form
* Change sense
* Change register
* Correct timestamps
* Defer

## 10.6 Items

Searchable item library.

Filters:

* Learning state
* Skill state
* Source
* Interest
* Item type
* Frequency band
* Register
* Difficulty
* Struggle status
* Suspended status

## 10.7 Settings and diagnostics

Contains:

* Language profile
* Interests
* New-item limit
* Review-session limit
* LLM provider
* Dictionary provider
* Frequency data source
* Data export
* Data deletion
* Job queue
* Failed jobs
* Provider usage
* Prompt and output inspection
* Database maintenance

---

# 11. Onboarding flow

## 11.1 Profile creation

Collect:

* Native language
* Target language
* Approximate proficiency
* Learning purpose
* Interests or fields
* Daily session target
* Desired new-item limit

Suggested purpose options:

* Conversation
* Academic study
* Professional field
* Travel
* Media comprehension
* Personal interest

## 11.2 Initial knowledge estimate

The MVP should use one of two modes.

### Fast mode

The user selects:

* Beginner
* Lower intermediate
* Intermediate
* Upper intermediate
* Advanced

This initializes a rough known-frequency threshold.

### Calibrated mode

Present a frequency-stratified sample:

* 10 very-high-frequency items
* 10 high-frequency items
* 10 medium-frequency items
* 10 lower-frequency items
* 10 domain-specific items, when available

For each item:

* Know
* Unsure
* Do not know

The result initializes `P(known)` by frequency band.

This placement result is only a starting estimate. Review data should quickly override it.

## 11.3 Interest setup

The user may add free-form interests such as:

* Distributed systems
* Football
* Fashion
* Philosophy
* Biology
* Cooking
* Film production
* Finance
* Gaming

Interests receive a weight from 1 to 5.

Each source may be tagged with one or more interests.

---

# 12. Principal user flows

## 12.1 Add video

1. User opens Videos.
2. User selects Add video.
3. User pastes a YouTube URL.
4. Application validates and extracts the video ID.
5. User enters or confirms:

   * Title
   * Target language
   * Interest tags
   * Speaker or region, when known
6. User uploads VTT or SRT, or pastes timestamped text.
7. Application previews parsed transcript segments.
8. User confirms transcript.
9. Ingestion job begins.
10. Video appears with processing status.
11. Extraction results enter Candidate inbox.
12. User is notified inside the application when processing completes.

## 12.2 Approve candidates

1. User opens Candidate inbox.
2. Candidate displays:

   * Canonical form
   * Item type
   * Source sentence
   * Source playback
   * Proposed meaning
   * Dictionary provenance
   * Natural translation
   * Register
   * General frequency
   * Source frequency
   * Contextual diversity
   * Priority score
   * Confidence
3. User approves, edits, rejects, merges, or marks known.
4. Approved item enters the future new-item queue.
5. It does not necessarily become active immediately.

## 12.3 Daily learning session

1. User opens Today.
2. P80 calculates due-card count and review burden.
3. The session starts with due reviews.
4. Failed cards reappear only after intervening cards.
5. P80 introduces a limited number of new items.
6. The learner completes a short video loop.
7. The learner completes transfer reps.
8. The learner repairs up to three recurring errors.
9. Session summary appears.

## 12.4 Struggle remediation

1. Learner repeatedly fails a card.
2. P80 determines the likely failure type.
3. It presents a targeted intervention:

   * Meaning clarification
   * Slower context inspection
   * Transcript support
   * Construction frame
   * Different occurrence
4. Continued failure raises the item’s struggle score.
5. The related source video receives a recommendation boost.
6. The learner may rewatch a short source context or the full appropriate video.

---

# 13. Learning-item model

The central entity is `LearningItem`.

```ts
type LearningItemType =
  | "word"
  | "multiword_expression"
  | "construction";

interface LearningItem {
  id: string;
  targetLanguage: string;
  canonicalForm: string;
  normalizedForm: string;
  lemma: string | null;
  itemType: LearningItemType;
  senseKey: string;
  partOfSpeech: string | null;
  meaning: string;
  naturalTranslation: string | null;
  literalTranslation: string | null;
  register: Register;
  dialectRegion: string | null;
  offensiveOrSensitive: boolean;
  generalFrequencyRank: number | null;
  domainFrequencyScore: number;
  contextualDiversityScore: number;
  reusePotentialScore: number;
  extractionConfidence: number;
  definitionConfidence: number;
  status: ItemStatus;
  createdAt: Date;
  updatedAt: Date;
}
```

## 13.1 Item identity

Two occurrences belong to the same item only when they share:

* Target language
* Canonical form or canonical construction
* Intended sense
* Item type

Homonyms with different meanings must be separate items.

Example:

```text
bank: financial institution
bank: side of a river
```

## 13.2 Item forms

Store all observed forms independently:

```ts
interface ItemForm {
  id: string;
  itemId: string;
  surfaceForm: string;
  normalizedForm: string;
  grammaticalFeatures: Record<string, string>;
  occurrenceCount: number;
}
```

## 13.3 Item occurrences

```ts
interface ItemOccurrence {
  id: string;
  itemId: string;
  videoId: string;
  transcriptSegmentId: string;
  startMs: number;
  endMs: number;
  surfaceForm: string;
  sentenceText: string;
  precedingText: string | null;
  followingText: string | null;
  extractionConfidence: number;
  isPrimaryOccurrence: boolean;
}
```

---

# 14. Candidate extraction pipeline

Each video ingestion job follows an inspectable sequence.

## 14.1 Step 1: Input validation

Validate:

* Supported source
* Valid video ID
* Transcript file type
* Transcript encoding
* Timestamp ordering
* Nonnegative durations
* Target-language consistency
* Duplicate upload
* Transcript length limits

## 14.2 Step 2: Transcript parsing

Supported formats:

* WebVTT
* SRT
* Pasted timestamped text
* Internal JSON transcript format

Parser responsibilities:

* Normalize timestamps
* Remove formatting tags
* Preserve speaker labels
* Preserve punctuation
* Merge malformed lines when possible
* Record parsing warnings
* Never silently discard large transcript regions

## 14.3 Step 3: Sentence reconstruction

Subtitle segments may split sentences arbitrarily.

P80 should reconstruct utterances using:

* Punctuation
* Time gaps
* Capitalization
* Speaker changes
* Language-specific sentence boundary rules
* Maximum sentence duration
* Maximum token count

Every reconstructed sentence must retain links to its underlying transcript segments and timestamp range.

## 14.4 Step 4: Linguistic annotation

For every sentence:

* Tokenize
* Lemmatize
* Tag parts of speech
* Identify named entities
* Identify morphological features
* Estimate sentence complexity
* Detect probable language mismatch

## 14.5 Step 5: Word candidates

Create preliminary candidates for content words.

Suppress by default:

* Punctuation
* Pure numerals
* URLs
* Isolated named entities
* Obvious transcription artifacts
* Very common function words
* Tokens below confidence thresholds
* Foreign-language insertions outside the target language

Do not permanently remove function words from context.

## 14.6 Step 6: Multiword-expression candidates

Generate candidates from:

* Repeated n-grams
* Verb-particle combinations
* Verb-preposition combinations
* Collocations
* Idioms
* Discourse markers
* Formulaic sequences
* Common conversational frames
* LLM-proposed semantic units
* Dictionary-listed expressions
* Language-specific part-of-speech patterns

Recommended length:

* Usually 2–6 tokens
* Longer only when the expression has clear independent communicative value

A phrase candidate must be one of:

* Semantically noncompositional
* Conventionally associated
* Grammatically constrained
* Highly reusable
* Pragmatically meaningful
* Important to the user’s domain

## 14.7 Step 7: Construction candidates

Examples:

* `used to + verb`
* `the reason why + clause`
* `for + duration`
* `not only X but also Y`
* `be responsible for + noun`
* A target-language-specific tense or case frame

A construction should have:

* A canonical pattern
* At least one fixed component
* At least one variable slot
* A short functional explanation
* One or more source realizations

## 14.8 Step 8: Candidate consolidation

Consolidate:

* Inflected forms
* Capitalization variants
* Punctuation variants
* Minor subtitle differences
* Repeated occurrences
* Already known items
* Existing approved items

Do not merge distinct senses.

## 14.9 Step 9: Definition enrichment

For each candidate:

1. Query dictionary provider.
2. Retrieve possible senses.
3. Supply source context and dictionary senses to the LLM.
4. Ask the LLM to select the most plausible attested sense.
5. Generate a learner-appropriate explanation.
6. Identify register, region, tone, and sensitivity.
7. Record the evidence and confidence.
8. Mark generated examples as generated.

The LLM is an explainer and disambiguator, not the primary lexical authority.

## 14.10 Step 10: Quality gates

Reject or quarantine a candidate when:

* Transcript confidence is too low.
* Definition confidence is too low.
* No plausible meaning matches the context.
* The item duplicates an existing sense.
* The candidate is a proper name without domain value.
* The sentence is unusably long.
* The context does not clarify meaning.
* The candidate is a transcription error.
* It is an ordinary compositional phrase with little reuse value.
* It contains unresolved sensitive or offensive content.
* Its language does not match the profile.

## 14.11 Step 11: Initial learner estimate

Calculate:

```text
P_unknown = 1 - P_known
```

Initial `P_known` uses:

* Placement result
* Frequency band
* Cognate status, when supported
* User-marked known items
* Related known forms
* Existing review history

## 14.12 Step 12: Candidate priority

Normalize each feature to a value from 0 to 1.

```text
priority =
    0.25 × learner_need
  + 0.20 × domain_relevance
  + 0.15 × general_frequency_utility
  + 0.15 × contextual_diversity
  + 0.10 × phrase_or_construction_value
  + 0.10 × reuse_potential
  + 0.05 × source_salience
  - quality_penalties
```

Where:

### Learner need

```text
learner_need = 1 - P_known
```

### Domain relevance

Based on:

* Occurrences in interest-tagged videos
* Weight of those interests
* User starring or saving an item
* Usefulness within the selected field

Use logarithmic occurrence scaling so one repetitive video cannot dominate.

### General frequency utility

Higher-frequency language receives more value, but:

* Function words are handled separately.
* Extremely common already-known items receive little value through `learner_need`.
* Rare domain terms can still score highly through `domain_relevance`.

### Contextual diversity

Based on:

* Distinct videos
* Distinct sentences
* Distinct speakers, when known
* Distinct interest categories
* Distinct grammatical surroundings

### Phrase or construction value

Higher for:

* Conventional multiword expressions
* Verb-preposition frames
* Reusable sentence frames
* Discourse markers
* High-value constructions

### Reuse potential

Estimated from:

* Breadth of compatible contexts
* Productivity of construction slots
* Corpus or dictionary evidence
* LLM classification with inspectable rationale

### Source salience

Raised when:

* User bookmarked the timestamp
* User manually selected the expression
* User replayed the segment repeatedly
* User marked the source as important

### Quality penalties

Applied for:

* Weak transcript alignment
* Definition uncertainty
* Excessive length
* Named-entity behavior
* Duplicate likelihood
* Narrowness
* Offensive ambiguity
* Unclear phrase boundary

## 14.13 Admission versus scheduling

The priority score determines:

> Should this item enter the learner’s curriculum, and how soon?

It must not determine:

> When should an already active card be reviewed?

Review scheduling is based on memory performance.

---

# 15. Function-word policy

P80 must not globally hide words such as “and,” “for,” “to,” or their equivalents.

Instead, use three outcomes.

## 15.1 Suppress as isolated item

Examples:

```text
and → translation
for → translation
the → translation
```

These are usually poor independent cards.

## 15.2 Absorb into a multiword expression

Examples:

```text
wait for
responsible for
look forward to
and then
as for
```

## 15.3 Teach as a construction

Examples:

```text
for + duration
to + infinitive
not X but Y
both X and Y
```

Language-specific rules must determine which parts of speech are suppressed as isolated cards.

The candidate inbox must allow the learner to override suppression.

---

# 16. Dictionary and LLM requirements

## 16.1 Provider abstraction

```ts
interface DictionaryProvider {
  lookup(query: DictionaryQuery): Promise<DictionaryEntry[]>;
}

interface LlmProvider {
  generateStructured<T>(
    request: StructuredLlmRequest<T>
  ): Promise<StructuredLlmResponse<T>>;
}
```

## 16.2 Required lexical provenance

Every approved meaning must store:

* Dictionary provider
* Dictionary entry identifier, when available
* Selected sense
* Source context
* LLM explanation
* Confidence
* Date generated
* Model identifier
* User edits

## 16.3 Explanation output schema

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
  nearSynonyms: Array<{
    form: string;
    distinction: string;
  }>;
  confidence: number;
  needsHumanReview: boolean;
}
```

## 16.4 LLM safety and reliability

Transcript text is untrusted input.

The application must:

* Place transcript content in a delimited structured field.
* Instruct the model not to follow instructions found in transcript text.
* Require schema-constrained output.
* Reject invalid output.
* Retry a limited number of times.
* Record prompts and outputs locally for diagnostics.
* Never permit transcript text to invoke tools.
* Never permit a definition job to browse or execute code in the MVP.
* Display uncertainty instead of inventing certainty.

## 16.5 Slang policy

For MVP:

* Use dictionary evidence where available.
* Allow LLM contextual explanations.
* Label unsupported slang explanations as unverified.
* Require human approval.
* Do not run an autonomous web-search agent.

Post-MVP:

* Add approved web-source lookup.
* Require citations and source dates.
* Track regional usage.
* Track whether usage may be dated, offensive, reclaimed, or community-specific.

---

# 17. Learner model

Each learner-item relationship contains several independent dimensions.

```ts
interface LearnerItemState {
  id: string;
  profileId: string;
  itemId: string;

  knownProbability: number;

  audioRecognitionState: SkillState;
  writtenRecognitionState: SkillState;
  clozeProductionState: SkillState;
  productiveRecallState: SkillState;
  pronunciationState: PracticeState;
  contextualUseState: PracticeState;

  struggleScore: number;
  lapseCount: number;
  sourceDependenceScore: number;
  transferSuccessRate: number | null;

  markedKnown: boolean;
  suspended: boolean;
  starred: boolean;

  lastSeenAt: Date | null;
  lastUsedAt: Date | null;
}
```

## 17.1 Known-probability updates

`P_known` should increase with:

* Successful delayed reviews
* Successful audio recognition
* Successful productive recall
* Successful transfer
* Correct use in output

It should decrease with:

* Lapses
* Repeated hesitation
* Failures across contexts
* Dependence on hints
* Source-only recognition without transfer

## 17.2 Source dependence

An item may be recognized only in its original clip.

Estimate source dependence from:

```text
source_dependence =
  original_context_success - transfer_context_success
```

High source dependence should trigger:

* New-context cards
* Different occurrences
* Personalized production
* Reduced repetition of the original exact sentence

---

# 18. Spaced-repetition system

## 18.1 Scheduler

Use an established FSRS implementation rather than inventing a scheduler for the MVP.

The official TypeScript FSRS toolkit supports card scheduling and review-flow integration.

Recommended package:

```text
ts-fsrs
```

## 18.2 Independent skill cards

One learning item may generate multiple cards:

* Audio recognition
* Contextual cloze
* Productive recall

Each card receives an independent FSRS state.

Do not average all skill performance into one schedule.

## 18.3 MVP card-generation rules

For each approved item:

### Word

Generate:

* Audio recognition
* Productive recall

Generate contextual cloze when the word has a useful source sentence.

### Multiword expression

Generate:

* Audio recognition
* Contextual cloze
* Productive recall

### Construction

Generate:

* Contextual cloze
* Productive recall

Audio recognition is optional when the source realization is clear and reusable.

## 18.4 Sibling handling

Cards from the same item should not appear consecutively.

Rules:

* Bury sibling cards until later in the session.
* Prefer different days for new sibling cards.
* Never show the translation-production card immediately after revealing the same answer in an audio-recognition card.
* Require at least five intervening cards during same-session relearning.

## 18.5 Rating model

Use four scheduler ratings:

### Again

* Incorrect
* No answer
* Meaning changed
* Target item not recognized
* Production unusable

### Hard

* Correct after a hint
* Correct with substantial hesitation
* Partially correct
* Serious form error but meaning preserved

### Good

* Correct independently
* Meaning and form acceptable
* Normal hesitation

### Easy

* Immediate
* Confident
* Natural
* Correct in a changed context

## 18.6 Automatic and manual grading

The MVP should never rely solely on automatic semantic grading.

Use:

* Structured answer checks where possible
* Optional LLM suggestion
* User self-rating after answer reveal
* Audit trail of any machine recommendation

For productive answers, the application may classify:

* Correct and uses target
* Correct but avoids target
* Understandable with an error
* Meaning changed
* No usable response

The learner makes the final scheduler rating.

## 18.7 New-item allowance

Default:

```text
10 new learning items per day
```

Adaptive rules:

* Reduce to 5 when due-card burden is high.
* Reduce to 0 when seven-day retention falls below target.
* Reduce when the candidate-quality rejection rate is high.
* Increase only after stable retention and manageable review time.
* Hard maximum for MVP: 20 items per day.

## 18.8 Review burden

Calculate:

```text
review_burden =
  estimated_due_minutes_next_7_days
  + overdue_minutes
```

When burden exceeds the configured session budget:

1. Stop introducing new items.
2. Prioritize overdue and lapse-prone cards.
3. Avoid showing low-value siblings.
4. Offer suspension of consistently low-value items.

---

# 19. Card specifications

Each card must have exactly one primary retrieval objective.

## 19.1 Audio/source-clip recognition

### Objective

Recognize an item in continuous speech.

### Front

* Miniature embedded YouTube player
* Playback begins shortly before the item
* Transcript hidden
* Video may remain visible to comply with embedded playback behavior

Prompt:

> What does the speaker mean?

### User response

* Typed meaning, optional
* Mental answer permitted
* Reveal answer button

### Back

* Transcript
* Highlighted item
* Short meaning
* Natural translation
* Wider sentence
* Replay
* Expand context
* Source video link
* Rating controls

### Implementation detail

Store:

* `startMs`
* `endMs`
* Configurable pre-roll
* Configurable post-roll

Because YouTube starts near a keyframe, P80 should:

1. Load the embedded video near the interval.
2. Seek to the target start when ready.
3. Monitor current playback time.
4. Pause at the configured end.
5. Let the user manually adjust the occurrence boundary.

Do not claim frame-perfect playback.

## 19.2 Contextual cloze

### Objective

Retrieve a form from its grammatical or lexical context.

### Front

```text
I didn't expect to ____ him here.
```

Optional source playback may be available after the first attempt.

### Back

```text
run into
```

Display:

* Full source sentence
* Why the form fits
* Common alternatives
* Original timestamp
* Rating controls

## 19.3 Productive recall

### Objective

Produce the target expression from a meaning, intent, or situation.

### Front

```text
Situation:
You unexpectedly met your professor downtown.

Use the target expression.
```

### Input

* Text response
* Voice recording
* Either or both

### Back

```text
I ran into my professor downtown.
```

Display:

* One possible answer
* Other acceptable responses
* Whether the learner used the target item
* Important correction
* Rating controls

Do not present the example as the only correct sentence.

## 19.4 Pronunciation imitation

This is a practice exercise, not an automatically scheduled pass/fail card in MVP.

### Sequence

1. Play source.
2. Record learner.
3. Replay source.
4. Replay learner.
5. Show transcript and stress cue.
6. Learner attempts again.
7. Learner self-rates:

   * Understandable
   * Uncertain
   * Needs work

Maximum:

```text
3 attempts per practice set
```

Do not save recordings by default.

## 19.5 Transfer card

### Objective

Test whether the item can be recognized or used outside the original sentence.

Possible fronts:

* Different occurrence from another added video
* Generated but clearly labeled sentence
* Personalized situation
* New cloze context

Transfer cards should not be introduced before initial meaning acquisition.

---

# 20. Daily learning protocol inside P80

Default session length:

```text
35–45 minutes
```

## Set 1: Due reviews

Target:

```text
15 minutes
25–40 reps
```

Rules:

* One objective per card
* Immediate answer feedback
* No consecutive sibling cards
* Failed cards return after intervening cards
* Due items take precedence over new items

## Set 2: New items

Target:

```text
10 minutes
2 sets × 5 items
2 successful retrieval reps per item
```

Sequence for each item:

1. Inspect source occurrence.
2. Understand meaning.
3. Hide answer.
4. Retrieve.
5. Check.
6. Review intervening items.
7. Retrieve again.

## Set 3: Video loop

Target:

```text
10 minutes
```

Sequence:

1. Watch a short clip without transcript support.
2. State or select the main idea.
3. Watch with target-language transcript.
4. Inspect up to five target items.
5. Rewatch without transcript.
6. Give a short summary.

## Set 4: Productive transfer

Target:

```text
5 minutes
5 reps
```

Requirements:

* Changed context
* No direct copying of source sentence
* Prefer currently active high-value expressions

## Set 5: Error repair

Target:

```text
5 minutes
Maximum 3 errors
```

For each error:

1. Produce corrected original.
2. Produce one changed example.
3. Say or type one personal example.

---

# 21. Video learning loop

A video should remain an instructional object after extraction.

## 21.1 First comprehension rep

* Watch selected clip without native-language subtitles.
* Do not pause.
* State or select the main idea.

## 21.2 Supported viewing rep

* Watch with target-language transcript.
* Highlight no more than five high-value unknown items.
* Inspect source-grounded explanations.

## 21.3 Retrieval set

```text
2 sets × 5 items
```

For each:

* Retrieve meaning or form.
* Receive feedback.
* Repeat after intervening items.

## 21.4 Unsupported rewatch

* Hide transcript.
* Replay clip.
* Record whether previously unclear regions became understandable.

## 21.5 Output reps

```text
2 reps
```

Rep 1:

* Give a 60–90-second summary.

Rep 2:

* Repeat while using three target items.

Voice recording is optional in MVP.

## 21.6 Transfer rep

After an interval:

* Present the same item in a new context.
* Do not reuse the exact source sentence.
* Track transfer separately from source recognition.

---

# 22. Video difficulty model

Do not calculate difficulty solely from failures on extracted cards.

## 22.1 Lexical difficulty

Estimate:

```text
known_tokens / eligible_tokens
```

Eligible tokens exclude:

* Punctuation
* Proper names
* Pure numerals
* Non-target-language tokens
* Transcript artifacts

Display:

* Estimated known coverage
* Unknown high-value items
* Unknown total lexical items
* Frequency distribution

## 22.2 Phraseological difficulty

Estimate from:

* Unknown multiword expressions
* Unknown constructions
* Dense idiomatic sections
* Expressions per minute

## 22.3 Syntactic difficulty

Estimate from:

* Mean sentence length
* Clause density
* Dependency depth, when available
* Unusual construction count

## 22.4 Speech-rate proxy

Without downloading or processing isolated audio, MVP can estimate:

```text
transcript words / transcript duration
```

Label this clearly as a transcript-based speech-rate estimate.

## 22.5 Transcript quality

Use:

* Parsing warnings
* Unaligned regions
* Missing punctuation
* Overlapping timestamps
* User correction count
* Language-model confidence

## 22.6 Personal difficulty

Use:

* Card success
* Audio-recognition success
* Transfer success
* Rewatch comprehension
* Hint use
* Source dependence
* Review latency

## 22.7 User-facing result

Example:

```text
Overall: Stretch

Estimated known coverage: 92%
Vocabulary: Moderate
Expressions: Difficult
Sentence structure: Moderate
Speech rate: Fast
Transcript quality: High
Your source recognition: 76%
Your transfer performance: 54%
```

Do not present the overall label as an objective property of the video. It is learner-specific.

---

# 23. Struggle-detection system

## 23.1 Struggle score

Calculate from:

* Recent lapses
* Consecutive failures
* Hint dependence
* Long response latency
* Source-recognition failure
* Transfer failure
* Pronunciation self-rating
* Time since first introduction

Example:

```text
struggle_score =
    0.30 × recent_lapse_rate
  + 0.20 × consecutive_failure_score
  + 0.15 × transfer_gap
  + 0.15 × hint_dependence
  + 0.10 × response_latency_score
  + 0.10 × source_recognition_failure
```

## 23.2 Failure diagnosis

Classify the likely problem.

### Meaning failure

The learner does not know or confuses the meaning.

Intervention:

1. Show source sentence.
2. Show short definition.
3. Contrast nearby meaning.
4. Test in a new sentence.

### Audio-recognition failure

The learner knows the written form but fails to hear it.

Intervention:

1. Replay short interval.
2. Show transcript.
3. Highlight reductions or boundaries.
4. Replay without transcript.
5. Use a different occurrence when available.

### Form-retrieval failure

The learner knows the meaning but cannot produce the expression.

Intervention:

1. Show first-word hint.
2. Show construction frame.
3. Complete cloze.
4. Produce personal sentence.

### Context-bound knowledge

The learner succeeds only with the original sentence.

Intervention:

1. Show different occurrence.
2. Present changed cloze.
3. Ask for personalized production.

### Suspected data-quality failure

The item may be wrong.

Intervention:

* Flag candidate
* Suspend card
* Reopen item for correction
* Inspect transcript
* Inspect selected dictionary sense

## 23.3 Escalation ladder

For persistent difficulty:

1. Original 5–15-second source interval
2. Wider 30–90-second context
3. Different occurrence in the source bank
4. Changed cloze
5. Personal production
6. Full-video recommendation when appropriate

---

# 24. Video recommendation system

The MVP recommends only videos already added by the user.

## 24.1 Recommendation eligibility

A source may be recommended when:

* It contains one or more current struggle items.
* Its estimated lexical coverage is not excessively low.
* Transcript quality is acceptable.
* It contains enough active targets to justify viewing.
* The learner has not just watched it repeatedly.
* It is not marked unhelpful.

## 24.2 Recommendation score

```text
recommendation_score =
    0.35 × struggle_item_overlap
  + 0.20 × comprehensibility_fit
  + 0.15 × contextual_diversity_value
  + 0.10 × interest_relevance
  + 0.10 × source_quality
  + 0.10 × active_item_density
  - repetition_penalty
  - excessive_difficulty_penalty
```

## 24.3 Recommendation forms

### Clip recommendation

Preferred default.

```text
Review 01:42–02:18
Contains 3 items you recently missed.
```

### Full-video recommendation

Use only when:

* Several active items appear throughout the video.
* Coverage is suitable.
* The user previously understood the general topic.
* The video is not excessively long.

### Alternative-context recommendation

When the same item appears in another added video:

```text
Hear “run into” from another speaker.
```

## 24.4 User feedback

Every recommendation supports:

* Helpful
* Not helpful
* Too easy
* Too difficult
* Wrong transcript
* Wrong item association
* Do not recommend again

---

# 25. Candidate inbox behavior

## 25.1 Candidate card contents

Show:

* Proposed canonical form
* Item type
* Source sentence
* Source playback
* Meaning
* Natural translation
* Literal translation, when useful
* Register
* Region
* Frequency rank
* Source occurrence count
* Distinct-video count
* Priority score
* Confidence
* Dictionary source
* LLM rationale

## 25.2 Actions

### Approve

Creates or updates a learning item.

### Approve and prioritize

Adds a source-salience boost.

### Mark known

Updates learner state without adding cards.

### Reject

Requires optional reason:

* Already know
* Too rare
* Proper name
* Bad phrase boundary
* Bad transcript
* Bad definition
* Not useful
* Duplicate
* Other

### Edit

Allows correction of:

* Canonical form
* Item type
* Meaning
* Translation
* Register
* Region
* Occurrence boundaries

### Merge

Combines candidate with an existing item.

### Split

Separates incorrectly merged senses or constructions.

### Defer

Leaves candidate pending.

## 25.3 Batch behavior

Support:

* Approve selected
* Reject selected
* Mark selected known
* Filter by score
* Filter by type
* Filter by confidence
* Filter by source

Batch approval must remain a deliberate action.

---

# 26. Minimal local-web architecture

## 26.1 Recommended stack

Use an all-TypeScript monorepo to reduce integration cost.

```text
apps/
  web/
  api/
  worker/

packages/
  core/
  database/
  language-adapters/
  providers/
  shared-ui/
```

### Web

* React
* TypeScript
* Vite
* Browser MediaRecorder API
* YouTube IFrame Player API

### API

* Node.js
* TypeScript
* Fastify
* Zod request validation

### Worker

* Node.js
* TypeScript
* SQLite-backed job polling
* Structured extraction pipeline
* Provider adapters

### Database

* SQLite
* Drizzle ORM or equivalent lightweight typed ORM
* Explicit migrations

### Scheduler

* `ts-fsrs`

### Local process management

A root command starts:

* Web server
* API server
* Worker

No Redis is required for MVP.

## 26.2 Why not a single browser-only application?

The application needs:

* Long-running extraction jobs
* Provider-secret protection
* Transcript processing
* Reliable database writes
* Retryable jobs
* Local file access
* Structured logs

These belong in a local backend and worker.

## 26.3 Why not Electron initially?

Electron packaging adds:

* Installer work
* Update handling
* Additional security concerns
* Platform testing
* Larger distribution size

The MVP can run through:

```text
localhost
```

Desktop packaging may follow after product validation.

---

# 27. Background-job architecture

## 27.1 Job types

```text
PARSE_TRANSCRIPT
RECONSTRUCT_SENTENCES
ANNOTATE_TRANSCRIPT
EXTRACT_WORD_CANDIDATES
EXTRACT_MWE_CANDIDATES
EXTRACT_CONSTRUCTIONS
LOOKUP_DEFINITIONS
DISAMBIGUATE_SENSES
CONSOLIDATE_CANDIDATES
SCORE_CANDIDATES
RECALCULATE_VIDEO_DIFFICULTY
RECALCULATE_RECOMMENDATIONS
EXPORT_DATA
```

## 27.2 Job states

```text
pending
running
succeeded
failed
cancelled
needs_input
```

## 27.3 Job requirements

Every job must be:

* Idempotent
* Retryable
* Inspectable
* Cancellable where possible
* Associated with structured logs
* Associated with input and output versions

## 27.4 Failure behavior

When a provider fails:

* Preserve completed pipeline stages.
* Mark the failed stage.
* Display actionable error.
* Permit retry.
* Do not duplicate candidates.
* Do not silently fall back to fabricated definitions.

## 27.5 Versioning

Store:

* Extraction-pipeline version
* Language-adapter version
* Prompt version
* Model identifier
* Dictionary-provider version
* Frequency-dataset version

This allows later reprocessing and comparison.

---

# 28. Database model

## 28.1 Core tables

### `profiles`

```text
id
native_language
target_language
proficiency_label
daily_minutes
new_item_limit
created_at
updated_at
```

### `interests`

```text
id
profile_id
name
weight
created_at
```

### `videos`

```text
id
source_type
external_video_id
url
title
target_language
duration_ms
transcript_status
processing_status
estimated_coverage
difficulty_label
created_at
updated_at
```

### `video_interests`

```text
video_id
interest_id
weight
```

### `transcript_files`

```text
id
video_id
format
original_filename
storage_path
checksum
parser_version
created_at
```

### `transcript_segments`

```text
id
video_id
start_ms
end_ms
speaker_label
raw_text
normalized_text
confidence
sequence_index
```

### `sentences`

```text
id
video_id
start_ms
end_ms
text
normalized_text
complexity_score
language_confidence
```

### `sentence_segments`

```text
sentence_id
transcript_segment_id
sequence_index
```

### `learning_items`

Use fields defined in the learning-item model.

### `item_forms`

Use fields defined above.

### `item_occurrences`

Use fields defined above.

### `definitions`

```text
id
item_id
provider
provider_entry_id
sense_id
definition
translation
register
region
evidence_json
confidence
is_user_edited
created_at
```

### `candidates`

```text
id
video_id
canonical_form
proposed_type
proposed_sense
score
extraction_confidence
definition_confidence
status
rejection_reason
pipeline_version
created_at
updated_at
```

### `candidate_occurrences`

```text
candidate_id
sentence_id
start_ms
end_ms
surface_form
confidence
```

### `learner_item_states`

Use fields defined above.

### `cards`

```text
id
profile_id
item_id
card_type
prompt_template_version
status
fsrs_state_json
due_at
last_reviewed_at
created_at
```

### `reviews`

```text
id
card_id
item_id
video_id
card_type
shown_at
answered_at
response_text
response_latency_ms
machine_classification
user_rating
scheduler_rating
hint_count
source_context_used
transfer_context
created_at
```

### `recordings`

```text
id
review_id
temporary_path
duration_ms
saved_by_user
created_at
expires_at
```

### `recommendations`

```text
id
profile_id
video_id
recommendation_type
start_ms
end_ms
score
reason_json
status
created_at
```

### `jobs`

```text
id
job_type
entity_type
entity_id
status
attempt_count
input_json
output_json
error_json
created_at
started_at
completed_at
```

### `settings`

```text
key
value_json
updated_at
```

---

# 29. API surface

## 29.1 Profile

```text
GET    /api/profile
PUT    /api/profile
POST   /api/profile/placement
GET    /api/profile/stats
```

## 29.2 Interests

```text
GET    /api/interests
POST   /api/interests
PUT    /api/interests/:id
DELETE /api/interests/:id
```

## 29.3 Videos

```text
GET    /api/videos
POST   /api/videos
GET    /api/videos/:id
PUT    /api/videos/:id
DELETE /api/videos/:id
POST   /api/videos/:id/transcript
POST   /api/videos/:id/process
POST   /api/videos/:id/recalculate
GET    /api/videos/:id/transcript
GET    /api/videos/:id/items
GET    /api/videos/:id/recommendations
```

## 29.4 Candidates

```text
GET    /api/candidates
GET    /api/candidates/:id
POST   /api/candidates/:id/approve
POST   /api/candidates/:id/reject
POST   /api/candidates/:id/mark-known
POST   /api/candidates/:id/defer
POST   /api/candidates/:id/merge
POST   /api/candidates/:id/split
PUT    /api/candidates/:id
POST   /api/candidates/batch
```

## 29.5 Items

```text
GET    /api/items
GET    /api/items/:id
PUT    /api/items/:id
POST   /api/items/:id/suspend
POST   /api/items/:id/unsuspend
POST   /api/items/:id/star
GET    /api/items/:id/occurrences
GET    /api/items/:id/history
```

## 29.6 Review

```text
POST   /api/review/session
GET    /api/review/session/:id/next
POST   /api/review/session/:id/answer
POST   /api/review/session/:id/rate
POST   /api/review/session/:id/hint
POST   /api/review/session/:id/complete
GET    /api/review/due
GET    /api/review/forecast
```

## 29.7 Recommendations

```text
GET    /api/recommendations
POST   /api/recommendations/:id/accept
POST   /api/recommendations/:id/dismiss
POST   /api/recommendations/:id/feedback
```

## 29.8 Jobs and diagnostics

```text
GET    /api/jobs
GET    /api/jobs/:id
POST   /api/jobs/:id/retry
POST   /api/jobs/:id/cancel
GET    /api/diagnostics/providers
GET    /api/diagnostics/pipeline
```

## 29.9 Data portability

```text
POST   /api/export
POST   /api/import
DELETE /api/data
```

---

# 30. Review-session generation

## 30.1 Session inputs

```ts
interface SessionRequest {
  desiredMinutes: number;
  includeNewItems: boolean;
  includeVideoLoop: boolean;
  includeTransfer: boolean;
  includeErrorRepair: boolean;
}
```

## 30.2 Selection order

1. Overdue lapse cards
2. Due cards
3. Struggling-item repair
4. Transfer cards
5. New cards
6. Optional fluency task

## 30.3 Constraints

* Do not repeat the same item consecutively.
* Do not introduce multiple siblings together.
* Do not exceed estimated time budget by more than 10%.
* Do not introduce new items when burden limits are exceeded.
* Prefer high-priority approved items.
* Prefer a mix of words, expressions, and constructions.
* Avoid more than three cards from the same video consecutively.
* Avoid repeatedly testing one exact sentence.

---

# 31. Metrics

## 31.1 North-star metric

```text
Correct delayed retrievals in unseen contexts per hour of study
```

Operational form:

```text
delayed_transfer_correct_per_hour
```

A correct event must:

* Occur after a configured delay
* Use an unseen or materially changed context
* Be completed without revealing the answer
* Preserve intended meaning

## 31.2 Learning metrics

Track:

* Delayed audio-recognition accuracy
* Delayed productive-recall accuracy
* Contextual-cloze accuracy
* Transfer success
* Source dependence
* Lapse rate
* Retention by item type
* Retention by source
* Retention by frequency band
* Correct use in output
* Video comprehension before and after study

## 31.3 Efficiency metrics

Track:

* Retained items per study hour
* Review seconds per retained item
* New-item review debt
* Due-card completion rate
* Candidate approval rate
* Candidate edit rate
* Definition correction rate
* Transcript correction rate
* Extraction cost per approved item
* LLM cost per retained item

## 31.4 Product-quality metrics

Track:

* Percentage of candidates rejected as useless
* Percentage rejected as duplicates
* Percentage rejected for bad definitions
* Percentage rejected for bad transcript alignment
* Source interval replay success
* Failed processing jobs
* Provider failure rate
* Recommendation acceptance
* Recommendation helpfulness

## 31.5 Avoid as primary success metrics

Do not optimize primarily for:

* Videos added
* Cards generated
* Total review count
* Streak length
* Minutes spent
* Number of extracted tokens

These can reward workload rather than learning.

---

# 32. Privacy and security

## 32.1 Local storage

Store locally:

* Profile
* Interests
* Transcripts
* Items
* Review history
* Recordings explicitly saved by the user
* Provider logs, subject to settings

## 32.2 External requests

Clearly disclose when data is sent to:

* LLM provider
* Dictionary provider
* YouTube embedded player
* Optional metadata provider

## 32.3 API keys

* Read from `.env.local`.
* Never return through frontend APIs.
* Never store in review logs.
* Redact from error output.
* Never commit to source control.

## 32.4 Microphone data

Default:

* Process in browser where possible.
* Store only temporarily.
* Delete after review.
* Require explicit action to save.

## 32.5 Local binding

* Bind API to loopback.
* Reject nonlocal origins by default.
* Use strict CORS configuration.
* Display a warning before allowing LAN access.

## 32.6 Content injection

* Treat transcripts as untrusted content.
* Use schema validation.
* Escape rendered transcript HTML.
* Do not render arbitrary subtitle markup.
* Do not let transcript content alter system prompts.
* Do not execute transcript links or scripts.

---

# 33. Accessibility and usability requirements

The MVP should support:

* Keyboard-only review
* Visible focus states
* Screen-reader labels
* Caption and transcript resizing
* Adjustable playback pre-roll
* Adjustable playback speed through permitted player controls
* Reduced-motion mode
* High-contrast interface
* Replay keyboard shortcut
* Reveal-answer shortcut
* Rating shortcuts
* Microphone-free operation
* Color-independent status indicators

Suggested review shortcuts:

```text
Space: play or pause
R: replay interval
Enter: reveal answer
1: Again
2: Hard
3: Good
4: Easy
H: hint
C: expand context
```

---

# 34. Testing strategy

## 34.1 Unit tests

Test:

* Transcript parsers
* Timestamp normalization
* Sentence reconstruction
* Candidate deduplication
* Frequency normalization
* Priority scoring
* Function-word suppression
* Review selection
* Sibling burying
* Struggle scoring
* Recommendation scoring
* Data export
* Provider-output validation

## 34.2 Language-fixture tests

Maintain a fixed transcript corpus containing:

* Normal sentences
* Subtitle line breaks
* False starts
* Slang
* Named entities
* Multiword expressions
* Ambiguous words
* Overlapping captions
* Missing punctuation
* Code-switching
* Offensive or sensitive language

Expected extraction results should be version controlled.

## 34.3 Integration tests

Test:

* Add video and transcript
* Complete ingestion
* Approve candidate
* Generate cards
* Complete review
* Update FSRS state
* Recalculate difficulty
* Generate recommendation
* Export and import database

## 34.4 Browser tests

Test:

* Embedded player initialization
* Timestamp seeking
* Interval stopping
* Transcript synchronization
* Microphone permission denial
* Recording and deletion
* Keyboard review
* Refresh during session
* Worker failure display

## 34.5 LLM evaluation set

Create a manually labeled evaluation set for the initial target language.

Score:

* Correct item boundary
* Correct item type
* Correct sense
* Correct register
* Correct translation
* Hallucination rate
* Duplicate rate
* Confidence calibration

Do not modify prompts based only on a few anecdotal examples.

## 34.6 Human acceptance testing

For each candidate sample, a proficient speaker should judge:

* Is this a coherent learning item?
* Is the selected meaning correct in context?
* Is the register correct?
* Is the phrase reusable?
* Is the source interval appropriate?
* Would this be worth a flashcard?

---

# 35. MVP implementation order

The following order is dependency-driven. Do not begin advanced LLM extraction before the manual media and review loop works.

---

## Stage 0: Lock scope and constraints

### Objective

Prevent the project from expanding into multilingual extraction, pronunciation grading, and unrestricted YouTube ingestion before the central learning loop is validated.

### Steps

1. Select the first target language.
2. Select the native language.
3. Select one frequency-data source.
4. Select one dictionary provider.
5. Select one optional LLM provider.
6. Confirm that the MVP requires user-supplied or authorized transcripts.
7. Write source-use and privacy notices.
8. Define the exact supported transcript formats.
9. Define the initial function-word list.
10. Create a hand-labeled evaluation transcript.
11. Define the north-star metric.
12. Freeze post-MVP features.

### Exit criteria

* One language pair selected.
* Data providers selected.
* YouTube download behavior excluded.
* Hand-labeled evaluation set exists.
* MVP goals and non-goals approved.

---

## Stage 1: Local application skeleton

### Objective

Create a reliable local web application with persistent storage.

### Steps

1. Create TypeScript monorepo.
2. Create React web application.
3. Create Fastify API.
4. Create worker process.
5. Configure shared types.
6. Configure SQLite.
7. Add migration system.
8. Add structured logging.
9. Add health endpoints.
10. Add local process-start command.
11. Add environment configuration.
12. Bind services to localhost.
13. Add error boundary and global error display.
14. Add database backup command.

### Initial pages

* Today
* Videos
* Candidates
* Items
* Settings
* Diagnostics

These may initially contain placeholders.

### Exit criteria

* One command starts all local services.
* Database migrations run automatically.
* Application persists profile settings.
* Worker can claim and complete a test job.
* Services reject unsupported remote origins.

---

## Stage 2: Manual video and transcript ingestion

### Objective

Prove that a user can add a YouTube video, attach a transcript, and inspect synchronized source text.

### Steps

1. Build Add video form.
2. Parse YouTube URL.
3. Store video ID.
4. Embed YouTube player.
5. Implement VTT parser.
6. Implement SRT parser.
7. Implement pasted timestamp format.
8. Show transcript-preview screen.
9. Validate timestamps.
10. Store transcript segments.
11. Add synchronized transcript view.
12. Add click-transcript-to-seek behavior.
13. Add manual timestamp correction.
14. Add video processing status.
15. Add transcript deletion and replacement.
16. Add duplicate-video detection.

### Exit criteria

* User can add a video and transcript.
* Transcript appears in timestamp order.
* Clicking a segment seeks to the expected region.
* User can correct a segment.
* No media or isolated audio is downloaded.
* Refreshing preserves the source.

---

## Stage 3: Manual learning-item prototype

### Objective

Validate review behavior before building automatic extraction.

### Steps

1. Let user select transcript text manually.
2. Create a learning item from selection.
3. Ask user for:

   * Canonical form
   * Item type
   * Meaning
   * Translation
4. Attach occurrence timestamps.
5. Generate audio-recognition card.
6. Generate cloze card.
7. Generate productive-recall card.
8. Implement card preview.
9. Implement embedded source playback.
10. Implement answer reveal.
11. Implement four review ratings.
12. Integrate FSRS.
13. Store review logs.
14. Implement sibling burying.
15. Add due-card dashboard.
16. Add new-card limit.

### Exit criteria

* A user can manually create an item.
* Each card type works.
* Review ratings update due dates.
* Same-item siblings do not appear consecutively.
* Source clip can be replayed during review.
* Review history is inspectable.

This is the first complete vertical slice.

---

## Stage 4: Core transcript processing

### Objective

Generate structured sentence and token data without LLM dependency.

### Steps

1. Reconstruct sentences from transcript segments.
2. Integrate language tokenizer.
3. Integrate lemmatizer.
4. Integrate part-of-speech tagger.
5. Integrate named-entity recognition where available.
6. Store morphological features.
7. Link sentences to source segments.
8. Calculate source occurrence timestamps.
9. Calculate transcript-based speech rate.
10. Calculate parsing and language confidence.
11. Add diagnostics view for annotations.
12. Add fixture-based tests.

### Exit criteria

* Sentence boundaries are acceptably accurate on evaluation set.
* Tokens link back to source timestamps.
* Named entities are identified well enough for filtering.
* Annotation failures are visible rather than silently ignored.

---

## Stage 5: Word-candidate extraction

### Objective

Automatically propose useful single-word items.

### Steps

1. Generate eligible content-word candidates.
2. Normalize forms.
3. Consolidate inflections.
4. Exclude obvious artifacts.
5. Apply function-word suppression.
6. Apply named-entity suppression.
7. Look up general frequency.
8. Count source occurrences.
9. Count distinct sentence contexts.
10. Detect existing items.
11. Create candidate records.
12. Build Candidate inbox.
13. Add approve, reject, mark known, edit, and merge.
14. Store rejection reasons.
15. Calculate initial priority score.

### Exit criteria

* Candidate inbox produces useful word candidates.
* Duplicate and artifact rates meet internal thresholds.
* User can approve candidates into the review queue.
* Every candidate shows source evidence and score components.

---

## Stage 6: Dictionary grounding

### Objective

Attach trustworthy meanings before enabling broader LLM extraction.

### Steps

1. Implement dictionary-provider adapter.
2. Retrieve possible senses.
3. Store provider evidence.
4. Build manual sense-selection UI.
5. Generate short learner explanation from selected sense.
6. Add register and region fields.
7. Add uncertainty state.
8. Add definition editing.
9. Add dictionary failure handling.
10. Prevent activation of unresolved candidates.

### Exit criteria

* Every approved item has a meaning.
* Dictionary provenance is visible.
* User can change the selected sense.
* Missing evidence does not silently create a confident definition.

---

## Stage 7: LLM-assisted disambiguation

### Objective

Use an LLM to reduce manual sense-selection work without making it the authority.

### Steps

1. Implement provider abstraction.
2. Define strict JSON schemas.
3. Write transcript-injection-resistant prompts.
4. Supply dictionary senses and source context.
5. Ask model to choose sense.
6. Ask for learner-level explanation.
7. Ask for register and usage notes.
8. Record confidence.
9. Validate output.
10. Add retry and failure states.
11. Display model rationale.
12. Build evaluation harness.
13. Compare against human labels.
14. Add cost tracking.

### Exit criteria

* Structured output validation succeeds reliably.
* Hallucinations are measurable.
* User can inspect dictionary evidence separately from LLM prose.
* Low-confidence outputs remain pending.

---

## Stage 8: Multiword expressions and constructions

### Objective

Move P80 beyond isolated vocabulary.

### Steps

1. Generate n-gram candidates.
2. Add language-specific pattern rules.
3. Query dictionary for expression matches.
4. Ask LLM to identify semantic units.
5. Merge overlapping phrase candidates.
6. Detect verb-preposition and verb-particle frames.
7. Implement construction representation with slots.
8. Score phrase/construction value.
9. Add phrase-boundary editing.
10. Add candidate split and merge.
11. Generate cloze cards.
12. Generate productive prompts.
13. Add expression-specific evaluation fixtures.

### Exit criteria

* Expressions are not merely arbitrary word spans.
* Function words appear inside useful units.
* Constructions support variable slots.
* User can correct phrase boundaries.
* Duplicate surface forms map to a canonical item.

---

## Stage 9: Learner model and adaptive admission

### Objective

Prevent card overload and prioritize the learner’s current frontier.

### Steps

1. Add proficiency selection.
2. Add optional placement test.
3. Initialize known probability by frequency band.
4. Add Mark known behavior.
5. Update known probability from reviews.
6. Add interest weights.
7. Calculate domain relevance.
8. Calculate contextual diversity.
9. Calculate reuse potential.
10. Expose score breakdown.
11. Build approved-item queue.
12. Enforce daily new-item limit.
13. Add review-burden calculation.
14. Pause new items when retention falls.
15. Add manual priority override.

### Exit criteria

* High-value unknown items outrank trivial and obscure items.
* Already-known items are not repeatedly proposed.
* New-item introduction responds to review burden.
* User can inspect why an item was prioritized.

---

## Stage 10: Video difficulty

### Objective

Estimate whether each source is productive, stretching, or excessively difficult.

### Steps

1. Calculate learner-known token coverage.
2. Calculate unknown high-value count.
3. Calculate phraseological difficulty.
4. Calculate syntactic proxies.
5. Calculate transcript-based speech rate.
6. Calculate transcript quality.
7. Calculate personal card performance.
8. Calculate source-dependence gap.
9. Display difficulty dimensions.
10. Avoid relying on one opaque number.
11. Recalculate after meaningful review changes.

### Exit criteria

* Difficulty changes as learner knowledge changes.
* User can see contributing dimensions.
* Videos with bad transcripts are not mislabeled as merely difficult.

---

## Stage 11: Video learning loop

### Objective

Turn source-linked flashcards into a complete input–retrieval–output loop.

### Steps

1. Add clip-selection interface.
2. Add unsupported first viewing.
3. Add main-idea prompt.
4. Add target-transcript viewing.
5. Add up-to-five-item focus.
6. Add unsupported rewatch.
7. Add short typed summary.
8. Add optional recorded summary.
9. Add second summary requiring target items.
10. Add before-and-after comprehension rating.
11. Store video-loop session results.
12. Add transfer-card generation.

### Exit criteria

* User completes a source learning loop.
* P80 records comprehension before and after.
* Items are tested outside the exact source sentence.
* Output practice remains short and focused.

---

## Stage 12: Struggle diagnosis and recommendations

### Objective

Use performance data to choose better remedial context.

### Steps

1. Calculate struggle score.
2. Distinguish meaning, audio, form, and transfer failures.
3. Add targeted interventions.
4. Add context-expansion controls.
5. Recommend short source clips.
6. Recommend alternative occurrences.
7. Recommend full videos only when eligible.
8. Add recommendation feedback.
9. Recalculate recommendation weights.
10. Add data-quality flag when failures may reflect a bad item.

### Exit criteria

* Repeated failure triggers a specific intervention.
* P80 does not merely replay the full source.
* Recommendations explain why they appeared.
* User feedback alters future recommendations.

---

## Stage 13: Metrics, export, and pilot readiness

### Objective

Make the MVP measurable and safe to test.

### Steps

1. Implement learning metrics.
2. Implement efficiency metrics.
3. Implement quality metrics.
4. Add local analytics dashboard.
5. Add JSON export.
6. Add CSV review export.
7. Add database backup.
8. Add full data deletion.
9. Add provider-usage report.
10. Complete accessibility pass.
11. Complete security review.
12. Complete YouTube-policy review.
13. Freeze pilot version.
14. Run internal dogfooding.
15. Label known limitations.

### Exit criteria

* North-star metric can be calculated.
* Data can be exported and restored.
* User can delete all local data.
* Known policy and quality risks are documented.
* Application is ready for a small user pilot.

---

# 36. MVP definition of done

The MVP is complete only when all of the following are true.

## 36.1 Source ingestion

* User can add a YouTube URL.
* User can upload VTT or SRT.
* Transcript is synchronized to embedded playback.
* Transcript can be corrected.
* No YouTube media is downloaded or isolated.

## 36.2 Extraction

* Words, expressions, and constructions can be proposed.
* Every candidate links to source evidence.
* Duplicates are consolidated.
* Function words are suppressed only as isolated low-value items.
* Dictionary provenance is stored.
* LLM uncertainty is visible.

## 36.3 Human control

* User can approve, reject, edit, merge, split, defer, or mark known.
* No unresolved candidate enters active review.
* User can inspect ranking components.

## 36.4 Review

* Audio/source recognition works.
* Contextual cloze works.
* Productive recall works.
* Skill schedules are independent.
* FSRS due dates persist.
* Sibling cards are buried.
* Review burden controls new-item admission.

## 36.5 Source learning

* User can complete a video loop.
* Original clip can be replayed.
* Wider context can be opened.
* Transfer reps use changed contexts.
* Before-and-after comprehension is recorded.

## 36.6 Adaptation

* Learner-known probability changes with reviews.
* Video difficulty changes with learner performance.
* Struggling items are detected.
* Targeted remediation is available.
* Source recommendations are explainable.

## 36.7 Reliability

* Jobs are retryable.
* Provider failures do not corrupt state.
* Database is migratable.
* Export and import work.
* Test fixtures pass.
* Application runs through a documented local setup.

---

# 37. Post-MVP roadmap

## Phase A: Pronunciation support

Add:

* Phoneme-level targets
* Stress marking
* Explicit pronunciation feedback
* Multiple-speaker comparison
* Intelligibility-oriented scoring
* Language-specific ASR evaluation

Do not add one generic pronunciation score.

## Phase B: Conversation mode

Conversation must be modeled around intent, not one correct response.

```ts
interface ConversationScenario {
  situation: string;
  relationship: string;
  userIntent: string;
  expectedSocialActions: string[];
  acceptableResponseConstraints: string[];
  targetItems: string[];
  registerConstraints: string[];
}
```

Grade separately:

* Meaning communicated
* Social appropriateness
* Comprehensibility
* Grammar
* Register
* Target-item use
* Conversation continuation

Feedback loop:

1. One important correction
2. One natural recast
3. One immediate retry

Initial scenarios:

* Greeting
* Introducing yourself
* Asking a follow-up
* Clarifying
* Making a request
* Declining politely
* Describing plans
* Explaining a problem
* Giving an opinion
* Ending a conversation

## Phase C: Video-derived conversation

Generate scenarios from:

* Video topics
* Approved items
* Common communication functions
* Learner interests
* Recent struggle items

The role-play model uses the target language.

The advisor model uses the native language.

The evaluator scores intent and constraints rather than similarity to one gold sentence.

## Phase D: Additional source adapters

Potential adapters:

* Local user-owned media
* Podcasts with licensed transcripts
* Educational corpora
* User-owned YouTube captions
* Public-domain media
* Creator-provided transcript feeds

## Phase E: Multilingual support

Add one language at a time through a certification checklist covering:

* Segmentation
* Lemmatization
* Morphology
* Frequency
* Dictionaries
* Function words
* Expressions
* Constructions
* Orthography
* ASR
* Human evaluation

## Phase F: External content discovery

Only after legal and provider review:

* Search for videos containing struggle items
* Rank by estimated comprehensibility
* Prefer contextual diversity
* Avoid recommending long videos for one item
* Show why each source was chosen

## Phase G: Scheduler personalization

After sufficient review data:

* Optimize FSRS parameters
* Personalize desired retention
* Model modality-specific retention
* Estimate optimal new-item load
* Identify cards with poor instructional value

---

# 38. Principal risks

## 38.1 Card explosion

**Risk:** Extraction produces hundreds of candidates per video.

**Mitigation:**

* Human approval
* Strict quality gates
* Daily new-item limits
* Review-burden controls
* Canonical consolidation
* Priority threshold
* Candidate expiry or archive

## 38.2 Hallucinated definitions

**Risk:** LLM invents plausible but incorrect contextual meanings.

**Mitigation:**

* Dictionary-first workflow
* Evidence storage
* Confidence threshold
* Human approval
* No unsupported confident claims
* Evaluation set

## 38.3 Bad phrase boundaries

**Risk:** Model extracts arbitrary word groups.

**Mitigation:**

* Language-specific rules
* Dictionary matching
* Reuse-value threshold
* Boundary editing
* Merge and split
* Human rejection data

## 38.4 Transcript errors

**Risk:** Incorrect captions create incorrect items and pronunciation examples.

**Mitigation:**

* Transcript editing
* Confidence display
* Data-quality failure classification
* Candidate quarantine
* Source replay
* User reporting

## 38.5 Source dependence

**Risk:** Learner memorizes one sentence without learning the expression.

**Mitigation:**

* Transfer cards
* Contextual diversity
* Personalized production
* Different occurrences
* Source-dependence metric

## 38.6 Review overload

**Risk:** Learner stops because the queue becomes unmanageable.

**Mitigation:**

* Adaptive new-item limits
* Burden forecast
* Low-value suspension
* Sibling burying
* Time-budgeted sessions

## 38.7 Misleading difficulty scores

**Risk:** A poor transcript or rare extracted terms make a video appear difficult.

**Mitigation:**

* Multidimensional difficulty
* Separate transcript quality
* Coverage calculation over eligible tokens
* Personal performance
* Explainable score components

## 38.8 YouTube dependency

**Risk:** The product depends on unofficial access behavior.

**Mitigation:**

* Embedded playback
* User-supplied transcripts
* Source-adapter architecture
* No media download
* No isolated audio storage
* Regular policy review

## 38.9 Pronunciation overclaiming

**Risk:** ASR transcription is presented as authoritative pronunciation judgment.

**Mitigation:**

* Defer automated grading
* Use recording and comparison
* Focus on intelligibility
* Add explicit feedback only after language-specific validation

## 38.10 LLM operating cost

**Risk:** Enrichment cost scales with transcript length rather than learning value.

**Mitigation:**

* Deterministic processing first
* Batch requests
* Cache by canonical form and context
* Send only gated candidates
* Limit generated examples
* Track cost per approved and retained item

---

# 39. Product-validation plan

The MVP should test one clear question:

> Does source-linked, interest-specific retrieval produce better delayed recognition and productive transfer per minute than ordinary text-only flashcards?

## 39.1 Within-user comparison

Randomly assign approved items to:

### Standard condition

* Text prompt
* Definition
* Standard example

### P80 source-linked condition

* Original source playback
* Source context
* Transfer card
* Video-loop eligibility

Keep scheduling rules otherwise similar.

## 39.2 Evaluation points

Measure:

* 24-hour retention
* Seven-day retention
* Delayed audio recognition
* Delayed productive recall
* Transfer to new context
* Study time
* Review burden
* Learner preference

## 39.3 Success criteria

P80 is promising when the source-linked condition demonstrates at least one of:

* Better delayed transfer at similar time cost
* Similar transfer with lower time cost
* Better audio recognition
* Higher sustained use without higher review burden
* Better comprehension of the original source

A higher card count does not count as success.

---

# 40. Final MVP product definition

P80 MVP is a single-user local web application that:

* Accepts user-selected YouTube videos
* Uses user-supplied or authorized timestamped transcripts
* Plays source intervals through the embedded YouTube player
* Extracts words, multiword expressions, and constructions
* Grounds meanings in dictionaries and source context
* Uses an LLM only for structured disambiguation and explanation
* Requires human candidate approval
* Prioritizes items by learner need, domain relevance, general usefulness, contextual diversity, and reuse value
* Separates curriculum admission from review scheduling
* Maintains independent memory states for listening, cloze, and productive recall
* Uses FSRS for spaced review
* Limits new items based on review burden
* Reconnects difficult items to targeted source context
* Estimates learner-specific video difficulty
* Tests transfer beyond the original sentence
* Measures delayed learning efficiency rather than raw activity

The first release should prove that this learning loop works. Features such as unrestricted YouTube ingestion, pronunciation scoring, multilingual support, web-based slang research, and generated conversation should be added only after that central claim is validated.
