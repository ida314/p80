# ADR 0013 — Reuse from `bilingual-audio-generator`

**Status:** Accepted
**Date:** 2026-08-08
**Blocks:** Stage 2 (transcript noise), Stage 4 (sentence reconstruction), Stage 7 (LLM client)
**Source:** `bilingual-audio-generator` — a private sibling project by the same author, so no
licensing constraint applies. This ADR is written to stand on its own without access to it.

## Context

`bilingual-audio-generator` (BAG) turns a video into bilingual audio: every spoken sentence
followed by a synthesised translation. It is **a different product solving a different
problem**, and most of it is unusable here — its first stage downloads audio with `yt-dlp`,
which P80 forbids outright (`CLAUDE.md` rules 1–2).

But the two projects share one real subproblem. BAG's pipeline is:

```
fetch → asr → segment → translate → tts → plan → render
         └──────┬──────┘
        this stage is P80 Stage 4
```

BAG's stage 3 turns a flat array of timed tokens into sentences, because Whisper's own
segment boundaries are artifacts of its 30-second decoding window rather than linguistic
sentence ends. P80 Stage 4 step 1 is *"reconstruct sentences from transcript segments"*,
because a subtitle cue is not a sentence either (`01-domain-model.md` §1). Same problem,
different upstream noise. That code is ~500 lines, has 131 tests behind it, and is the
part of Stage 4 with the least specified design in P80's own contracts.

This ADR fixes **what is taken, what is adapted, and what is explicitly not taken** — the
last of those because two of BAG's patterns violate P80 rules and would otherwise get
copied by reflex along with the code around them.

## Decision

| BAG source | Disposition | Lands in | P80 destination |
|---|---|---|---|
| `pipeline/sbd.py` — boundary fusion | **Adapt** | Stage 4 | `packages/core` + `services/nlp` |
| `pipeline/segment.py` — constraint layer | **Adapt** | Stage 4 | `packages/core` |
| `models/timeline.py` — index-range invariant | **Validate only** | — | already in the contracts |
| `models/timeline.py` — `BoundaryInfo` provenance | **Take** | Stage 4 | `sentences` boundary columns |
| `pipeline/translate.py` — arbiter prompt design | **Take** | Stage 7 | `packages/providers` |
| `pipeline/translate.py` — batch→single fallback | **Take** | Stage 7 | `packages/providers` |
| `pipeline/translate.py` — `_parse_json` repair | **Reject** | — | violates rule 9 |
| `pipeline/asr.py` — `HALLUCINATION_PATTERNS` | **Take (list only)** | Stage 2 | transcript parser |
| `pipeline/asr.py` — everything else | **Reject** | — | violates rules 1–2 |
| `pipeline/fetch.py`, `tts.py`, `plan.py`, `render_audio.py`, `audio/*` | **Reject** | — | rules 1–2, spec §6 |
| `jobs/store.py`, `worker.py`, `config.py` | **Reject** | — | P80 already has these |

### 1. Sentence boundary detection — the main borrow (Stage 4)

Take the **three-signal noisy-OR fusion** from `sbd.py:score_boundaries`, whole:

```
score = 1 − (1 − text_prob) · (1 − punct_score) · (1 − pause_score)
```

Noisy-OR rather than a weighted average because the signals *corroborate* rather than
compete: a missing signal must count as "no information", not as evidence against a
boundary. A weighted average lets a silent gap veto an unambiguous full stop. This is a
formula, which is why it needs an ADR and a home in `06-scoring.md`.

Take with it: `has_terminal_punct` and its abbreviation backstop, `punct_confidence`,
`ambiguous_indices` (the gray zone), the `BoundaryDetector` protocol, and the whole
constraint layer in `segment.py` — `_enforce_hard_pauses`, `_merge_short`, `_split_long`,
`_splits_to_ranges`.

**Four adaptations are mandatory.** Each is a real difference between the two products, not
a porting detail:

- **The pause signal degrades from word-level to cue-level.** BAG has forced-alignment
  timing on every token. P80 has `transcript_segments.start_ms/end_ms` — timing at cue
  boundaries only, with nothing inside a cue. So `pause_after` is computable exactly where
  it matters most (*does this cue continue the previous sentence?*) and is simply absent
  everywhere else. Absent is the one thing noisy-OR handles correctly by construction,
  which is a large part of why this fusion survives the transplant at all. `pause_weight`
  and `pause_saturation` must be re-tuned against the ADR 0006 corpus regardless; BAG's
  0.35 / 0.5s were fitted to a different distribution.

