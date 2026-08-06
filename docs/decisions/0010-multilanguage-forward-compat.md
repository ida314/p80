# ADR 0010 — Multi-language: two hooks now, laddering deferred

**Status:** Accepted
**Date:** 2026-08-03
**Relates to:** ADR 0001 (language pairs), ADR 0003 (dictionary)

## Context

ADR 0001 selects four target languages — German, Portuguese, Spanish, French — with English
as native. The natural extension is **laddering**: cards whose front and back can be any
pair of the learner's languages, with the "native" side rotating by proficiency. Learning
L3 through L2 is a real and effective technique, and for Portuguese/Spanish/French the
shared etymology makes cross-training unusually high-leverage. With four languages the total
review burden is roughly 4×, and laddering is one of the few mechanisms that makes it
sublinear, since one card trains two languages.

It is nonetheless premature, for four reasons.

**The blocker is data, not schema.** Making translations many-to-many is a modest change.
Aligning *senses* across languages is not. German *Zug* has around ten senses; which
Portuguese word maps to which? With English fixed as native there is one alignment
direction per language, drawn from the best-resourced Wiktionary edition. Many-to-many
across four languages means twelve directed pairs, most with dramatically thinner coverage.
Cross-lingual sense alignment is an open research problem, and ADR 0003 makes the dictionary
the lexical authority — so this lands on the layer that can least afford to be shaky.

**The card arithmetic is prohibitive.** Twelve directed pairs × three card types = 36 cards
per concept against 3 today. Restricting each target to the learner's top two languages
still gives 8×. The new-item allowance is 10 items/day — 30 cards now, 360 under
many-to-many. §38.1 already names card explosion a principal risk.

**It needs a second ranking system before the first is validated.** Any many-to-many design
requires a policy for *which pairs get carded*, stacked on top of the importance ranking
introduced in ADR 0008. Two unvalidated rankers at once.

**FSRS degrades.** "I know DE→EN but not DE→PT" is plausibly a distinct memory, so
scheduling state would need to be per (item, direction, skill). Many sparse states, each
receiving few reps — the condition under which FSRS estimates worst.

## Decision

**Defer laddering. Add two forward-compatibility hooks now**, both near-free today and
expensive to retrofit:

1. **Translations become a table, not columns.** `LearningItem`'s `naturalTranslation` and
   `literalTranslation` scalars hardcode a single native language into the item model.
   Replaced by `item_translations(item_id, language, kind, text, source, is_user_edited)`.
2. **Cards carry an explicit direction.** `cards` is keyed
   `(profile_id, item_id, card_type, prompt_language, answer_language)`. In MVP the pair is
   always (target, native), but the unique constraint and FSRS state are direction-aware
   from the first migration.

Nothing else: no proficiency weighting, no pair-selection policy, no cross-lingual
alignment.

## The cheaper path, when the time comes

Full laddering is not the only way to serve a polyglot. Because observed units are
language-scoped (ADR 0008), a shared concept identifier is simply an edge between units in
different languages. That alone buys:

- *"You already know this in Spanish"* when a Portuguese item surfaces
- Cognate detection feeding `P_known` — §14.11 already lists cognate status as an input and
  it is currently unimplemented
- False-friend warnings between Spanish and Portuguese, a real and specific failure mode
- A priority signal: a concept known in three languages and not the fourth is high-value and
  low-effort

That is a **linking** feature, not a **carding** feature. No cards, no sense alignment, no
explosion — and it is the substrate laddering would need anyway. Candidate for M4 or later,
after the core loop is validated.

## Consequences

- Two schema shapes land in the first migration rather than a later one.
- MVP behaviour is unchanged: one target and one native language active at a time, per
  ADR 0001's own framing.
- ADR 0001's readiness checklist must pass **per language** before that language is
  genuinely supported. Four selected languages means four checklists, and
  `LanguageAdapter` becomes a registry rather than a singleton.
- **Note for ADR 0003:** if laddering is ever pursued, ingesting more than the English
  Wiktionary edition becomes necessary. Not a change now — recorded so it is not a surprise.
- Deferred and explicitly out of MVP scope: proficiency ranking, pair-selection policy,
  cross-lingual sense alignment, concept links.
