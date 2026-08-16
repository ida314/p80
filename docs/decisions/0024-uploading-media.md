# ADR 0024 — Putting a file into the library from the browser

**Status:** Accepted
**Date:** 2026-08-16
**Depends on:** ADR 0015 (local media), ADR 0018 (file identity), ADR 0019 (runtime
settings), ADR 0023 (reaching P80 from another device)
**Amends:** the hard media rules in `CLAUDE.md` §2 and `docs/contracts/04-providers.md` §1

## Context

ADR 0015 made the media reference a path under `P80_MEDIA_ROOT`, and ADR 0023 made P80
reachable from a second device through a reverse proxy. Together they produce a gap neither
of them created on its own.

The client is on one machine and the library is on another. `POST /api/videos` takes a path
that must **already** exist under the media root, so adding a video from a laptop means
copying the file to the server by some other means first — `scp`, `rsync`, a file manager —
and then typing its path into a form, correctly, from memory, with no way to check what is
actually there. Three separate frictions, and the third is the one that bites: there is no
endpoint that will tell you what the library contains, so the add form is a text field you
type into blind.

This is not a defect in ADR 0015. Referencing rather than owning is still right, and nothing
below changes it. What is missing is a way for the bytes to arrive at all when the person
holding them is not sitting at the machine that stores them.

### The rule that is in the way, and why it is phrased as it is

`CLAUDE.md` rule 1 reads:

> **P80 never acquires media.** No downloader, no stream extraction, no URL that resolves to
> media bytes. **How a file arrived on disk is outside the system.**

Put it beside rule 2 and the asymmetry is the whole problem:

> **P80 makes no outbound request to obtain a transcript.** ASR is local; upload is
> user-supplied.

Rule 2 is phrased in terms of a **mechanism** — an outbound request. Rule 1 is phrased in
terms of an **outcome** — a file arriving. That was not a considered difference. Under
`youtube_embedded` there was no way for a file to arrive except by P80 fetching it, so the
outcome and the mechanism were the same event and either phrasing described the same
prohibition. ADR 0015 changed what the system is without revisiting how the rule was worded.

The consequence is that rule 1, read literally, forbids something rule 2 explicitly permits
for transcripts: the user handing P80 bytes over its own API. `POST /api/videos/:id/transcript`
writes user-supplied bytes to `P80_STORAGE_PATH` today and nobody calls it *acquiring a
transcript*, because rule 2 asks about the request rather than the file.

## Decision

**The browser may push media into one directory — `<P80_MEDIA_ROOT>/uploads/` — through a
chunked, resumable upload endpoint. Rule 1 is re-phrased in terms of the mechanism, so it
says what it has always meant.**

### 1. Acquiring versus being handed

The distinction the rules turn on is **pull versus push**:

| | Acquire (forbidden) | Receive (this ADR) |
|---|---|---|
| Who initiates | P80 | the user |
| Direction | outbound | inbound |
| Third party | yes — a service that holds the media | none |
| `fetch` called | yes | no |
| Rule 15's request list | grows | stays empty |

An upload is the media analogue of the transcript upload that already ships, and it is
identical on every row. What the user did to obtain the file before their browser sent it
remains entirely outside the system — that half of rule 1 is not weakened, only relocated to
where it is true.

**Rule 1 becomes:**

> **P80 never acquires media.** No downloader, no stream extraction, no URL that resolves to
> media bytes — **P80 makes no outbound request to obtain a file**. It accepts one the user
> hands it: a path already under `P80_MEDIA_ROOT`, or bytes the user's own browser pushes
> into `<P80_MEDIA_ROOT>/uploads/`. Both are pushes; neither leaves the machine. Where the
> user got the file is outside the system.

**Rule 3** keeps its subject and gains a boundary. An upload produces the *only* server-side
copy of the file; what stays forbidden is a **second** copy of a file P80 already holds — a
cache, a transcode, a decoded audio track. And `P80_STORAGE_PATH` never holds media,
**including a partially received upload**, which is the way this rule is most likely to be
broken by accident: staging a partial file in the storage directory is the most natural
implementation and it is exactly what rule 3 exists to prevent.

**Rule 4** gains its companion. A media path is untrusted input; so is a **filename**, and it
never becomes a path. See §4.

### 2. One writable directory

`uploads/`, and nothing else.

The alternative — let the upload name any directory under the root — was rejected because the
root is the user's own library. P80 writing into a directory structure it did not create,
alongside files it does not own, makes "which of these did P80 put here" unanswerable, and
that question turns out to be load-bearing the moment deletion exists (§5).

One directory also gives the mechanical rule something to check. `test/media-policy.test.ts`
can assert that **exactly one** production module writes into the media root and that its
paths derive from a single helper. A rule that is checkable is worth more than a rule that is
merely stated, which is the argument ADR 0015 already made when it replaced *never isolate an
audio track* with *never copy media into storage*.

### 3. Chunked and resumable, not one request