- **`punct_confidence` keys on the transcript source, not the language.** BAG puts German
  in `STRONG_PUNCT_LANGS` at 0.95 because *Whisper* produces German punctuation with
  prosodic access. P80's transcripts are user-supplied and may be YouTube auto-captions
  with no punctuation at all. Reliability is a property of where the file came from, so the
  weight is chosen from `transcripts.source`, not from `profile.target_language`.

- **Drop the duration criterion from `_merge_short`, and drop `_mark_unusable` entirely.**
  `min_duration` and the skip-marking exist so BAG does not interrupt playback to translate
  "Yeah." P80 has no pause to protect: a two-word sentence is still a valid cloze context
  and still carries occurrences. Keep the `CONFIDENT_BOUNDARY` guard — a short segment
  closed by an unmistakable full stop is a real sentence — and keep `_split_long`, which
  earns its place under a different name: spec §14.10 lists *"sentence unusably long for a
  cloze"* as a ranking signal.

- **`segmentation_mode: "words"` does not come across.** Fixed-size chunking is a TTS
  pacing knob. P80 has no equivalent user need and it would produce sentences that are not
  sentences.

**Where the code goes.** The fusion, the constraints, and the abbreviation tables are pure
arithmetic and pure string work — they belong in `packages/core`, per the standing
invariant that domain logic is reachable only through `/api/*`. The one piece that cannot
follow is the `SaTDetector`: wtpsplit is a Python model, so it becomes a **second endpoint
on the existing NLP sidecar**, alongside `annotate`. That is exactly the boundary ADR 0002
drew — Python only where the models are — so this adds a dependency, not a process.

BAG's `PunctuationPauseDetector` comes across unchanged and matters more here than there.
It is the zero-dependency path that keeps Stage 4 testable before the SaT model is
downloaded, and it is the baseline SaT has to beat on the evaluation corpus. Requiring SaT
to demonstrate its improvement is cheaper to set up now than to retrofit.

### 2. The index-range invariant — validation, not code (no stage)

BAG's central invariant is that `Timeline.words` is the single source of truth; segments are
half-open index ranges over it and **nothing downstream may rewrite text**. Denormalised
`text`/`start`/`end` exist for debuggability and are rebuilt from the indices.

P80 already committed to the identical shape: `tokens` is immutable, spans are
reconstructible from `(sentence_id, start_index, end_index)`, corrections live in
`transcript_corrections` rather than mutating `transcript_segments`
(`02-database.md` §`tokens`, `07-extraction.md` §2.1).

**Nothing is taken here.** It is recorded because the convergence is evidence: the same
invariant was arrived at independently in a shipped system, for the same reason — an index
range cannot desynchronise from the timing the text is bound to. Anyone who later proposes
denormalising sentence text into an editable column should read this paragraph first.

What *is* taken is `BoundaryInfo`: per-sentence provenance recording `source`
(`punctuation` | `sat` | `pause` | `fused` | `llm` | `forced_max` | `eof`), the fused score,
the raw textual probability, the pause, and whether an LLM reviewed it. This satisfies
P80's own rule that **every score stores its breakdown**, and it is what makes
"sentence boundaries are acceptably accurate on the evaluation set" a measurable exit
criterion instead of an impression. It needs columns on `sentences` — see Consequences.

### 3. LLM interaction patterns (Stage 7)

Two patterns from `translate.py:make_arbiter` transfer directly, and both are about
*shape*, not code:

- **The model returns indices it can see, never text and never a count.** BAG numbers every
  token in the prompt (`[41]Wort [42]und`) and asks the model to return the subset of a
  given index list where a sentence genuinely ends. The model cannot silently rewrite a
  token bound to a timestamp, and it never has to tally "position 137" — it copies a number
  that is already on screen. Asking an LLM to count into a 200-token list is exactly the
  arithmetic it fails. P80 Stage 7 disambiguation and Stage 8 MWE proposal have the same
  structure and should use the same trick.
- **The returned set is intersected with what was asked** (`returned & set(candidates)`).
  The model does not get to invent boundaries at positions the cheap signals already
  settled. Generalises to: an LLM refining a deterministic result may only choose within
  the option set handed to it.

Also take the **batch → per-item retry → recorded warning** ladder: one bad batch degrades
to individual calls, one bad item records a warning and keeps the deterministic result. It
never fabricates and never fails the whole job — which is P80's rule that provider failure
preserves completed stages and never fabricates a fallback.

