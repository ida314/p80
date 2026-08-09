/**
 * Item identity for the manual path (ADR 0020).
 *
 * `01-domain-model.md` §3.1 makes identity `(profileId, targetLanguage, normalizedForm,
 * itemType, senseKey)`. Two of those five have to be derived, and neither derivation has
 * the machinery it will eventually have.
 */

import { normalizeTranscriptText } from './text.js';

/**
 * `learning_items.normalized_form`.
 *
 * **Transport normalization only — no case folding.** The same reasoning as
 * `normalizeTranscriptText`: German capitalization is grammatical, `sie` and `Sie` are
 * different words, and every noun is capitalized. Folding case here would merge them and
 * the merge would surface at Stage 6 as a dictionary lookup that misses.
 *
 * Linguistic normalization belongs to `LanguageAdapter.normalizeOrthography`, which
 * arrives with the adapter in Stage 4. When it does, this function delegates rather than
 * being replaced — the transport pass still has to run first.
 */
export function normalizeItemForm(canonicalForm: string): string {
  return normalizeTranscriptText(canonicalForm);
}

/** Beyond this a sense key stops being human-readable, which is the only property it has
 *  that a random id would not. */
const MAX_SENSE_KEY_LENGTH = 48;

/**
 * `learning_items.sense_key`, derived from the user's meaning text (ADR 0020 §1).
 *
 * The contract derives it from a dictionary sense, or from an LLM gloss where there is
 * none. Stage 3 has neither, and the meaning the user typed is the only description of the
 * sense that exists. Slugified rather than stored raw because the key appears in URLs and
 * in the unique constraint, and because two meanings differing only in punctuation are the
 * same sense.
 *
 * Diacritics are folded here, unlike in `normalizeItemForm`, because this is a key and not
 * a form: `stoßen` and `stossen` as sense keys would be the same sense described twice.
 * An empty result — a meaning of nothing but punctuation — yields `unspecified`, which
 * collides with the next such item and produces the 409 that asks the user to say more.
 */
export function deriveSenseKey(meaning: string): string {
  const slug = meaning
    .normalize('NFKD')
    .replace(/[̀-ͯ]/gu, '')
    .toLowerCase()
    .replace(/ß/gu, 'ss')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, MAX_SENSE_KEY_LENGTH)
    .replace(/-+$/gu, '');
  return slug.length > 0 ? slug : 'unspecified';
}

/**
 * The score columns a manual item carries (ADR 0020 §3).
 *
 * The three ranking scores are zero as a **placeholder, not a judgement** — a manual item
 * bypassed admission entirely, so nothing before Stage 6 reads them. The two confidences
 * are 1.0 because the provenance is certain: a person selected the span and a person wrote
 * the gloss. That is a claim about where the text came from and not about whether it is
 * right; the gloss has no dictionary evidence and renders as *user-authored*, never as
 * *verified* (hard rule 11).
 */
export const MANUAL_ITEM_SCORES = {
  domainFrequencyScore: 0,
  contextualDiversityScore: 0,
  reusePotentialScore: 0,
  extractionConfidence: 1,
  definitionConfidence: 1,
} as const;

/** `definitions.provider` for a gloss the user typed. Not a provider name from
 *  `04-providers.md` — deliberately, so a query for dictionary-sourced definitions cannot
 *  pick these up by accident. */
export const USER_DEFINITION_PROVIDER = 'user';