The upload is a session: create, then a sequence of positional chunk writes, then a
completion that hands off to the existing ingest path.

Three reasons, in order of how much they matter:

1. **A dropped link must not cost the whole file.** The motivating case is a multi-gigabyte
   file over a laptop's wireless connection through a mesh VPN. A single `PUT` that fails at
   80% starts again from zero, which for a large file over a slow link is the difference
   between a feature and a thing nobody uses twice.
2. **Reverse proxies cap bodies.** ADR 0023 put an arbitrary proxy in the path. nginx defaults
   `client_max_body_size` to one megabyte. Chunking keeps every request small enough that the
   default is irrelevant, and because the chunk size is chosen by the server the client needs
   no configuration when it changes.
3. **Progress becomes a number rather than a guess**, because the size is declared up front.

The declared size is the price of the protocol, and it buys more than progress: it lets the
server refuse an over-cap or over-disk upload before a single byte is written, and it is what
lets completion distinguish *finished* from *truncated*.

**Strict append.** A chunk's offset must equal the bytes already received, or it is refused
with the expected offset attached. Random-access writes were rejected: they let the file have
holes, so "how much have you received" stops being a number and becomes an interval set with
its own failure modes — bought to enable parallel chunking that a single disk behind a single
link gains nothing from. Strict append also makes concurrent chunks against one session
structurally impossible, which is worth more than a lock.

One deliberate exception: a chunk that lands entirely **below** the received count is a
**success, not a conflict**. That is what a retry after a lost response looks like, and
treating it as a conflict would make one dropped acknowledgement wedge a client that is
behaving correctly.

### 4. The filename never becomes a path

`safeMediaFilename()` reduces the browser's filename to an allowlist, chooses the extension
from the closed `SUPPORTED_MEDIA_EXTENSIONS` list rather than carrying the input's, and
truncates by UTF-8 bytes. Unicode letters survive, because `Übung.mp4` staying readable is the
entire reason a sanitiser exists here instead of a ULID; Unicode **control and format**
characters do not, which is what makes that defensible.

But rule 4 says a path is never sanitised into something acceptable, and that still holds,
because the sanitiser is not what makes this safe. It exists for the user's benefit — a
library of ULIDs would be unusable, which is the whole point of accepting a name at all. The
safety claim is separate and is one sentence:

> **No byte is written to a path that did not come out of `resolveMediaPath`.**
> `safeMediaFilename` proposes; `resolveMediaPath` disposes.

The composition is total — after sanitisation the path cannot be absolute, cannot carry an
unsupported extension, cannot be over-long, cannot contain a NUL. So a containment failure at
that point is **a bug in the sanitiser, not bad input from the user**, and it is reported as
an internal error rather than a 400. That distinction is how a real hole gets noticed instead
of being shown to the user as "bad filename".

The partial file carries no user input at all: it is `<uploadId>.part` in a hidden
subdirectory, named from a ULID, which is the same "paths are built from generated ids and
nothing else" rule `storage.ts` states for transcripts. Traversal is structurally impossible
rather than filtered.

**Collisions are resolved with `link(2)`, not `rename(2)`.** `rename` overwrites an existing
destination silently and without error, so the check-then-rename version of this loses a
user's file to a race and tells nobody. `link` fails `EEXIST` atomically, which turns a race
into a retry with the next candidate name.

### 5. Deletion is bounded to what P80 wrote

Browsing the library makes deletion an obvious next button, and it is the one genuinely new
power in this ADR: until now P80 had no code path that removed a user's media.

**It is restricted to `uploads/`.** P80 may delete what P80 wrote. Everything else under the
root was put there by the user, and P80's entire media design is *hold a reference and read
through it*. Both motivating cases — uploaded the wrong file, finished with this one — are
inside the restriction, and the user already has a shell for everything else. What the
restriction buys is a bound on the blast radius of any future path bug, in an API that has no
authentication.

**A file a video references is refused first.** The refusal names the videos; a second call
carrying an acknowledgement proceeds. This is the shape `MEDIA_ROOT_WOULD_ORPHAN` and the
transcript `replace` flag already use, and reusing a confirmation idiom the user recognises is
worth more than inventing a better one. It is server-driven rather than a client-side "are you
sure", so `curl` can complete the flow — ADR 0007's standing test.

**The video row is never deleted and nothing cascades.** Each referencing video is marked
`media_missing`, which is exactly the repairable dangling-link state ADR 0018 §3 designed: the
transcript, the items, the cards, and the review history all survive, and the repair
affordance already exists in the UI. The stale `media_path` is deliberately kept, so the
listing can say *"lektion-3.mp4 — missing"* rather than *"missing"*.

### 6. What this costs, stated rather than discovered

**P80's threat model changes, and `docs/SETUP.md` has to say so.** P80 has no
authentication; ADR 0023 makes the proxy's access control the entire security model. Until now
the consequence was *whatever can reach P80 can read and change everything in the database*.
It is now *…and can write bytes into the user's filesystem, and delete files P80 put there*.
Bounded by one directory, an extension allowlist, and a size cap — but a real escalation of a
sentence that already existed, and it belongs in the warning rather than in a commit message.

