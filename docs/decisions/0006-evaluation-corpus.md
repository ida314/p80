# ADR 0006 — Hand-labelled evaluation corpus

**Status:** Accepted — two videos, two passes
**Date:** 2026-08-03
**Decided:** 2026-08-07
**Depends on:** ADR 0001 (German), ADR 0011 (second label axis)
**Blocks:** Stages 4, 5, 7, 8 — every stage whose exit criteria are about extraction quality

## Context

Spec §35 Stage 0 step 10 requires a hand-labelled evaluation transcript, §34.2 requires a
version-controlled fixture corpus with expected results, and §34.5 requires a labelled
evaluation set with the instruction: **"Do not modify prompts based only on a few
anecdotal examples."**

Without it, several stages have exit criteria that cannot actually be evaluated:

| Stage | Exit criterion | Needs ground truth |
|---|---|---|
| 4 | "Sentence boundaries are acceptably accurate on evaluation set" | explicitly |
| 5 | "Duplicate and artifact rates meet internal thresholds" | yes — a rate needs a denominator |
| 7 | "Hallucinations are measurable" | yes — measurable against what? |
| 8 | "Expressions are not merely arbitrary word spans" | yes |

This is the item in Stage 0 most likely to be skipped: it is manual, unglamorous, and
blocks nothing on the day it is due. It is also the one whose absence is most expensive,
because by the time its absence hurts — somewhere in Stage 5 — three stages of extraction
tuning have already happened on impressions.

## Decision

**Build Pass A during Stage 0, before Stage 1 begins.** Language: German (ADR 0001).

**Scope: two 10-minute videos from the same channel**, hand-annotated, split into two
passes. Breadth of phenomena matters more than volume, but two videos are required for a
reason that is structural rather than a matter of taste.

### Why two videos, and why the same channel

ADR 0011 makes cohesion and completeness **undefined at one occurrence** — branching
entropy over a single observation is exactly zero and NPMI is unstable. In a single
10-minute transcript nearly every span occurs exactly once. So a one-video corpus can tune
the **shrinkage priors** and nothing else; it structurally cannot tune the measured half of
unithood, which is the part the ADR exists to specify.

Same channel, not merely two videos. Cross-video recurrence is what
`context_diversity` and the 3-video recurrence promotion threshold both consume, and across
two unrelated videos the only thing that recurs is high-frequency glue like *auf jeden
Fall*. Shared speaker, topic, and register are what produce recurring *content* expressions
worth measuring.

### Two passes

Split at the point where the labels are actually needed, not by category tidiness.

| | Pass A | Pass B |
|---|---|---|
| **When** | Now, Stage 0, ~1 day | A **Stage 8 exit criterion** — not a to-do item |
| **Material** | Video 1 | Video 2, plus span labels across **both** videos |
| **Labels** | Exhaustive word labels, `worth_learning` + reason | Unithood and idiomaticity, both axes, disagreement recorded |
| **Spans** | Marked, not scored | Scored on both axes |
| **Unblocks** | Stages 4, 5, 7 | Stage 8 |

Pass A is what is blocking today. Pass B's span labels are not needed until Stage 8, and by
then the extractor exists, which makes the stratified sample below possible to draw at all.

Recording Pass B as an **exit criterion** rather than a task is deliberate: an exit
criterion cannot be quietly skipped the way a backlog item can, which is the specific
failure this ADR was written to prevent.

### Exhaustive is defined per axis

"Label everything" is unambiguous for words and incoherent for spans. Both are stated so
neither is guessed at:

- **Words — truly exhaustive.** Every eligible lemma in the transcript, roughly 500 for a
  10-minute video. Including the ones that are obviously not worth learning.
- **Spans — human-nominated plus a stratified sample.** Every span a proficient speaker
  nominates unprompted, plus ~200 machine-generated spans sampled across the unithood score
  range. Literal exhaustiveness is ~7,500 spans per video at *n* = 2..6, which is not a day
  of work and would not be more informative — the middle of the distribution is where the
  score is uncertain, and stratifying puts the labelling effort there.

The stratified sample must be drawn from the extractor's actual output at Stage 8, and the
sampling seed and score bins committed alongside the labels. A sample nobody can reproduce
is not a measurement.

**Coverage** — the corpus must contain examples of every category in §34.2. Checked across
**both videos combined**, not per video; this is one of the things two videos buys, since a
single 10-minute clip rarely contains all eleven naturally:

- Normal sentences
- Subtitle line breaks splitting a sentence
- False starts and self-corrections
- Slang
- Named entities
- Multiword expressions
- Ambiguous words with more than one plausible sense in context
- Overlapping captions
- Missing punctuation
- Code-switching
- Offensive or sensitive language

**Labels — Pass A**, recorded for every eligible lemma, not only the good ones:

```
canonical form
item type          (word | multiword_expression | construction)
sense              (short gloss, and the dictionary sense ID once ADR 0003 lands)
register
occurrence span    (start/end within the sentence, plus timestamps)
worth_learning     (yes | no) — with a one-line reason for "no"
```

Spans are **marked but not scored** in Pass A — the boundary is recorded so Pass B has
something to score, without paying for the two-axis judgement before Stage 8 needs it.

The `worth_learning: no` rows are the ones that make the corpus useful. Precision is what
prevents card explosion (§38.1), and precision cannot be measured from positive examples
alone.

**Labels — Pass B** <!-- ADDED: ADR 0011 -->, added to every span in the Pass A nominations
and the stratified sample:

```
unithood       (yes | no | contested) — is this a reusable unit?
idiomaticity   (yes | no | contested) — is the meaning derivable from the parts?
```

**The two axes are labelled independently and must not be collapsed.** This is the whole
point of ADR 0011 and the most likely labelling error: *warten auf* is unithood-yes,
idiomaticity-no; *ins Gras beißen* is both; a mid-sentence fragment is neither. An annotator
who answers "is this an expression?" once has produced a corpus that cannot tune either
score.

### Labels must be exhaustive <!-- strengthened by ADR 0008 -->

Under recall-first extraction, nothing is rejected on value — units are *buried* by
ranking instead. Burial is only detectable if the corpus labels **every** unit in the
transcript, not just the ones worth learning.

> "Was something important buried at rank 300?" cannot be answered from positive labels.

This upgrades `worth_learning: no` from a nice-to-have to the load-bearing half of the
corpus, and changes the metric from precision@K to **rank correlation against human
judgement** across the full transcript.

For spans, exhaustiveness is the stratified definition given above, not literal coverage —
and the stratified sample preserves the same property, because sampling across the *whole*
score range includes the low-scoring bins where burial would show up.

### MWE boundary labels

Label spans as well as words, and **record annotator disagreement rather than resolving it
away**. Boundary disagreement is high even among proficient speakers (ADR 0009), so a
corpus that hides it will report false regressions when the extractor picks a defensible
alternative boundary. Where a boundary is genuinely contested, record both and mark it.

Both axes accept `contested`, for the same reason. A span may be uncontroversially a unit
whose idiomaticity is genuinely arguable; forcing a binary there manufactures ground truth
that does not exist and the tuning inherits the fiction.

**Storage:** `fixtures/eval/de/` — transcripts plus label files, all committed. This is
version-controlled test data, not scratch work.

```
fixtures/eval/de/
  video-1/transcript.vtt      video-2/transcript.vtt
  video-1/labels-words.jsonl  video-2/labels-words.jsonl    ← Pass A
  video-1/labels-spans.jsonl  video-2/labels-spans.jsonl    ← Pass B
  sampling.json                                             ← seed + score bins
```

## Judging protocol (§34.6)

For each labelled candidate, a proficient speaker answers:

1. Is this a coherent learning item?
2. Is the selected meaning correct in context?
3. Is the register correct?
4. Is the phrase reusable?
5. Is the source interval appropriate?
6. Would this be worth a flashcard?

Questions 1 and 4 are the word-level analogue of the unithood/idiomaticity split and should
be answered separately for the same reason — a reusable phrase and a coherent learning item
are not the same judgement.

## Consequences

- Extraction stages gain real exit criteria: precision, recall, and duplicate rate against
  the labels, tracked over time.
- **Stage 8 gains an exit criterion it did not have: Pass B complete.** This is where the
  labelling obligation is enforced, and it is the mechanism preventing the span work from
  becoming permanently deferred.
- **ADR 0011's open question 1 becomes answerable at Stage 8** — dictionary-path idiom
  recall is measured against the Pass B idiomaticity labels, which is the decision rule that
  ADR records rather than a debate.
- Prompt changes in Stage 7 become measurable — which is what §34.5 demands.
- The corpus needs occasional extension as new failure modes appear. Adding a case when a
  bug is found is the cheapest possible regression test, and each addition should
  reference the bug.
- **The corpus cannot be generated by an LLM.** Its purpose is to be independent ground
  truth for judging LLM output; generating it from the thing being judged makes every
  downstream measurement circular and reassuring.
