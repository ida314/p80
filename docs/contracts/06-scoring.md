# 06 — Scoring and Learner Model

Every formula in the product, in one place. Source: original spec §14.11–§14.12, §17,
§22, §23.1, §24.2.

## 0. Rules for all scores

1. Every input feature is normalized to `0..1` before weighting.
2. Every composite score stores its component breakdown, not just the total. §36.3
   requires the user to be able to inspect why something was ranked as it was.
3. Every count-based feature uses **logarithmic scaling**, so one repetitive video cannot
   dominate: `norm(n) = log(1 + n) / log(1 + cap)`, clamped to `0..1`.
4. Weights live in one configuration module, not scattered through the pipeline, and are
   versioned with the extraction pipeline.
5. A score is never presented as an objective property of an item or video. All of these
   are learner-specific estimates.

---

## 1. Learner knowledge

### 1.1 Initial estimate (§14.11)

```
P_unknown = 1 - P_known
```

`P_known` for a lemma resolves in priority order — first hit wins:

1. `known_lexicon` row with source `user_marked` or `review_derived`
2. `known_lexicon` row with source `placement`
3. `known_frequency_bands` prior for the lemma's frequency band
4. Cognate status, where the language adapter supports it
5. Global default for unknown lemmas

Review history always outranks placement (§11.2: placement is only a starting estimate).

### 1.2 Updates (§17.1)

`P_known` **increases** with: successful delayed reviews, successful audio recognition,
successful productive recall, successful transfer, correct use in output.

`P_known` **decreases** with: lapses, repeated hesitation, failures across contexts,
dependence on hints, source-only recognition without transfer.

Two properties the implementation must preserve:

- A success at a *longer* delay moves `P_known` more than one at a short delay.
- A success in *transfer* context moves it more than one in source context.

Otherwise the model rewards cramming and source-bound memorization — the two failure
modes the product exists to prevent (§38.5).

### 1.3 Source dependence (§17.2)

```
source_dependence = original_context_success_rate - transfer_context_success_rate
```

Defined only once there are at least 3 transfer reps; `null` before that. Do not treat
missing data as zero.

High source dependence triggers: new-context cards, different occurrences, personalized
production, and reduced repetition of the exact source sentence.

---

## 2. Importance (§14.12)

Ranks observed units. Decides **visibility** — which units are promoted into the candidate
inbox (`07-extraction.md` §6) — and thereafter curriculum **admission**. Never review
scheduling (§14.13).

<!-- RESOLVED: spec §14.12 calls this "priority" and treats it as an admission score for
     candidates that already survived the §14.10 gates. Under ADR 0008 nothing is filtered
     on value, so this score is what decides whether a unit is ever seen at all. Renamed to
     "importance" to reflect that it now carries the whole burden. -->

```
importance =
    0.22 × learner_need
  + 0.18 × topical_centrality
  + 0.15 × domain_relevance
  + 0.13 × general_frequency_utility
  + 0.12 × contextual_diversity
  + 0.10 × unit_type_value
  + 0.06 × reuse_potential
  + 0.04 × source_salience
  - confidence_discount
```

Weights sum to 1.0. **They are placeholders.** Nothing has been tuned, because tuning
requires the evaluation corpus (ADR 0006). Treat the numbers as a starting point to be
fitted, and do not read precision into them that the data does not yet support.

`confidence_discount` — formerly `quality_penalties` — is capped at 0.5. It **demotes,
never removes**: under ADR 0008 there is no score at which a unit is discarded.

### 2.0 Three axes, stored separately

The components group into three axes that genuinely pull apart, and §0 rule 2 requires the
breakdown be stored rather than collapsed:

| Axis | Components | Asks |
|---|---|---|
| **In the language** | `general_frequency_utility`, `reuse_potential` | Is this broadly useful to any speaker? |
| **In the video** | `topical_centrality`, `contextual_diversity` | Is this what the source is actually about? |
| **To the user** | `domain_relevance`, `source_salience`, `learner_need` | Does this learner want and need it? |

*Techno* in a techno video has low general frequency and maximum centrality. *Und* is the
exact inverse. A single collapsed number cannot express the difference, and the user cannot
inspect a ranking they cannot decompose.

### 2.1 Learner need
```
learner_need = 1 - P_known
```

### 2.2 Topical centrality <!-- ADDED: not in the original spec -->

How much this unit is *what the video is about*, as opposed to incidental. Distinct from
`domain_relevance`, which measures fit against the user's declared interests — a video can
be squarely about a topic the user never tagged.

```
centrality = log_odds_ratio(count_in_video, count_in_background_corpus)
```

Log-odds with an informative Dirichlet prior, normalized to `0..1`. The prior matters: raw
ratios are unstable for units appearing once or twice, which is most of them.

Deterministic, no LLM, and it needs only the background frequency data ADR 0004 already
provides. This is the signal that promotes domain vocabulary a general frequency list would
bury — the reason *Berghain* outranks a rare-but-incidental word in the same transcript.