**A duplicate upload leaves an orphaned file.** Two browsers sending the same bytes produce
two files and two video rows. ADR 0018's content-hash dedupe collapses the rows in the worker
— but it deletes a row, not a file, so the second copy stays on disk with nothing pointing at
it. Accepted rather than fixed: browse exists precisely to make an untracked file visible, one
click from gone. Having the worker delete the file instead was considered and rejected, because
it would grant the *worker* the power to remove media, which is a much larger grant than the
problem justifies.

**The client holds the chunking protocol.** ADR 0007 says clients hold no domain logic, and
this is worth naming so it is not relitigated: chunk offsets are **transport**, the same
category as the client knowing about HTTP Range so `<video>` can seek. No scoring, no
scheduling, and no decision about whether a file is acceptable crosses into the browser — the
client posts the name and the size and renders whatever the API refuses with.

## Alternatives considered

**A single-shot `PUT` carrying the whole body.** Genuinely simpler, and it meets the
requirement to get a file from the laptop to the server. Rejected on the two reasons in §3 —
no resume over an unreliable link, and it collides with proxy body caps. Worth recording that
the session table makes both shapes expressible, so falling back is a small change rather than
a redesign.

**`multipart/form-data` via `@fastify/multipart`.** Rejected for the reason the transcript
route already gives: it is a dependency, and it reintroduces upload-filename handling as a
transport concern rather than an application one. A raw octet-stream body with the offset in
the query string needs no library and keeps the filename in a JSON field where it is ordinary
untrusted input.

**Staging partial uploads in `P80_STORAGE_PATH`.** Rejected twice over. It puts media bytes
under the root rule 3 exists to protect, and because `validateMediaRoot` guarantees the two
roots are disjoint, the final move would be a cross-filesystem copy rather than an atomic
rename — so the design that breaks the rule is also the one that cannot be made atomic.

**Deleting into a `.p80-trash/` directory instead of unlinking.** Rejected. It converts a
destructive operation into one that silently consumes disk in a directory the user did not ask
for, and the two-step confirmation already makes the destruction deliberate. A user who wants
undo has filesystem snapshots.

**Hashing incrementally as chunks arrive**, to save the re-read in `INGEST_MEDIA`. Rejected,
and recorded because it is exactly the kind of thing a later reader will "fix": it would hash
the bytes *in flight* rather than the bytes *on disk*, so a disk that wrote something
different would produce an identity that does not match the file. ADR 0018 makes the hash the
identity; the re-read is the verification.

**Making the size cap a setting.** Rejected for now. `CONFIG_KEYS` is a closed set with a
guard test, and every new key needs a tier decision and a documented reason. The cap exists to
bound a runaway rather than to be tuned, and the guard that matters is the free-space check.
If it needs tuning, that is a follow-up ADR rather than a smuggled key.

## Consequences

- **`POST /api/videos` gains a sibling rather than a replacement.** Adding by path still
  works, still takes a path, and is still the `curl`-shaped affordance. Upload completion
  returns the identical `202 { video, jobId }`, so everything downstream of "a video started
  ingesting" is unchanged.
- **`GET /api/library` is the first endpoint that enumerates the media root**, which makes the
  add-by-path form's blind text field optional. That is arguably the more valuable half of
  this change, and it costs a `readdir`.
- **`media_uploads` is a new table** (migration 0003). In-flight state cannot live in the
  partial file's size, because the original filename has to be kept somewhere that is not a
  path — the same argument `transcript_files.original_filename` already makes.
- **The row is the authority for how many bytes were received, and the file self-heals toward
  it.** A crash between the write and the update leaves the file long; the next chunk truncates
  it. The reverse — trusting the file — has no correction available.
- **A `.part` file can outlive the process.** A reaper sweeps expired sessions on API start
  and on session creation, bounded to ULID-named files inside one hidden directory. No new job
  type and no timer: uploads are not frequent enough to earn one.
- **`toEnvelope` needed a fix that was not about uploads.** Fastify's
  `FST_ERR_CTP_BODY_TOO_LARGE` carries its own 413 and is not a `P80Error`, so an over-limit
  body was being reported as `500 INTERNAL_ERROR` — which the transcript route's existing
  4 MB limit already did, undetected, because nothing had exceeded it.
- **Symlink containment was tightened at the same time.** `resolveMediaPath` resolves
  lexically, so a symlink inside the root pointing outside it passed containment and was read
  through. Pre-existing and unrelated to uploads, but browse puts a clickable listing in front
  of it, so it is fixed here rather than left for later.
- Reversible. Removing the feature is deleting two route files, one service, one table, and
  one page; nothing above `MediaSourceAdapter` learned that a file might have arrived by
  upload, which is the same guarantee that made removing YouTube a deletion.
