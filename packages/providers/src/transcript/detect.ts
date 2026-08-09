/**
 * Which parser to use.
 *
 * **The content decides, not the filename and not the client's `format` hint.** A `.srt`
 * file containing WebVTT is routine — subtitle tooling renames freely — so a filename-led
 * dispatch would send perfectly good files to the wrong parser. It is also the security
 * reading: `original_filename` is untrusted input, and letting it select a code path is
 * untrusted input reaching control flow, which is the same rule that keeps it out of
 * `storage_path`.
 *
 * A disagreement between the sniff and the hint is recorded as a warning, so the user finds
 * out their file is not what its extension claims.
 */

import type { TranscriptFormat } from '@p80/core';
import { preprocess } from './blocks.js';
import { pastedLineRatio } from './pasted.js';

/** SRT's signature: comma decimals, full `HH:MM:SS`, and an arrow. Nothing else looks like
 *  this. */
const SRT_TIMING = /^\s*\d{1,3}:\d{2}:\d{2},\d{3}\s*-->/m;
/** VTT timing with dot decimals, with or without the hours group. Catches the common
 *  "pasted the body without the header" case. */
const VTT_TIMING = /^\s*(?:\d{1,3}:)?\d{1,2}:\d{2}\.\d{1,3}\s*-->/m;
const VTT_HEADER = /^﻿?WEBVTT(\s|$)/;

/** Below this share of timestamped lines, a paste is prose with a few numbers in it. */
const PASTED_THRESHOLD = 0.6;

export type DetectionResult =
  | { ok: true; format: TranscriptFormat; headerless: boolean }
  | { ok: false; reason: 'internal_json_unsupported' | 'unrecognized' };

export function detectTranscriptFormat(content: string): DetectionResult {
  const normalized = preprocess(content);
  const trimmed = normalized.trim();

  // `internal_json` is in the format enum and in the database CHECK, but no §35 step asks
  // for a parser — it is Stage 13's export/import shape. Rejecting it by name is more
  // honest than half-supporting it, and tells the user which stage to wait for.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed);
      return { ok: false, reason: 'internal_json_unsupported' };
    } catch {
      // Not JSON after all — fall through and let the ladder decide.
    }
  }

  const firstLine = trimmed.split('\n')[0] ?? '';
  if (VTT_HEADER.test(firstLine)) return { ok: true, format: 'vtt', headerless: false };
  if (SRT_TIMING.test(normalized)) return { ok: true, format: 'srt', headerless: false };
  if (VTT_TIMING.test(normalized)) return { ok: true, format: 'vtt', headerless: true };
  if (pastedLineRatio(normalized) >= PASTED_THRESHOLD) {
    return { ok: true, format: 'pasted_timestamped', headerless: false };
  }
  return { ok: false, reason: 'unrecognized' };
}

/**
 * Evidence that the file was decoded with the wrong encoding *before it reached P80* — the
 * API receives an already-decoded string, so there is no decoder here to fall back.
 *
 * Two signatures: an explicit replacement character, and the Windows-1252-read-as-UTF-8
 * mojibake that for German means `Ã¤ Ã¶ Ã¼ ÃŸ`, which is extremely common in SRT files.
 *
 * **Warn; never repair.** Repairing would be hand-editing untrusted content, and it would
 * desynchronise the stored text from the checksummed file on disk. The user re-exports.
 */
export function detectEncodingDamage(content: string): number {
  const replacement = (content.match(/�/g) ?? []).length;
  const mojibake = (content.match(/Ã[¤¶¼Ÿ]|Â[ -¿]/g) ?? [])
    .length;
  return replacement + mojibake;
}
