# ADR 0005 — LLM provider, model, and cost ceiling

**Status:** Proposed
**Date:** 2026-08-03
**Blocks:** Stage 7 (LLM-assisted disambiguation), Stage 8 (expression identification)

## Context

The LLM's role is deliberately narrow (spec §14.9, §16): given a candidate, its source
context, and a set of dictionary senses, select the most plausible attested sense and
write a learner-appropriate explanation. It is an **explainer and disambiguator, not the
lexical authority**, and P80 must remain fully usable with no provider configured
(spec §5.2).

That shapes the requirements more than raw capability does:

1. **Schema-constrained output**, with invalid results rejected rather than repaired
   (spec §16.4).
2. **No tools, no browsing, no code execution** (spec §16.4).
3. **Cheap per candidate.** §38.10 names cost scaling with transcript length rather than
   learning value as a principal risk.
4. **Measurable quality** against the hand-labelled evaluation set (spec §34.5).

## Decision

**Provider:** Anthropic API, via the official SDK behind the `LlmProvider` interface in
`docs/contracts/04-providers.md` §4.

**Model:** `claude-opus-5` as the evaluation baseline; `claude-sonnet-5` evaluated as the
production candidate once the eval set exists.

The order matters. Establish the quality ceiling on the stronger model first, then measure
what a cheaper model costs you in accuracy on the labelled set. Choosing the cheap model
first leaves you unable to tell whether disappointing extraction is a model limitation or
a prompt problem.

| Model | Input $/MTok | Output $/MTok |
|---|---|---|
| `claude-opus-5` | $5.00 | $25.00 |
| `claude-sonnet-5` | $3.00 ($2.00 introductory through 2026-08-31) | $15.00 ($10.00 intro) |
| `claude-haiku-4-5` | $1.00 | $5.00 |

## Implementation notes

These are the mechanisms that make the cost requirement achievable, and they need to be in
the design from the start rather than retrofitted:

- **Structured outputs** via `output_config.format` with a JSON schema. Assistant prefill
  is not supported on current models — do not reach for it to force JSON shape.
- **Message Batches API** for bulk ingestion: 50% off, and ingestion is not
  latency-sensitive. This is the single largest cost lever and it fits the job model in
  spec §27 almost exactly.
- **Prompt caching** on the stable system prompt and instruction block. The candidate,
  its context, and its dictionary senses vary per request and go *after* the cache
  breakpoint.
- **Adaptive thinking at low or medium effort** rather than disabled. Disabling thinking
  on `claude-opus-5` is only permitted at effort `high` or below and carries a risk of
  internal tags leaking into output; low effort is cheaper and does not.
- **Result caching** by `(canonicalForm, senseContextHash, promptVersion, modelId)`, per
  `docs/contracts/04-providers.md` §4. Re-processing a video must not re-bill every
  candidate.

## Cost ceiling

**To be set before any provider code is written.** Two numbers:

| Limit | Value | Enforced where |
|---|---|---|
| Per-video ingestion cap | _to be filled in_ | Worker refuses to start enrichment above the estimate |
| Monthly total cap | _to be filled in_ | Diagnostics warns; enrichment pauses |

`provider_calls` (`docs/contracts/02-database.md` §2) records tokens and cost per call from
the first commit, so §31.3's *LLM cost per retained item* is computable rather than
estimated. A cost metric added after the fact is a guess.

## Consequences

- API keys live in `.env.local` only, never in the database, a response, a log, or an
  error message (spec §32.3).
- Every prompt and response is written to `provider_calls` with keys redacted, satisfying
  §10.7 prompt inspection and §16.4 diagnostics with one mechanism.
- Prompt version and model ID are stored per definition, so a prompt change is measurable
  against the eval set instead of assessed by impression (spec §34.5 explicitly forbids
  tuning on anecdotes).
- Swapping providers later is an adapter change. The `LlmProvider` interface is the
  contract; nothing in the pipeline may import a provider SDK directly.
