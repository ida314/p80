# ADR 0015 — Local media files replace embedded YouTube

**Status:** Accepted
**Date:** 2026-08-08
**Supersedes:** the media half of ADR 0007's playback assumptions; rewrites the hard media
rules in `CLAUDE.md` §2 and `docs/contracts/04-providers.md` §1
**Blocks:** Stage 2 (ingestion), Stage 5 (video loop), Stage 11 (clip review)

## Context

P80's domain unit has always been *a timed media source plus a transcript*
(`04-providers.md` §1, *Provider independence*). `youtube_embedded` was the MVP
implementation of that shape, chosen because it was the cheapest lawful route to a large
library — not because the domain depended on it.

That choice bought a library and paid for it in five places:

1. **Playback is approximate.** The IFrame Player starts near a keyframe, so no clip
   boundary is exact and no UI copy may claim otherwise (old rule 5). Every occurrence
   replay, the single most-used interaction in the product, is fuzzy by construction.
2. **Transcripts must be user-supplied.** Scraping public captions is out (old rule 3), so
   ingestion stalls until the user finds a subtitle file. For most videos worth studying,
   one does not exist.
3. **Timing is cue-level.** A subtitle cue carries a start and an end and nothing inside it.
   ADR 0013 records this as the reason its sentence-boundary pause signal had to be
   downgraded, and left the resulting tuning as an open question.
4. **The source can vanish.** A video is taken down, region-locked, or made members-only,
   and the learning items built from it lose their evidence. Nothing P80 does prevents it.
5. **Availability is a network property.** Offline is a broken product, in an application
   whose first principle is local-first (spec §7.2).

Every one of those is a consequence of not holding the media. The user does hold the media:
an `.mp4` on a local disk, acquired by whatever means, which is not P80's concern and never
becomes P80's concern.

## Decision

**`local_media` becomes the only `MediaSourceKind`. `youtube_embedded` is removed.**

P80 ingests a local media file by reference. It reads that file; it never acquires it, never
copies it, and never claims ownership of it.

### 1. The media reference

A video row stores a **path** and a **content hash** (ADR 0018), not bytes. P80's storage
directory holds transcripts and derived artifacts; it never holds media.

Paths resolve under a single configured root, `P80_MEDIA_ROOT`. A path that escapes it is
rejected, not normalised. This is the same structural argument `storage.ts` already makes
for transcript paths: the guarantee comes from an alphabet and a prefix check, not from a
filter that has to be right about every input anyone will ever send.

One root rather than arbitrary absolute paths, because the root is what makes the rejection
meaningful. A library spread across several roots is a config-shaped want; adding a second
entry to a list is not a redesign, and it stays out of MVP.

### 2. Playback

The API serves media bytes over `GET /api/videos/:id/media` with HTTP Range support, from
the referenced path. The web client plays them in an ordinary `<video>` element.

This is read-through, not caching: no copy is produced, and deleting the underlying file
makes the endpoint 404 immediately rather than serving a stale duplicate.

**Playback becomes exact.** Seeking a decoded local file is sample-accurate, not
keyframe-bounded. The old rule 5 prohibition on claiming frame accuracy is deleted along
with the condition that made it necessary — and the deletion is the interesting half of this
ADR, because it converts occurrence replay from approximate to precise, which is what the
audio-recognition card (§19.1) needed all along.

### 3. The hard media rules, rewritten

The old rules 1–5 were written against a threat model where P80 might be tempted to obtain
media it had not been given. That model no longer describes the system: the user hands P80 a
file. The replacements, which are what `04-providers.md` §1 now carries:

| Old | New |
|---|---|
| 1. Never download YouTube video or audio | **1. P80 never acquires media.** No downloader, no stream extraction, no URL that resolves to media bytes. How a file arrived on disk is outside the system. |
| 2. Never isolate or store an audio track | **Deleted.** See below. |
| 3. Never scrape public captions | **2. P80 makes no outbound request to obtain a transcript.** ASR is local (ADR 0016); upload is user-supplied. |
| 4. Playback exclusively through the IFrame Player API | **3. P80 never copies media into its own storage.** It holds a reference and reads through it. |
| 5. Never claim frame-accurate playback | **Deleted** — playback is now exact. |
|  | **4. A media path is untrusted input** and is resolved under `P80_MEDIA_ROOT` or rejected. |

