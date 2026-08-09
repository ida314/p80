/**
 * Subtitle-distribution boilerplate — ADR 0013 §4.
 *
 * The pattern list comes from `bilingual-audio-generator`'s hallucination filter, where it
 * catches Whisper reciting its training data. It transfers because a good share of that
 * training data *was* scraped subtitle corpora, so the same lines appear in user-supplied
 * VTT and SRT files at least as often as in ASR output.
 *
 * **The list transfers; the filter does not.** The source drops these segments silently.
 * P80 does not drop transcript rows — the cue is stored like any other and the match raises
 * a warning, which the preview screen surfaces as "3 cues look like subtitle boilerplate"
 * so the *user* decides. A false positive here costs a dismissed notice; a silent drop
 * removes a line from the source of truth with nothing to show for it.
 *
 * `packages/providers/test/boilerplate.test.ts` asserts that a matching cue is still
 * present in the parsed output, because "take the regex list" and "take the filter it was
 * wrapped in" are one copy-paste apart.
 *
 * Every pattern is anchored or bounded, and none nests a quantifier — they run over
 * attacker-controlled text.
 */

export interface BoilerplatePattern {
  /** Our identifier, safe to put in a warning message. The matched *text* never is. */
  name: string;
  pattern: RegExp;
}

export const BOILERPLATE_PATTERNS: readonly BoilerplatePattern[] = [
  // Attribution lines added by subtitle communities and distribution sites.
  { name: 'amara', pattern: /amara\.org/i },
  { name: 'opensubtitles', pattern: /opensubtitles/i },
  { name: 'subtitles_by', pattern: /\b(?:subtitles|untertitel|sous-titres)\s+(?:by|von|par)\b/i },
  { name: 'subtitled_by', pattern: /\b(?:subtitled|transcribed|captioned)\s+by\b/i },
  { name: 'translated_by', pattern: /\b(?:translation|übersetzung)\s*[:\-]/i },

  // Platform engagement prompts. These are spoken as often as they are written, so a match
  // is genuinely ambiguous — which is exactly why this warns rather than drops.
  { name: 'subscribe', pattern: /\b(?:please\s+)?subscribe\b/i },
  { name: 'abonnieren', pattern: /\babonnier(?:en|t)\b/i },
  { name: 'like_and_subscribe', pattern: /\blike\s+and\s+subscribe\b/i },

  // A closing courtesy that Whisper emits at the end of near-silent audio, and that
  // subtitle rips inherit.
  { name: 'thanks_for_watching_ja', pattern: /ご視聴ありがとうございました/ },
  { name: 'thanks_for_watching', pattern: /\bthank(?:s| you) for watching\b/i },

  // A cue that is *only* a sound marker carries no language, so it is not a transcript
  // line. Anchored: `[Music] Guten Tag` is a real cue with a marker on the front.
  { name: 'music_marker', pattern: /^\s*[[(【]?\s*(?:music|musik|musique|applause|applaus)\s*[\])】]?\s*$/i },
  { name: 'music_note', pattern: /^\s*[♪♫\s]+$/ },
];

export function detectBoilerplate(text: string): string | null {
  for (const { name, pattern } of BOILERPLATE_PATTERNS) {
    if (pattern.test(text)) return name;
  }
  return null;
}
