# ADR 0005 — LLM provider, model, and resource ceiling

**Status:** Accepted — local inference only
**Date:** 2026-08-03
**Decided:** 2026-08-07 — **the drafted Anthropic-API decision is withdrawn.** See
*Revision: local-only* below for what changed and why.
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

**All inference runs locally. There is no cloud provider, and no cloud adapter is
written.**

| | |
|---|---|
| **Hardware assumed** | A unified-memory workstation with ~128 GB available to the model — ample capacity, modest memory bandwidth |
| **Serving** | vLLM, OpenAI-compatible HTTP endpoint, loopback only |
| **Interface** | `LlmProvider` (`docs/contracts/04-providers.md` §4), unchanged in shape |
| **Model** | Largest German-competent instruct model that fits and sustains usable batch throughput; see *Model selection* |

`LlmProvider` remains an interface, so a cloud adapter stays *possible*. None is written,
configured, or tested. "Possible later" is not the same as "present but unused", and the
difference is the whole security consequence below.

### Why local-only is a strengthening, not a compromise

Spec §7.2 and §32 make P80 local-first, and the Anthropic path was the single largest
exception to it. Removing it collapses several requirements into nothing to enforce:

- **No API key exists.** `CLAUDE.md` §2 rule 14 and spec §32.3 — keys never in the
  database, a response, a log, or an error message — become **structurally** satisfied
  rather than satisfied by discipline. There is no secret to leak.
- **No external request exists.** Spec §15's disclosure requirement and rule 15's "every
  external request is identifiable and disclosed" have an empty list for the LLM path.
- **Transcript text never leaves the machine.** §16.4 treats transcripts as untrusted
  *input*; they are also private *content*, and local-only is the only configuration in
  which that is true unconditionally.
- **The §5.2 degraded-mode test gets easier to keep honest.** "Works with no LLM
  configured" now means "works with the sidecar down", which is a state that occurs
  naturally rather than one that must be simulated.

### Model selection — same logic, different currency

The drafted ordering still holds, with time substituted for money: **establish the quality
ceiling on the largest model that fits, then measure what a smaller one costs you in
accuracy on the labelled set.** Choosing the fast model first leaves you unable to tell
whether disappointing extraction is a model limitation or a prompt problem.

The binding constraint on this class of machine is **bandwidth, not capacity**. 128 GB holds
a large model comfortably; token generation on a large dense model is slow. That points at
either a
mixture-of-experts model with a small active-parameter count, or a quantized dense model in
the 30–70B range. Which one is a Stage 7 measurement against the ADR 0006 corpus, recorded
as a number, not settled here by impression.

Two model requirements that are *not* negotiable and must be checked before Stage 7:

- **Genuine German competence**, not incidental multilingual coverage. The output is a
  German-to-English explanation with register and dialect judgements; a model that is
  merely tokenizer-compatible with German will produce fluent, confident, wrong register
  labels — the exact failure §16.5 and rule 12 exist to prevent.
- **Grammar-constrained decoding support in vLLM** for the model's architecture.

## Implementation notes

These are the mechanisms that make the resource requirement achievable, and they need to be
in the design from the start rather than retrofitted:

- **Structured output via vLLM guided decoding** (JSON-schema-constrained, xgrammar or
  equivalent). This is *stronger* than the cloud structured-output path it replaces:
  constraint is applied at the decoder, so malformed JSON is impossible rather than
  rejected after the fact. §16.4's bounded-retry rule still applies to *semantically*
  invalid output — a schema-valid response naming a `senseId` that does not exist is still
  rejected and never hand-repaired.
- **Continuous batching replaces the Message Batches API** as the throughput lever.
  Enrichment is a job, not a request — §27's job model is already batch-shaped, and vLLM's
  scheduler is most efficient when handed many candidates at once. Submit a video's
  promoted candidates as one batch rather than a loop of single calls.
- **Lazy enrichment (ADR 0008) still matters, for a different reason.** Enrichment runs on
  promotion, per candidate — not across the observed pool. The cost is now hours of GPU
  time rather than dollars, and ~800 observed units per video enriched eagerly is still
  unaffordable, just in a currency you pay in latency. Capture-everything and
  enrich-lazily stand or fall together.
- **A second, distinct LLM use: batched sentence-level MWE proposal** (ADR 0009, funnel
  layer 5). *"List the multiword expressions in these sentences"* over ~20 sentences per
  call is roughly 5 calls per video, restricted to high-centrality sentences. Separately
  prompt-versioned and separately evaluated from definition enrichment — the two have
  different failure modes and should not share a quality number.
- **Prefix caching** on the stable system prompt and instruction block. vLLM caches the
  shared prefix across a batch, so the candidate, its context, and its dictionary senses
  must come *after* the stable block. Same prompt discipline the cloud path needed, for the
  same reason.
- **Result caching** by `(canonicalForm, senseContextHash, promptVersion, modelId)`, per
  `docs/contracts/04-providers.md` §4. Re-processing a video must not re-run every
  candidate. This now saves wall-clock rather than money, which is the scarcer resource.
- **The vLLM server binds to loopback only**, under the same §32.5 rules as the NLP sidecar
  from ADR 0002. P80 now runs five local processes: API, worker, TUI, web, NLP sidecar —
  plus vLLM, which is expected to be long-lived and managed outside `pnpm dev`.

