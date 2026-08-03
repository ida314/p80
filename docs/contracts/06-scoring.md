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

## 2. Candidate priority (§14.12)

Decides curriculum **admission**, never review scheduling (§14.13).

```
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

Weights sum to 1.0. `quality_penalties` is capped at 0.5 so a penalized item is demoted,
not silently deleted — rejection is a quality-gate decision (§14.10), not a scoring one.

### 2.1 Learner need
```
learner_need = 1 - P_known
```

### 2.2 Domain relevance
From occurrences in interest-tagged videos, weighted by
`effective_interest_weight` (`02-database.md` §1), plus user starring, plus usefulness
within the selected field. Log-scaled over occurrence counts.

### 2.3 General frequency utility
Higher-frequency language is worth more, with three qualifications: function words are
handled by the suppression policy, not here; very common already-known items are already
discounted through `learner_need`; rare domain terms can still rank highly through
`domain_relevance`.

### 2.4 Contextual diversity
Distinct videos, distinct sentences, distinct speakers (when known), distinct interest
categories, distinct grammatical surroundings. Distinct *videos* carries the most weight —
ten appearances in one video is not diversity (§4.5).

### 2.5 Phrase or construction value
Higher for conventional multiword expressions, verb-preposition frames, reusable sentence
frames, discourse markers, and high-value constructions.

### 2.6 Reuse potential
Breadth of compatible contexts, productivity of construction slots, corpus or dictionary
evidence, and LLM classification — the last with an inspectable rationale, never as an
unexplained number.

### 2.7 Source salience
Raised when the user bookmarked the timestamp, manually selected the expression, replayed
the segment repeatedly, marked the source important, or used "Approve and prioritize".

### 2.8 Quality penalties
Weak transcript alignment, definition uncertainty, excessive length, named-entity
behaviour, duplicate likelihood, narrowness, offensive ambiguity, unclear phrase boundary.

---

## 3. Quality gates (§14.10)

Gates run **before** scoring and either reject or quarantine. A rejected candidate never
reaches the inbox; a quarantined one is visible but cannot be approved until resolved.

Reject or quarantine when: transcript confidence too low; definition confidence too low;
no plausible meaning fits the context; duplicates an existing sense; proper name without
domain value; sentence unusably long; context does not clarify meaning; candidate is a
transcription error; ordinary compositional phrase with little reuse value; unresolved
sensitive or offensive content; language does not match the profile.

Every gate decision is recorded with its reason. Gate rejection rates feed §31.4 product
quality metrics — a gate that never fires and a gate that rejects everything are both
bugs, and neither is visible without this data.

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
