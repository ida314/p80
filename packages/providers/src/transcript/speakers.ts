/**
 * Speaker-label extraction, in two passes.
 *
 * §14.2 requires speaker labels to be preserved. There are two ways a transcript carries
 * one, and they deserve very different amounts of trust.
 *
 * **Pass 1 — the `<v Name>` voice span.** WebVTT says this is a speaker, so it is one. No
 * heuristic involved.
 *
 * **Pass 2 — a `NAME:` prefix.** This is a guess, and the naive version of it is wrong in
 * German specifically. German sentences open with a colon constantly: *"Also: das ist
 * einfach."*, *"Fazit: es lohnt sich."*, *"Aber: nicht immer."* Treating every
 * capitalised-word-then-colon as a speaker would strip the first word off a large fraction
 * of ordinary cues and file it as a name.
 *
 * The fix is recurrence rather than a word list, applied **at the file level**:
 *
 * 1. A label is *confirming* if it is ALL-CAPS (the subtitling convention, unambiguous on
 *    its own) or if the identical label prefixes at least two distinct cues. A discourse
 *    marker appears once in that position; a speaker appears whenever they talk.
 * 2. If the file has at least one confirming label, it is a **speaker-labelled file**, and
 *    every candidate in it is accepted.
 *
 * Step 2 exists because per-label recurrence alone gets a common case wrong: in a dialogue
 * where Anna has ten lines and Bernd has one, Bernd is obviously a speaker, and the
 * evidence for that is the file's convention rather than Bernd's own frequency.
 *
 * This deliberately stays out of `LanguageAdapter` territory — it is a property of
 * transcripts, not of German, and it holds for the next language without a list to
 * maintain. Stage 0 step 9's function-word list would resolve the remaining ambiguity, but
 * making speaker detection depend on it would make it language-specific for a marginal
 * gain.
 *
 * The residual cost is stated rather than hidden: in a file that *does* use speaker
 * labels, a one-off `Also:` is taken as a speaker too. That is visible in a view already
 * showing speaker names, and the user can correct it. The opposite error — silently
 * removing the first word of ordinary sentences across an entire unlabelled transcript —
 * corrupts the text itself, and that is the direction that matters.
 */

/** Bounded at 31 characters after the first, so the regex stays linear over hostile input
 *  and a sentence with a colon halfway through a clause cannot match. */
const PREFIX = /^\s*-?\s*([\p{Lu}][\p{L}\p{N} .'’-]{0,31}):\s+/u;

const VOICE_SPAN = /^\s*<v(?:\.[^\s>]{0,40})*\s+([^>]{1,80})>/;

export interface SpeakerScan {
  /** Index-aligned with the input. `null` where no speaker was identified. */
  labels: Array<string | null>;
  /** Cue text with an accepted label removed. The label lives in `speaker_label`; leaving
   *  it in the text would duplicate it into every sentence Stage 4 reconstructs. */
  texts: string[];
}

/**
 * `voiceLabels` comes from pass 1, which runs during cue parsing because the tag must be
 * captured before `stripCueMarkup` deletes it.
 */
export function scanSpeakers(
  texts: readonly string[],
  voiceLabels: ReadonlyArray<string | null>,
): SpeakerScan {
  // Pass 2a: count how often each candidate label appears across the whole file. This is
  // why speaker detection cannot be done cue by cue.
  const frequency = new Map<string, number>();
  const candidates = texts.map((text, index) => {
    if (voiceLabels[index] != null) return null;
    const match = PREFIX.exec(text);
    const label = match?.[1]?.trim();
    if (label === undefined || label.length === 0) return null;
    frequency.set(label, (frequency.get(label) ?? 0) + 1);
    return { label, matched: match?.[0] ?? '' };
  });

  // Pass 2b: does this file use speaker labels at all? One confirming label is enough,
  // and it licenses every other candidate in the file.
  const isAllCaps = (label: string) =>
    label === label.toUpperCase() && /\p{Lu}\p{Lu}/u.test(label);
  const speakerLabelled = candidates.some(
    (candidate) =>
      candidate !== null &&
      (isAllCaps(candidate.label) || (frequency.get(candidate.label) ?? 0) >= 2),
  );

  const labels: Array<string | null> = [];
  const out: string[] = [];

  for (let index = 0; index < texts.length; index += 1) {
    const text = texts[index] ?? '';
    const voice = voiceLabels[index];
    if (voice != null && voice.length > 0) {
      labels.push(voice);
      out.push(text);
      continue;
    }

    const candidate = candidates[index];
    if (candidate === null || candidate === undefined) {
      labels.push(null);
      out.push(text);
      continue;
    }

    if (speakerLabelled) {
      labels.push(candidate.label);
      out.push(text.slice(candidate.matched.length));
    } else {
      labels.push(null);
      out.push(text);
    }
  }

  return { labels, texts: out };
}

/** Pass 1, applied to a cue's first payload line before markup is stripped. Returns the
 *  label and the line with the voice tag removed. */
export function extractVoiceSpan(line: string): { label: string | null; rest: string } {
  const match = VOICE_SPAN.exec(line);
  if (match === null) return { label: null, rest: line };
  const label = match[1]?.trim() ?? '';
  return {
    label: label.length > 0 ? label : null,
    rest: line.slice(match[0].length),
  };
}
