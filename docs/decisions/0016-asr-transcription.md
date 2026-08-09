# ADR 0016 — Transcription: local ASR primary, upload fallback

**Status:** Accepted
**Date:** 2026-08-08
**Depends on:** ADR 0015 (local media), ADR 0002 (Python sidecar)
**Blocks:** Stage 2 (ingestion), Stage 4 (sentence reconstruction)

## Context

ADR 0015 removed the constraint that forced transcripts to be user-supplied: P80 now holds
the media file, so it can read the audio. Spec §14.1's *"transcripts are user-supplied in
MVP"* was a consequence of the caption-scraping prohibition, not an independent product
decision, and the prohibition no longer has a subject.

Ingestion currently stalls on a subtitle file the user often does not have. For a
German-language video chosen because it is interesting, the realistic options were a
machine-generated caption track of unknown quality or nothing.

## Decision

**Adding a video enqueues transcription. Uploading a transcript remains available and, when
present, wins.**

### 1. Precedence

A user-supplied transcript is the higher authority whenever one exists. Rationale: it may be
human-authored and corrected, and the user chose to supply it, which is an explicit act
under the human-control rules (§7.3).

| State | Result |
|---|---|
| Video added, no transcript | `TRANSCRIBE` enqueued automatically |
| Upload arrives before ASR finishes | ASR job is cancelled; the upload is parsed |
| Upload arrives after ASR finished | The upload replaces the ASR transcript, with the usual corrections warning |
| ASR unavailable or fails | `transcript_status` goes `failed`; the upload path is offered |

Automatic enqueue is not an exception to the human-control rules. Rule 6 governs
**candidates becoming learning items**; a transcript is evidence, not an item, and nothing
downstream of it advances without a user action.

### 2. The engine

**faster-whisper for transcription, wav2vec2 forced alignment for word timing**, running in
the existing `services/nlp` sidecar behind `POST /transcribe`.

In the sidecar rather than a new process, because ADR 0002 already drew the boundary at
*Python only where the models are*, and the sidecar is about to hold three models anyway
(spaCy at Stage 4, SaT per ADR 0013). A fifth process is a real cost in `pnpm dev`, in
setup, and in the number of things that can be independently down.

The cost of that choice, recorded because it is the reason to reverse it: an ASR job holds
the sidecar for minutes, and the sidecar also serves the per-sentence `annotate` calls
Stage 4 makes. Once extraction runs concurrently with ingestion, transcription needs to move
to its own process or the endpoint needs a queue. It does not yet.

**Whisper's own segment boundaries are discarded.** They come from timestamp-token sampling
and the 30-second decoding window, not from linguistics, and they routinely fall nowhere
near the punctuation the model itself emitted. What the endpoint returns is a flat word
array; ADR 0017 makes that the source of truth and Stage 4 decides sentences from it.

### 3. Failure is loud

Three failure modes are made visible rather than absorbed, all of them cases where the
system would otherwise report success while being wrong:

- **No model, no fallback.** A sidecar without the ASR model returns `501`, matching what
  `/annotate` already does. Degrading to an empty or whitespace transcript is the named
  failure mode ADR 0002 exists to prevent.
- **No silent CPU fallback.** ASR on CPU is roughly twenty times slower and otherwise
  identical, which produces a job that looks like it is working for forty minutes. The
  sidecar refuses when GPU was configured and is unavailable, and says which.
- **Language mismatch is an error, not a guess.** The decode language is pinned from
  `profile.target_language` rather than detected. Detection still runs, and a detected
  language that disagrees fails the job with both values named. A German course silently
  fed an English video would otherwise produce a plausible transcript and a curriculum of
  the wrong language.

### 4. Hallucination signals now transfer

ADR 0013 §4 took a list of subtitle-boilerplate regexes from a sibling project and noted
that the confidence checks around them — `no_speech_prob`, `avg_logprob`, and a
repeat-window check for a stuck decoder — *did not* transfer, because user-supplied
transcripts carry no such signals.

ASR output does. Those three checks come across for the ASR path, and their finding is
recorded the same way everything else is: as a `ParseWarning`, never as a dropped row.
Whisper fabricates fluent, correctly formatted speech over music and silence, so this is the
one place where the transcript's own confidence is worth surfacing to the user.

The existing `subtitle_boilerplate` warning covers the regex list for both paths. The
vocabulary gains two kinds in `04-providers.md` §1 — `low_asr_confidence` for the numeric
signals, and `unaligned_words` for a word the forced aligner could not place in time. The
list is closed and versioned (ADR 0014), so these are an amendment rather than a free
addition, and `unaligned_words` is the one warning that changes what a consumer *can* do
rather than what it should believe: a word with no timestamp has no clip.

### 5. Provenance

`transcript_files.source` records `asr` or `upload`. ADR 0013 made transcript provenance
load-bearing for Stage 4: `punct_confidence` keys on where the file came from, because a
YouTube auto-caption track with no punctuation and a human-authored SRT are not equally
reliable evidence of a sentence ending.

ASR output lands at the confident end of that scale for German — the model punctuates with
prosodic access to the audio, which is exactly the case the sibling project's
`STRONG_PUNCT_LANGS` table was describing. Stage 4 sets the weight from this column; the
value is measured against the ADR 0006 corpus, not assumed here.

## Consequences

- **New setup cost.** A Whisper model (~1.5 GB for `large-v3`) and an alignment model
  (~1.2 GB for German) download during setup, alongside the spaCy and dictionary artifacts
  `docs/SETUP.md` already documents. Both are one-time and local; nothing is fetched at
  runtime, so `CLAUDE.md` rule 15 is unaffected.
- **`ffmpeg` is required** to decode the media file's audio. Permitted by ADR 0015's rewrite
  of the media rules.
- **`services/nlp` gains a GPU dependency it did not have.** ADR 0002's sidecar was
  CPU-stateless. It is now a process that wants a GPU for one of its endpoints, which is a
  material change to how it is deployed and to what "the sidecar is down" costs.
- **`transcript_files` gains `source` and the ASR model identifiers**, so a transcript is
  attributable and recomputable across a model change — the same requirement §27.5 places on
  annotations.
- **Transcription is the first job that takes minutes.** The 45-minute per-job ceiling
  (`04-providers.md` §4) was written for enrichment; it now has a second consumer, and job
  progress reporting stops being cosmetic.
- **`P80 works with no LLM configured` is unaffected**, and gains a sibling: P80 works with
  no ASR configured, via the upload path. Both are tested, not assumed.
- Reversible. Deleting the `TRANSCRIBE` handler and the sidecar endpoint returns the system
  to upload-only ingestion, which is a supported configuration rather than a broken one.

## Open question

**Which model size, and is `large-v3` worth its latency?** Resolved by measurement at
Stage 2's close, not by argument: transcribe both ADR 0006 corpus videos with
`large-v3` and `medium`, compare word error rate against the hand-corrected transcript, and
record wall-clock for each. The decision rule is that `medium` wins unless `large-v3`
reduces WER by enough to change a Stage 4 sentence boundary. Default until then is
`large-v3`, configurable.