### 2.3 Domain relevance
From occurrences in interest-tagged videos, weighted by
`effective_interest_weight` (`02-database.md` §1), plus user starring, plus usefulness
within the selected field. Log-scaled over occurrence counts.

### 2.4 General frequency utility
Higher-frequency language is worth more, with three qualifications: function words are
handled by the suppression policy, not here; very common already-known items are already
discounted through `learner_need`; rare domain terms can still rank highly through
`topical_centrality` and `domain_relevance`.

### 2.5 Contextual diversity
Distinct videos, distinct sentences, distinct speakers (when known), distinct interest
categories, distinct grammatical surroundings. Distinct *videos* carries the most weight —
ten appearances in one video is not diversity (§4.5).

### 2.6 Unit type value
Higher for conventional multiword expressions, verb-preposition frames, reusable sentence
frames, discourse markers, and high-value constructions. Named `unit_type_value` rather
than the spec's `phrase_or_construction_value` because it now scores single words too —
under ADR 0008 every observed unit is ranked, not only phrases that survived a gate.

### 2.7 Reuse potential
Breadth of compatible contexts, productivity of construction slots, corpus or dictionary
evidence, and LLM classification — the last with an inspectable rationale, never as an
unexplained number.

For unenriched observed units the LLM component is simply absent; the score is computed
from the deterministic signals alone. Enrichment can only ever *raise* confidence in a
score, never gate its existence.

### 2.8 Source salience
Raised when the user bookmarked the timestamp, manually selected the expression, replayed
the segment repeatedly, marked the source important, or used "Approve and prioritize".

### 2.9 Confidence discount
Weak transcript alignment, definition uncertainty, excessive length, named-entity
behaviour, duplicate likelihood, narrowness, offensive ambiguity, unclear phrase boundary.

Capped at 0.5. A heavily discounted unit sinks in the queue and is still reachable through
browse (`07-extraction.md` §8). It is never removed.

---

## 3. Validity gates (§14.10)

<!-- RESOLVED: spec §14.10 rejects or quarantines on eleven conditions, most of which are
     value judgments. Under ADR 0008 only validity can drop a unit; every value judgment
     becomes a ranking signal in §2. Full rationale in `07-extraction.md` §3. -->

**Only four conditions drop a unit, and all four mean "this is not a language item."**

| Condition | Test |
|---|---|
| Not the target language | `tokens.is_target_language = false` |
| Pure numeral, URL, punctuation, markup residue | Token class from the language adapter |
| Non-lexical token | POS outside the adapter's lexical set |
| Transcription artifact | No dictionary match **and** no morphological parse **and** transcript confidence below threshold |

The conjunction on the last row is deliberate. Any single signal alone drops real
vocabulary: neologisms and loanwords miss the dictionary, proper nouns miss morphology, and
noisy captions depress confidence on perfectly good words.

Everything §14.10 additionally lists — too rare, proper name without domain value, ordinary
compositional phrase, low definition confidence, no plausible sense fits the context,
context does not clarify, sentence too long — is a **value signal** and affects §2 only.
Sensitive or offensive content is **flagged** for user decision. Duplicates are
**consolidated**, which is a different operation from rejection.

All eleven of §14.10's conditions are accounted for: four here, five as value signals, one
flagged, one consolidated.

Every gate decision is recorded with its reason. Rates feed §31.4: a gate that never fires
and a gate that drops everything are both bugs, and neither is visible without this data.

---

## 4. Video difficulty (§22)

Never computed solely from failures on extracted cards.

### 4.1 Lexical coverage
```
coverage = known_tokens / eligible_tokens
```
Eligible tokens exclude punctuation, proper names, pure numerals, non-target-language
tokens, and transcript artifacts. `known_tokens` sums `P_known` over eligible tokens —
computed against `known_lexicon` and `known_frequency_bands`, not against learning items.

Labels (§4.3) — product heuristics, not scientific law:

| Coverage | Label |
|---|---|
| ≥ 95% | productive |
| 90–95% | stretch |
| 85–90% | heavily scaffolded |
| < 85% | usually too difficult for the standard loop |

### 4.2 Other dimensions

| Dimension | Estimated from |
|---|---|
| Phraseological | unknown MWEs, unknown constructions, dense idiomatic sections, expressions per minute |
| Syntactic | mean sentence length, clause density, dependency depth where available, unusual construction count |
| Speech rate | `transcript words / transcript duration` — always labelled a **transcript-based estimate** (§22.4) |
| Transcript quality | parse warnings, unaligned regions, missing punctuation, overlapping timestamps, user correction count, language confidence |
| Personal | card success, audio-recognition success, transfer success, rewatch comprehension, hint use, source dependence, review latency |

