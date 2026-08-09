# ADR 0018 — A media file is identified by its content, located by its path

**Status:** Accepted
**Date:** 2026-08-08
**Depends on:** ADR 0015 (local media)
**Blocks:** Stage 2 (ingestion)

## Context

`videos` has carried `UNIQUE (profile_id, source_type, external_video_id)` since migration
0001, with a comment recording that duplicate detection is that constraint rather than
application logic. Under `youtube_embedded`, `external_video_id` was the YouTube id: stable,
canonical, and supplied by someone else.

ADR 0015 removed that. A local file has no assigned identity, and the two obvious candidates
behave very differently under the things users actually do to files.

The question is not merely how to detect duplicates. Everything P80 builds — the transcript,
the word array, occurrences, learning items, review history — hangs off a video row. Whatever
identifies that row decides what survives a user reorganising their library.

## Decision

**`external_video_id` is the SHA-256 of the file's bytes. The path is a locator, stored
separately, and repairable.**

The hash is computed once, streamed, during the ingest job. Identity is a property of the
content; location is a property of this moment.

### 1. What each choice survives

| Event | Content hash | Path as identity |
|---|---|---|
| File renamed | identity holds; path repaired | everything orphaned |
| Directory reorganised | identity holds; path repaired | everything orphaned |
| Same file added twice under two names | one video | two videos, two transcripts, split history |
| File re-encoded | new video | same video, timings now wrong |
| File deleted | broken link, everything else intact | broken link, everything else intact |

The re-encode row is the one case where path identity looks better, and it is a trap: a
re-encoded file has different timings, so treating it as the same video keeps a transcript
whose timestamps no longer match the audio. Being told it is a new video is the correct
answer, and re-pointing an existing video at it is an explicit act with a visible cost —
which is the shape every irreversible operation in P80 is supposed to take.

The rename rows are the common case. A library gets reorganised; that must not be a
destructive act.

### 2. The cost

A full read of the file at ingest. On a local NVMe disk with hardware SHA extensions this
runs at gigabytes per second, so a 2 GB video costs a second or two inside a job that is
about to spend minutes in ASR. It is not on any interactive path: `POST /api/videos` returns
a job reference, and the hash happens in the worker.

A partial hash — first and last 8 MB plus the byte size — was considered. It is near-instant
at any file size and collides only on deliberately crafted input, which is not a threat model
that applies to a user's own library. Rejected because it buys a second of a background job
in exchange for a weaker guarantee that would have to be explained at every point where
identity matters. If ingest ever runs against network storage where the read is genuinely
expensive, this is the knob, and switching is a re-hash of existing rows rather than a
redesign.

### 3. A dangling reference is a repairable link

When the file at a video's path is missing, the video is **not** deleted and nothing
cascades. `videos.media_missing` is set, the media endpoint returns 404, and the UI offers
to re-point the video at a new path.

Re-pointing verifies the hash. A path whose content hashes to something else is a different
file and is refused with both hashes named — accepting it would silently rebind a transcript
to audio it does not match, which is the failure this whole design exists to prevent.

The transcript, the word array, the items, and the review history all survive a missing file,
because none of them needs the bytes. Only playback does. A video whose media is gone is
still a video you can study from; it is just one you cannot replay.

### 4. Where the hash is not used

The hash is an internal identity, not a display value and not a path component. Transcript
storage paths continue to be built from generated ULIDs only (`storage.ts`), which keeps
traversal structurally impossible rather than filtered. A 64-character hex string is
harmless, and the rule that paths are built from generated ids and nothing else is worth
more than the exception.

## Consequences

- **`videos` gains `media_path`, `content_hash`, and `media_missing`.** `external_video_id`
  holds the hash, so the existing unique constraint becomes content-based duplicate
  detection with no change to it. `url` becomes the display locator rather than a canonical
  URL. Migration 0002.
- **Duplicate detection now works across renames**, which it never did for the YouTube id
  either — that was stable for a different reason.
- **Adding a video is a two-phase operation.** The row is created with the path and no hash;
  the ingest job fills in the hash, the duration, and then transcribes. A collision is
  therefore detected in the worker, not at the API, and it resolves by pointing the second
  path at the existing video rather than by failing.
- **The hash is recomputed on repair only**, never on read. Detecting that a file changed
  underneath P80 without being told is out of scope; it would mean hashing on every open.
- Reversible: the column can hold a different identity scheme after a backfill, and nothing
  outside the ingest job derives meaning from its shape.