**Rule 2 is dropped deliberately, not by oversight.** It forbade isolating an audio track,
and it existed to stop stream-extraction from becoming an audio-download path by increments.
With user-supplied local files it has no subject left: the user already holds the audio, and
decoding it is the whole of what ASR does. Keeping a weakened version — *"audio may exist
transiently but must not be persisted"* — was considered and rejected as a rule that reads
like a constraint while permitting the thing it names. What actually needs protecting is new
rule 3, which is about P80's storage directory and is mechanically checkable.

The cost of the deletion, stated so it is not discovered later: nothing now stops P80 from
accumulating derived audio. That guardrail is gone and would have to be reintroduced as a
storage-budget concern if it ever matters.

### 4. What leaves the codebase

`packages/providers/src/media/youtube.ts`, `youtube-url.ts`, the IFrame player
(`apps/web/src/player/youtubeApi.ts`, `YouTubePlayer.tsx`), `EmbedDescriptor`,
`youtubeWatchUrl`, and the `youtube_embedded` / `authorized_youtube_owner` members of
`MEDIA_SOURCE_KINDS`.

`licensed_corpus` stays DEFERRED in the enum. It describes a shape — media P80 is granted
access to under terms — that remains reachable and is not what this ADR closes.

## Alternatives considered

**Keep `youtube_embedded` alongside `local_media`.** Rejected. It preserves work already
landed, and costs two playback surfaces, two clip-seek procedures, two timing models, and
the full YouTube ruleset kept alive in perpetuity — for a source that is strictly worse on
all five counts in Context. Provider independence was built so that removing an adapter is
as cheap as adding one; this is that mechanism being used.

**Demote it to DEFERRED and delete the implementation.** Rejected as a smaller version of
the same cost. A deferred member of the enum that no longer has a coherent playback story
is a claim the contract cannot back. If embedded providers return, they return as a new ADR
with a real design, which is cheaper than maintaining a stub of one.

**Copy media into P80 storage on ingest.** Rejected. It duplicates a library that is often
hundreds of gigabytes, and it makes P80 the owner of media it was merely shown.

## Consequences

- **Ingestion no longer stalls on finding a subtitle file.** Adding a video enqueues
  transcription (ADR 0016). The upload path survives as the fallback.
- **Word-level timing becomes available**, which ADR 0017 makes the source of truth and
  which closes ADR 0013's first open question by removing the constraint that raised it.
- **P80 works offline**, completely. The external-request list for a running system is now
  empty: no IFrame player, no stream. `CLAUDE.md` rule 15 returns to the unqualified form it
  had before Stage 2 had to weaken it.
- **A reference can dangle.** A moved or deleted file leaves a video whose transcript, items,
  and review history are all intact and whose media is gone. This is a repairable broken
  link, by design — see ADR 0018 — not a cascade.
- **The API now serves file bytes**, which it did not before. The route is the one place
  where a stored path reaches the filesystem, and it is loopback-bound like everything else
  (rule 13). Path containment is tested directly rather than assumed.
- **`ffmpeg` becomes an allowed dependency** — for decoding and duration probing, both of
  which are local operations on a file the user supplied. `media-policy.test.ts` flips from
  banning it to asserting the new rules.
- **The frozen spec §8 is now wrong**, and stays frozen. `04-providers.md` carries the
  divergence with a `RESOLVED` marker, which is the mechanism §5.6 of `CLAUDE.md` already
  prescribes for exactly this.
- Reversible at the cost of writing a new adapter. Nothing above `MediaSourceAdapter`
  learned anything about local files, which is the same guarantee that made removing
  YouTube a deletion rather than a refactor.
