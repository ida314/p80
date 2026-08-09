# ADR 0014 — The parse-warning vocabulary, and where it lives

**Status:** Accepted
**Date:** 2026-08-08
**Blocks:** Stage 2 (transcript parsing)
**Amends:** `docs/contracts/04-providers.md` §1 (`ParseWarning`)
**Relates to:** ADR 0013 §4 (transcript noise patterns)

## Context

`ParseWarning` is how the transcript parser records an anomaly instead of discarding a cue.
Spec §14.2 makes this a parser responsibility — *"record parsing warnings"*, *"never silently
discard large transcript regions"* — and `06-scoring.md` §4.2 consumes the result as a
transcript-quality dimension displayed separately from difficulty, so a bad transcript is
never mistaken for a hard video.

The interface shipped in Stage 1 with seven kinds:

```
overlapping_timestamps · out_of_order · missing_punctuation · malformed_line
unparsed_region · encoding_fallback · suspicious_duration
```

Stage 2 is the first code to emit any of them, and two problems surface at once.

**Nothing in that list means "subtitle boilerplate."** ADR 0013 §4 takes
`bilingual-audio-generator`'s pattern list — `amara.org`, `opensubtitles`, `subtitles by …`,
`please subscribe`, bare `[Music]` / `♪` — and rejects the filter around it, because P80 does
not drop transcript rows. The ADR specifies the outcome in the user's terms: *"The user sees
'3 cues look like subtitle boilerplate' on the transcript-preview screen and decides."*

That sentence needs a **distinguishable, countable** kind, and none of the seven is one.
Nothing was unparsed, so not `unparsed_region`. The line is perfectly well formed, so not
`malformed_line`. It is not about punctuation, duration, ordering, or encoding. Forcing the
match into an ill-fitting kind means the preview screen cannot group it, and the quality
score cannot weigh it — a cue that reads *"Subtitles by the Amara.org community"* is not
evidence the transcript is malformed, it is evidence one line is not speech.

**The list is a type, not a value.** `ParseWarning.kind` is an inline union in
`packages/providers/src/index.ts`. A union has no runtime representation, so a Zod response
schema cannot validate against it, a UI cannot map severity over it, and a test cannot assert
the set is exhaustive. Every other contract enumeration — `TRANSCRIPT_FORMATS`,
`MEDIA_SOURCE_KINDS`, `CARD_TYPES`, all fifteen of them — is already an `as const` array in
`packages/core/src/domain.ts`, derived to a type. This one is the exception, and the exception
is only visible now because Stage 2 is the first consumer.

Both problems are cheapest to fix at this exact moment. The union has **zero call sites**
today. And `parse_warnings_json` is a **persisted** column, re-served on every transcript
read — a kind chosen wrongly here is baked into stored rows and costs a data migration to
relabel, which is strictly more expensive than this file.

## Decision

**1. Add an eighth kind, `subtitle_boilerplate`.**

> The cue matched a known subtitle-distribution or platform-noise pattern — an attribution
> line, a subscribe prompt, a bare music marker. The cue is stored like any other. The
> warning is the user's cue to decide.

It is the only kind that describes the *content* of a cue rather than the *structure* of the
file, which is exactly why it needed to be its own member rather than a borrowed one.

**2. Move the vocabulary to `packages/core/src/domain.ts`** as
`PARSE_WARNING_KINDS`, with `ParseWarningKind` derived from it. `packages/providers` imports
the type, as it already imports `TranscriptFormat` and `MediaSourceKind` from the same file.
One list then feeds the parser, the Zod response schema, and the preview screen's severity
map.

`ParseWarning`'s shape is otherwise unchanged: `{ kind, segmentIndex, message }`.

## Consequences

- **`docs/contracts/04-providers.md` §1 is amended** — the union becomes eight members and
  points at `domain.ts` as the authority. Marked `ADDED`.
- **Warnings become groupable and weighable.** The preview screen renders counts per kind,
  and Stage 10's transcript-quality dimension (`06-scoring.md` §4.2) can weight
  `subtitle_boilerplate` differently from `malformed_line`, which is the honest reading:
  boilerplate says a line is not speech, malformation says the file is damaged.
- **The list is now closed and testable.** An exhaustiveness test can assert that every kind
  the parser can emit is a member, which the inline union could not support.
- **Nothing is filtered.** This ADR makes a warning expressible; it does not make anything
  droppable. Boilerplate cues are stored, indexed, and returned like every other segment.
  Stage 2 carries a dedicated test for this, because "take the regex list" and "take the
  filter it was wrapped in" are one copy-paste apart.
- **A warning message never contains transcript content.** Messages carry kind names,
  indices, counts, line numbers, and pattern *names* only. A message reading
  `cue "…" is empty` would inject attacker-chosen text into a field that is persisted forever
  and rendered by every client, which is `CLAUDE.md` rule 8 reaching a surface nobody thinks
  of as a render. The warning collector's API takes a template identifier and numeric
  arguments rather than a free string, so this is a property of the interface and not of
  anyone's discipline.
- **Reversible at near-zero cost.** No stored data exists yet. Removing the kind later is a
  union member and a regex list.

## Alternatives considered

**Reuse `malformed_line` with a `subtitle_boilerplate:` message prefix.** Cheapest to write
and the worst to live with: it makes the message string load-bearing, so grouping code
string-matches a convention, and it pollutes a structural signal with a content signal at the
one place — the quality score — where the difference matters. Conventions smuggled through
free-text fields become permanent.

**Leave the vocabulary in `packages/providers`.** Then `packages/core` cannot own the Zod
schema for a persisted column, and the browser client has to import from a package whose
purpose is provider interfaces. The enum belongs beside the other fifteen.

**Add a separate `boilerplateMatches` field to `TranscriptParseResult`.** A second, parallel
channel for something the warning mechanism already models. It would need its own
persistence, its own response shape, and its own display path, and the first question anyone
asks is why it is not a warning.
