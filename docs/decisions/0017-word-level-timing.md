# ADR 0017 — Word-level timing is the source of truth

**Status:** Accepted
**Date:** 2026-08-08
**Depends on:** ADR 0016 (ASR)
**Amends:** ADR 0013 — supersedes its first mandatory adaptation and closes its first open
question
**Blocks:** Stage 2 (ingestion), Stage 4 (sentence reconstruction), Stage 11 (clip review)

## Context

ADR 0013 borrowed a three-signal sentence-boundary fusion from a sibling project and listed
four mandatory adaptations. The first was the largest:

> **The pause signal degrades from word-level to cue-level.** [The sibling] has
> forced-alignment timing on every token. P80 has `transcript_segments.start_ms/end_ms` —
> timing at cue boundaries only, with nothing inside a cue.

That degradation was forced by the transcript being a subtitle file. It also raised ADR
0013's first open question — whether the pause signal survives at cue level at all, or
whether the honest weight is near zero.

ADR 0016 makes forced alignment available. The constraint that produced the adaptation is
gone, so the adaptation is withdrawn rather than tuned around.

The same constraint was quietly costing more than sentence boundaries. Occurrence clip
boundaries were cue-bounded, meaning "replay this word" replayed the line containing it.
`07-extraction.md` §2.1 already specifies token spans as `(sentence_id, start_index,
end_index)`; without word timing those indices resolve to text but not to time.

## Decision

**Where a transcript has word-level timing, the word array is the source of truth and
segments are index ranges over it.**

This is the invariant ADR 0013 §2 recorded as convergent-but-not-borrowed, now adopted in
full: ASR produces the word array once; nothing downstream rewrites it; segments, sentences,
and token spans are ranges into it. Denormalised text and timing on `transcript_segments`
stay, for debuggability and for queries, and are **rebuilt from the indices** rather than
edited.

The reason this invariant is worth the schema is that an index range cannot desynchronise
from the timing its text is bound to. Every alternative — storing text twice, or letting a
later stage adjust a boundary in place — can.

### 1. Two timing tiers, declared rather than inferred

Uploaded VTT and SRT files carry no word timing and never will. So a transcript has one of
two tiers, stored on `transcript_files.timing_granularity`:

| Tier | Produced by | Word rows | Consumers get |
|---|---|---|---|
| `word` | ASR (ADR 0016) | yes | exact spans, per-word pauses, sample-accurate clips |
| `cue` | upload | no | cue-bounded spans, pauses at cue boundaries only |

A stored column rather than a nullable-join inference, because the difference is a
*capability* that consumers branch on, and a capability read off the absence of rows is a
capability nobody can see in a schema diagram. It also gives the degraded path a name to
display: a UI that says "timing is cue-level for this transcript" is honest, and one that
silently produces coarser clips is not.

**Consumers must handle both.** A helper in `packages/core` resolves a span to a time range
against whichever tier the transcript has, and the fallback is explicit at that one call
site rather than repeated at every consumer. Stage 4's pause signal reads word gaps at tier
`word` and cue gaps at tier `cue` — which is precisely the noisy-OR "absent means no
information" behaviour ADR 0013 identified as the reason the fusion survives varying input
quality.

### 2. Corrections do not rewrite words

`transcript_corrections` continues to target a segment, and words stay immutable. A
corrected segment therefore has text that no longer matches the words beneath it.

This is correct, not a defect: original data is immutable is a standing invariant, and the
word array is the original ASR evidence. A correction is the user's reading of what was
said; the words are what the model heard and when. Both are worth keeping and they answer
different questions. Segment-level timing on a corrected segment stays the original
range — the user corrected text, not timing, unless they also adjusted the boundary, which
is a separate field the schema already carries.

The consequence to state plainly: **token spans inside a corrected segment fall back to cue
timing**, because the word alignment no longer indexes the effective text. The span resolver
handles this at the same call site as the tier fallback.

### 3. What this closes

ADR 0013's first open question — *does the pause signal survive the drop to cue-level
timing?* — is **withdrawn for ASR transcripts**. The sibling project's `pause_weight` was
fitted to word-level forced alignment, and P80 now has word-level forced alignment from the
same class of model, so its starting value transfers instead of needing to be re-derived
from nothing.

It stays open for uploaded transcripts, which are still cue-level. The Stage 4 sweep
therefore measures one weight per tier rather than one weight, which is a better-posed
measurement than the original: the two tiers are genuinely different distributions and
fitting one number across both would have averaged them.

## Alternatives considered

**Collapse ASR output into cues and keep the schema as it is.** Rejected. It throws away the
signal that was the reason for adopting ASR's alignment step at all, and it makes the ASR
and upload paths identical at exactly the point where their quality differs most. The
schema saving is one table.

**Store words but keep every consumer on cues.** Rejected, and it was the tempting option:
it defers the Stage 4 rework while making the data available. It creates a second source of
truth with no decided reconciliation, which is the specific failure this ADR's invariant
exists to prevent. Data with no consumer also goes stale without anyone noticing, so the
first stage to actually use it would find it wrong.

## Consequences

- **New table `transcript_words`**, and `transcript_segments` gains a nullable word index
  range. Migration 0002.
- **Storage grows.** A one-hour video is roughly 9,000 words; at ~40 bytes a row that is
  under half a megabyte per video. Not a constraint at any library size P80 targets.
- **Stage 4's plan changes before Stage 4 starts**, which is the cheap time for it to
  change. `06-scoring.md`'s pause tunables become per-tier.
- **Occurrence clips become exact** for ASR transcripts, which is what ADR 0015's precise
  playback was for. The audio-recognition card (§19.1) can replay a word rather than a line.
- **Every score stores its breakdown** still holds: boundary provenance (ADR 0013 §2's
  `BoundaryInfo`) now records which tier its pause signal came from, so a boundary decided
  on cue timing is distinguishable after the fact from one decided on word gaps.
- Reversible in the sense that matters: dropping to cue-only means ignoring a table, not
  migrating data back.
