# ADR 0008 — Recall-first extraction

**Status:** Accepted
**Date:** 2026-08-03
**Diverges from:** spec §14.10 (quality gates), §27.1 (job ordering)
**Blocks:** Stages 5–9

## Context

Spec §14.10 runs quality gates *before* scoring: candidates are rejected or quarantined,
and only survivors reach the candidate inbox. §38.1 frames this as the mitigation for card
explosion, alongside human approval, daily limits, and a priority threshold.

The model is wrong for this product, and the reason is an asymmetry the spec never
addresses:

- A **false positive** costs one keystroke. It is visible in the inbox, and the cost is
  bounded and immediate.
- A **false negative** is invisible. There is no query for "items that should have been
  proposed but weren't." It cannot be audited, sampled, counted, or noticed — not by the
  user, and not by the metrics in §31.4.

Filtering on value therefore trades a recoverable error for an unrecoverable one.

Examined individually, only about three of §14.10's eleven conditions are genuine validity
checks. The rest are value judgments in the shape of checks — and each one has a failure
case that matters. "Proper name without domain value" would drop *Berghain* and *Kraftwerk*
from a German techno video: precisely the domain-specific vocabulary the product exists to
teach.

## Decision

**Capture is complete. Ranking decides visibility. Nothing is dropped for being low value —
only for not being a language item at all.**

Three tiers, defined in `docs/contracts/07-extraction.md`:

| Tier | Contents | Enriched | Visible |
|---|---|---|---|
| Observed unit | Every eligible lexical unit in every video | No | Browse/search only |
| Candidate | Promoted above the surfacing threshold | Yes, on promotion | Candidate inbox |
| Learning item | User-approved | Yes | Items, review |

Four supporting decisions:

1. **Validity gates hard-drop; value signals only rank.** Full split in `07-extraction.md`
   §3. Sensitive content is flagged rather than dropped; duplicates are consolidated rather
   than rejected.
2. **Enrichment is lazy.** Dictionary and LLM run on promotion, per candidate — never
   across the pool. This inverts §27.1's ordering and is a *precondition* of the decision,
   not an optimization: eager enrichment over ~800 units per video realizes §38.10's cost
   risk directly.
3. **Surfacing is a global ranked queue plus a per-video floor** (top 5 of each newly
   ingested video). The inbox is a cursor, not a list to empty. The floor exists so that
   ingesting an easy video still produces visible evidence the job ran.
4. **Observed units persist forever**, scoped by `(target_language, lemma, pos)` rather than
   by profile.

## Alternatives rejected

**Keep §14.10 as written.** Preserves inbox precision, which protects the human approval
gate from becoming a reflex. Rejected because the protection is achievable by *ranking*
without paying for it in permanent loss.

**Filter, but log rejections for audit.** Cheaper than full capture and restores some
visibility. Rejected because a rejection log is not promotable — it cannot benefit from
recurrence across videos or from the learner's knowledge changing, so the item is still
effectively lost.

**Archive unsurfaced units after N videos.** §38.1 lists "candidate expiry or archive."
Rejected because a unit archived at video 20 cannot be promoted by its third sighting at
video 40, which reintroduces exactly the invisible loss this ADR exists to remove. Growth is
self-limiting anyway — see saturation, below.

## Consequences

- **Ranking becomes a single point of failure with a worse failure mode.** A bad gate loses
  items randomly; a bad weight buries an entire *class* silently and consistently.
  Systematic bias is harder to detect than random loss. Mitigated by storing score
  components separately (§36.3) and by the calibration probe below.
- **A calibration probe becomes mandatory.** Periodically mixing random unsurfaced units
  into the queue is the only mechanism that detects a mis-weighted ranker. Without it,
  burial is as invisible as rejection was and the central claim goes untested.
- **The observed pool must be browsable.** If the tail is unreachable, soft filtering has
  become hard filtering that also pays for storage.
- **The evaluation corpus must become exhaustive** — "buried at rank 300" is unmeasurable
  from positive labels alone. See ADR 0006.
- **Saturation becomes a real metric.** Because units deduplicate globally per language, new
  units per video falls as the corpus grows, which bounds table growth without an expiry
  policy and answers "is this new source worth adding?"
- **`RejectionReason` becomes human-only.** The pipeline no longer writes it.
- Storage grows, in the cheapest possible way — the observed tier is key:value plus
  counters, and holds pointers rather than copies.