Two things do **not** come across:

- **`_parse_json`'s regex repair.** BAG tolerates fences and preamble by pulling the first
  `{...}` out of the response with a regex. That is hand-repair of invalid output, which
  `CLAUDE.md` rule 9 forbids. P80 uses schema-constrained decoding — vLLM guided decoding
  against the JSON Schema — and rejects what does not validate, with bounded retries. The
  right fix for a fenced response is to stop the model emitting fences, not to strip them.
- **`Authorization: Bearer {llm_api_key}`.** P80 holds no API keys (rule 14). vLLM on
  loopback needs none.

### 4. Transcript noise patterns (Stage 2 — this stage)

`asr.py` is forbidden wholesale, but its `HALLUCINATION_PATTERNS` list is not ASR-specific:
`subtitles by …`, `amara.org`, `opensubtitles`, `please subscribe`,
`ご視聴ありがとうございました`, bare `[Music]` / `♪`. Those appear in user-supplied VTT and
SRT files at least as often as in Whisper output, because a good share of them were *scraped
from the same subtitle corpora Whisper trained on*.

Take the regex list. Do **not** take the surrounding filter: BAG drops these segments
silently, and P80 does not drop transcript rows. The cue is stored like any other, and the
match raises a `ParseWarning` — the mechanism already declared in `packages/providers`
precisely so §14.2 parse warnings are recorded rather than swallowed. The user sees "3 cues
look like subtitle boilerplate" on the transcript-preview screen and decides.

The `no_speech_prob` / `avg_logprob` / repeat-window checks around it do not transfer;
user-supplied transcripts carry no such confidence signals.

## Consequences

- **New dependency: `wtpsplit` (SaT), in `services/nlp`, at Stage 4.** Arrives with spaCy
  and `de_core_news_lg`, so it is one more line in an existing `docs/SETUP.md` step rather
  than a new one. `sat-3l-sm` is ~140 MB. The sidecar keeps its narrow HTTP interface: one
  more endpoint, still stateless, still loopback-only.
- **`services/nlp` gains a second reason to exist.** ADR 0002 justified the sidecar on spaCy
  alone. It now carries two Python-only models, which strengthens the decision and raises
  the cost of ever reversing it.
- **`sentences` needs boundary-provenance columns.** `02-database.md` currently gives it
  `complexity_score` and `language_confidence` but no record of *how the boundary was
  decided*. Stage 4 adds them; the contract is amended there, not here.
- **`06-scoring.md` gains the fusion formula and its four tunables** (`sat_threshold`,
  `pause_weight`, `pause_saturation`, `llm_gray_zone`), with BAG's values recorded as
  starting points explicitly marked as un-tuned for this corpus.
- **The ADR 0006 Pass A labelling gains a second consumer.** Sentence-boundary accuracy is
  now measured against the same evaluation transcripts as extraction quality. Pass A does
  not label boundaries today; whether it needs to is the open question below.
- **The LLM arbiter is optional in Stage 4 and stays dark until Stage 7.** vLLM is expected
  down through Stage 6, and the fused score is the designed fallback — arbitration switched
  off is a supported configuration, not a degraded one. More free exercise of the §5.2
  path.
- Reversible. Every borrowed piece sits behind an interface P80 already declared
  (`BoundaryDetector`, `LanguageAdapter`, `ParseWarning`), and the fusion is ~200 lines of
  arithmetic. If SaT underperforms the punctuation-plus-pause baseline on German
  auto-captions, deleting it is a config change.

## Open questions

Both resolve at Stage 4, by measurement, not by argument.

- **Does the pause signal survive the drop to cue-level timing?** BAG's `pause_weight` of
  0.35 was fitted to word-level forced alignment. It is plausible that cue-boundary gaps —
  which reflect a caption author's line-breaking as much as the speaker's breathing — are
  weak enough that the honest setting is near zero, leaving SaT plus punctuation to carry
  it. Measure the fused score with `pause_weight ∈ {0, 0.15, 0.35}` against the corpus and
  record the number.
- **Does ADR 0006 Pass A need sentence-boundary labels?** Measuring boundary accuracy needs
  a gold segmentation of the evaluation transcripts. This is cheap relative to the ~500
  lemma labels already scoped — marking sentence ends on two transcripts is perhaps an
  hour — but it is *additional* to a pass that has not started. Decide before Pass A begins,
  because retrofitting means re-reading both transcripts.
