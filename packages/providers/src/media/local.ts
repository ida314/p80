/**
 * The `local_media` adapter — MVP's only media path since ADR 0015.
 *
 * P80 references a media file the user already holds. It reads that file; it never
 * acquires it, never copies it, and never claims ownership of it.
 *
 * **The hard media rules are visible in what this file does not contain.** There is no HTTP
 * client, no downloader, and no code path that produces media P80 was not given. `validate`
 * decides from the path's structure alone and does not touch the disk — whether the file is
 * readable, how long it is, and what its bytes hash to are all questions for the ingest job,
 * which has a place to report failure. `test/media-policy.test.ts` asserts that adding a
 * video performs zero outbound requests, which is only true because there is nothing here
 * to make one.
 *
 * The interface earned its keep once already: removing the YouTube adapter was a deletion,
 * not a refactor, because nothing above `MediaSourceAdapter` had learned anything about it.
 * Keep it that way — paths, byte ranges, and container formats stop here.
 */

import {
  MEDIA_PATH_MESSAGES,
  buildMediaDescriptor,
  resolveMediaPath,
  type MediaDescriptor,
  type MediaSourceKind,
  type TranscriptFormat,
} from '@p80/core';
import type {
  MediaSourceAdapter,
  TranscriptParseResult,
  ValidationResult,
} from '../index.js';
import { parseTranscriptContent } from '../transcript/index.js';

export class LocalMediaSourceAdapter implements MediaSourceAdapter {
  readonly kind: MediaSourceKind = 'local_media';

  /** The whole point: these are bytes the user already holds. */
  readonly supportsLocalMedia = true;

  /** ADR 0016. By transcribing the media locally — never by fetching a transcript from
   *  anywhere, which rule 2 forbids and which no code here could do. */
  readonly supportsAutomaticTranscriptAccess = true;

  constructor(private readonly mediaRoot: string) {}

  /**
   * Structural and containment only. This never opens the file.
   *
   * Existence is checked by the caller before the row is written — a path to nothing is a
   * mistake worth reporting immediately — but reading the file is the ingest job's work.
   * Hashing a 2 GB file is seconds, and seconds do not belong on a request that is
   * supposed to return a job reference.
   */
  async validate(input: { path: string }): Promise<ValidationResult> {
    const resolved = resolveMediaPath(input.path, this.mediaRoot);
    if (!resolved.ok) {
      return {
        valid: false,
        externalVideoId: null,
        relativePath: null,
        errors: [MEDIA_PATH_MESSAGES[resolved.reason]],
        reason: resolved.reason,
      };
    }
    return {
      valid: true,
      // ADR 0018: identity is the content hash, and it is not known yet. Two-phase by
      // design — the ingest job computes it, so a duplicate is detected in the worker and
      // resolves by re-pointing rather than by failing an insert.
      externalVideoId: null,
      relativePath: resolved.relativePath,
      errors: [],
      reason: null,
    };
  }

  /** The client renders this instead of building a player from a path, which it does not
   *  have. Same rule as before ADR 0015, with a different player. */
  getMediaDescriptor(source: {
    videoId: string;
    mediaMissing: boolean;
    startMs?: number;
    endMs?: number;
  }): MediaDescriptor {
    return buildMediaDescriptor(source.videoId, {
      missing: source.mediaMissing,
      startMs: source.startMs,
      endMs: source.endMs,
    });
  }

  /**
   * Delegated, not implemented. Subtitle parsing has nothing to do with where the media
   * came from, and an adapter that owned it would force the next adapter to duplicate it
   * or to depend on this one.
   */
  async parseTranscript(file: {
    content: string;
    filename: string | null;
    formatHint?: TranscriptFormat | null;
  }): Promise<TranscriptParseResult> {
    const result = parseTranscriptContent(file.content, {
      filename: file.filename,
      formatHint: file.formatHint ?? null,
    });
    return {
      segments: result.segments,
      warnings: result.warnings,
      format: result.format,
      parserVersion: result.parserVersion,
    };
  }
}

/**
 * Constructed per media root rather than as a module singleton.
 *
 * The old adapter held no state and one instance was enough. This one closes over the
 * root, and a module-level instance would capture whatever the environment said at import
 * time — which in tests is whatever the previous test file left behind. Take the root from
 * config at the call site.
 */
export function createLocalMediaSource(mediaRoot: string): LocalMediaSourceAdapter {
  return new LocalMediaSourceAdapter(mediaRoot);
}