### 4.3 Presentation
Show the dimensions, not one opaque number (§38.7). Transcript quality is displayed
**separately** from difficulty so a bad transcript is never mistaken for a hard video.
The overall label is explicitly learner-specific.

Recalculate after meaningful review changes, not on every review.

---

## 5. Struggle score (§23.1)

```
struggle_score =
    0.30 × recent_lapse_rate
  + 0.20 × consecutive_failure_score
  + 0.15 × transfer_gap
  + 0.15 × hint_dependence
  + 0.10 × response_latency_score
  + 0.10 × source_recognition_failure
```

### Failure diagnosis (§23.2)

| Diagnosis | Signal | Intervention |
|---|---|---|
| **Meaning** | fails across all card types | source sentence → short definition → contrast nearby meaning → test in a new sentence |
| **Audio recognition** | passes cloze/production, fails audio | replay short interval → show transcript → highlight reductions and boundaries → replay without transcript → different occurrence |
| **Form retrieval** | passes recognition, fails production | first-word hint → construction frame → complete cloze → produce personal sentence |
| **Context-bound** | succeeds in source, fails in transfer | different occurrence → changed cloze → personalized production |
| **Data quality** | erratic failures, prior edits, low extraction confidence | flag candidate, suspend card, reopen for correction, inspect transcript and selected sense |

Data-quality diagnosis matters most: without it, a wrong item is punished as a learner
failure forever (§38.4).

### Escalation ladder (§23.3)

1. Original 5–15 s source interval
2. Wider 30–90 s context
3. Different occurrence in the source bank
4. Changed cloze
5. Personal production
6. Full-video recommendation, when appropriate

---

## 6. Recommendation score (§24.2)

MVP recommends **only videos the user has already added** (§24).

```
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

`comprehensibility_fit` peaks near the stretch band rather than increasing with coverage —
a fully-understood video teaches nothing.

### Eligibility (§24.1)
Contains current struggle items; coverage not excessively low; acceptable transcript
quality; enough active targets to justify viewing; not just watched repeatedly; not marked
unhelpful.

### Forms (§24.3)
- **Clip** — the preferred default: `Review 01:42–02:18 · contains 3 items you recently missed`
- **Full video** — only when several active items appear throughout, coverage is suitable,
  the user previously understood the topic, and the video is not excessively long
- **Alternative context** — `Hear "run into" from another speaker`

Every recommendation stores and displays its reason (§36.6).

---

## 7. Metrics (§31)

### North-star
```
delayed_transfer_correct_per_hour
```

A qualifying event must: occur after a configured delay; use an unseen or materially
changed context; be completed without revealing the answer; preserve intended meaning.

### Tracked
- **Learning:** delayed audio-recognition accuracy, delayed productive recall, cloze
  accuracy, transfer success, source dependence, lapse rate, retention by item type /
  source / frequency band, correct use in output, video comprehension before and after.
- **Efficiency:** retained items per study hour, review seconds per retained item,
  new-item review debt, due-card completion rate, candidate approval and edit rates,
  definition and transcript correction rates, extraction cost per approved item, LLM cost
  per retained item.
- **Quality:** candidates rejected as useless / duplicate / bad definition / bad
  alignment, source interval replay success, failed jobs, provider failure rate,
  recommendation acceptance and helpfulness.

### Never optimized for (§31.5)
Videos added, cards generated, total review count, streak length, minutes spent, tokens
extracted. These reward workload rather than learning, and no dashboard should present
them as success.

---

## 8. Saturation and calibration <!-- ADDED: consequences of ADR 0008 -->

### 8.1 Saturation

Observed units deduplicate globally per language, so **new units per video falls as the
corpus grows**. Word counts follow Zipf and flatten within roughly a dozen videos; MWE
counts fall far more slowly, because the sequence space is combinatorially larger.

```
saturation = new_observed_units_per_minute, by unit type and language
```

This is a **diagnostic, not a success metric** — §31.5's prohibition on optimizing for
"number of extracted tokens" stands. Nothing should try to make this number go up. It is
read to answer three questions:

- Is a newly added source worth processing at all?
- Has this learner exhausted a channel or a domain?
- Is the MWE layer still productive after the word layer has flattened?

That last one is a direct empirical test of §4.4's claim that multiword expressions carry
disproportionate remaining value.

### 8.2 Calibration probe

Periodically mix a small number of randomly chosen **unsurfaced** observed units into the
candidate queue, labelled as probes. Record the approval rate separately from the ordinary
queue.

```
probe_approval_rate  ≈ ordinary_approval_rate   → ranking is burying useful units
probe_approval_rate  ≪ ordinary_approval_rate   → ranking is working
```

This is the only mechanism that detects a systematically mis-weighted ranker. ADR 0008
trades filtering's random loss for ranking's *systematic* burial, and systematic error is
the harder of the two to notice — without this probe, burial is exactly as invisible as
rejection was, and the architecture's central claim goes untested.

Probe outcomes feed §31.4 product-quality metrics.