## Resource ceiling

The dollar ceiling is meaningless under local inference and is replaced. Local tokens are
free; **local time is not**, and a runaway job is still a runaway job.

| Limit | Value | Kind | Enforced where |
|---|---|---|---|
| Per-video candidate cap | 100 | **Hard** — worker refuses to start | `check()` before enrichment begins |
| Per-job wall-clock ceiling | 45 min | **Hard** — worker pauses, job stays resumable | Worker loop, checked between batches |
| Monthly inference hours | 40 h | **Soft** — diagnostics warn only | Diagnostics surface |

The monthly limit warns rather than pauses, deliberately. Pausing a local job spends
nothing and protects nothing; the number exists so that "enrichment has quietly been
running for three days" is visible, not so that it is punished.

All three are defaults, reviewable at Stage 7 once real throughput is measured. They are
**set** rather than left blank, because a ceiling added after the fact is a guess dressed as
a policy.

### Enforcement: `uselimit`

Enforcement uses **`uselimit`** (`@uselimit/core`, MIT — a sibling project by the same
author, not yet published to npm; see the three costs below). Its
`check()` → operate → `consume()` shape maps onto the worker's enrichment loop exactly, and
its immutable usage events are the same idea as `provider_calls` — refuse early when the
budget is gone, and only charge for work actually done.

Mapping onto a single-user local app:

| uselimit concept | P80 |
|---|---|
| `tenantId` | `profile_id` — one tenant in MVP, but the field already exists |
| `feature` | `enrich_candidate`, `mwe_propose` — separately quota'd, matching their separate prompt versions |
| credits / `amount` | Unitless counters: candidates for the hard cap, seconds for wall-clock |
| plan | One local plan, limits above, `monthly` reset for the soft ceiling |

**A SQLite `StorageAdapter` will be written upstream in the `uselimit` repo** as
`@uselimit/storage-sqlite`, unblocking that project's Phase 2 and P80 at the same time.
P80 consumes it as a workspace link until it is published.

Three honest costs of this dependency, recorded so they are not discovered at integration:

1. **Only `InMemoryAdapter` ships today**, and it is single-process and volatile. P80's API
   and worker are separate processes and both touch the budget, so in-memory is not viable
   and the SQLite adapter is a **prerequisite**, not an improvement.
2. **`consume()` is documented as unsafe against concurrent double-spend** without a
   transactional adapter. The SQLite adapter must therefore do check-and-deduct in a single
   transaction. This is the substantive part of the upstream work, not the schema.
3. **`uselimit` is not on npm.** Setup gains a clone-and-link step against a local checkout,
   and that pinned path is a reproducibility wrinkle to remove once published.

`provider_calls` (`docs/contracts/02-database.md` §2) still records tokens and latency per
call from the first commit, so §31.3's *cost per retained item* remains computable — now
denominated in seconds of inference rather than dollars.

## Revision: local-only

This ADR was drafted selecting the Anthropic API with `claude-opus-5` as an evaluation
baseline, a pricing table, and two blank dollar ceilings. **That decision is withdrawn in
full.** What replaced it and why:

| Drafted | Now | Reason |
|---|---|---|
| Anthropic API behind `LlmProvider` | Local vLLM behind `LlmProvider` | Capable local hardware available; local-first (§7.2) has no reason to make an exception |
| `claude-opus-5` ceiling → `claude-sonnet-5` production | Largest fitting local model → measure smaller | Same method, currency changed from dollars to wall-clock |
| Message Batches API, 50% off | vLLM continuous batching | Throughput lever, no billing dimension |
| Prompt caching | vLLM prefix caching | Same prompt discipline, different mechanism |
| `output_config.format` JSON schema | vLLM guided decoding | Constraint moves to the decoder — strictly stronger |
| Dollar ceilings, blank | Candidate + wall-clock ceilings, set | Dollars no longer the scarce resource |
| API keys in `.env.local` | No keys at all | Nothing to store |

The pricing table is deleted rather than kept for reference; a stale price list in an
accepted ADR is a trap for a future reader.

## Consequences

- **`StructuredLlmResponse.costUsd` is now always `null`.** The field stays for interface
  stability but is dead under local inference; `latency_ms` in `provider_calls` is the live
  cost signal. Do not compute a synthetic dollar figure — an invented number is worse than
  an absent one.
- **No API keys anywhere in P80.** `.env.local` still exists for local endpoint
  configuration (vLLM base URL, model ID), which is not a secret.
- Every prompt and response is written to `provider_calls`, satisfying §10.7 prompt
  inspection and §16.4 diagnostics with one mechanism. Redaction on write remains, though
  there is now nothing sensitive to redact.
- Prompt version and model ID are stored per definition, so a prompt change is measurable
  against the eval set instead of assessed by impression (spec §34.5 explicitly forbids
  tuning on anecdotes).
- **The §5.2 no-LLM path becomes the likely default during Stages 1–6**, since vLLM will
  often simply not be running. This is good: the degraded path gets exercised continuously
  instead of once in an integration test.
- Swapping models is a config change; swapping serving stacks is an adapter change. Nothing
  in the pipeline may import an inference client directly.
- **New dependency: `@uselimit/core` plus an upstream SQLite adapter.** Recorded here rather
  than in a separate ADR because it exists solely to enforce this ADR's ceiling.
