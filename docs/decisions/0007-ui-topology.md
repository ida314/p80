# ADR 0007 — UI topology: TUI for management, browser for media

**Status:** Accepted
**Date:** 2026-08-03
**Blocks:** Stage 1 (repo layout), Stage 3 (first review UI), Stage 11 (video loop)

## Context

Spec §26.1 already separates web, API, and worker into distinct processes, and §26.2
justifies it: long-running extraction, provider secrets, reliable DB writes, and retryable
jobs belong in a local backend. The HTTP API is therefore already the boundary between
the running system and whatever displays it.

Two facts decide how to use that boundary:

1. **Playback is browser-only.** §8 and §19.1 require the YouTube IFrame Player API, which
   cannot be hosted in a terminal. `MediaRecorder` (§19.3–19.4) is likewise browser-only,
   though voice is optional in MVP (§21.5).
2. **Most interaction volume is text.** Candidate approval (§25) is the highest-frequency,
   most repetitive surface in the product and is entirely textual.

## Decision

Two clients over one API, split by whether the surface needs media:

| Surface | Client | Why |
|---|---|---|
| Candidate inbox | **TUI** | Highest-volume, keyboard-driven, pure text |
| Items library | **TUI** | Search and filter |
| Stats / metrics | **TUI** | Read-only tables |
| Diagnostics, jobs, provider calls | **TUI** | Operational |
| Settings, profile, interests | **TUI** | Forms — *amended by ADR 0019, see below* |
| Review sessions | **Browser** | Audio recognition needs the IFrame player |
| Video loop | **Browser** | Inherently visual (§21) |
| Video detail / transcript sync | **Browser** | Playback-linked |

Contextual cloze and productive recall are *renderable* in the TUI, but they are scheduled
inside the same session as audio-recognition cards (§30.2) and must not require switching
surfaces mid-session. They live with review, in the browser.

**Rejected:** a TUI that shells out to a player page per card. It preserves §19.1
precision but forces a terminal↔browser switch 25–40 times per session, which is worse
than either pure option.

## Consequences

- **Clients hold no domain logic.** Scoring, session generation, sibling burying, and FSRS
  live in `packages/core` and are reachable only through `/api/*`. This is the invariant
  that makes the split cost nothing and keeps it reversible.
- Repo gains `apps/tui` alongside `apps/web`.
- **No UI-abstraction layer.** Two concrete clients against one HTTP API — not a client
  framework. Build the third client when a third client exists.
- Test: a shell script using `curl` alone can complete a full review session. If it can't,
  logic has leaked into a client. This belongs in the §34.3 integration suite.
- §33 keyboard-only review stops being a retrofit — the TUI can only be keyboard-driven,
  so the shortcut set is exercised by construction.
- Reversible. If the browser review flow proves annoying, a degraded link-out TUI review
  mode (`https://youtu.be/ID?t=102`) can be added later without backend changes — at the
  cost of §19.1's interval stop, replay, and answer-reveal structure.

## Amendments

**ADR 0019 puts settings in both clients.** The rule above sorts a surface by whether it
needs media, and settings does not, so it landed in the terminal. The exception 0019 makes
is narrow and specific: the media root decides whether the media surfaces work at all, and
a browser client that renders a library of unplayable videos while the control that repairs
them lives in a different application is a worse split than the one this ADR was avoiding.
Everything else in the management column stays where it is, on the reasoning above, which
0019 does not touch.

## Notes

Timestamped links (`youtu.be/ID?t=102`, or `embed/ID?start=&end=`) are within policy and
remain the right mechanism for *navigation* — "open this occurrence in a browser" from
anywhere, including the TUI. They are not a substitute for the audio-recognition card,
which needs programmatic seek-and-stop.
