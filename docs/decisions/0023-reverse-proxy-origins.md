# ADR 0023 — Reaching P80 from another device

**Status:** Accepted
**Date:** 2026-08-16
**Builds on:** ADR 0021 (the API serves the built client), ADR 0019 (live vs boot settings)

## Context

P80 binds `127.0.0.1` and accepts browser requests from loopback origins only
(`CLAUDE.md` rule 13, spec §32.5). That is right for the machine it runs on and wrong for
the obvious next want: reviewing on a tablet, or on a laptop in another room, against the
library that lives on one workstation.

The clean way to do that is a mesh VPN or a reverse proxy — something that authenticates
the device, terminates TLS, and forwards to `127.0.0.1:5180`. P80 does not have to change
for the *transport* to work. It has to change for the **browser** to work, and the reason is
narrow enough to state exactly:

> A page served from `https://p80.example.ts.net` sends
> `Origin: https://p80.example.ts.net` on every request that is not `GET` or `HEAD`.

The loopback allowlist does not contain that origin, so the page loads, reads succeed, and
**every write returns 403 `ORIGIN_NOT_ALLOWED`** — every rating, every item created, every
settings change. A UI that renders and then refuses to save reads as a broken application
rather than as a security rule doing its job. This is the same mechanism ADR 0021 already
had to accommodate once, when the client moved to the API's own origin and the API's origin
had to join the list.

The alternative that needs no code — forwarding a port so the browser still sees
`http://127.0.0.1:5180` — works today and is documented. It needs a tunnel per client
device, which is tolerable on a laptop and unpleasant on a phone.

## Decision

### 1. One new boot key: `P80_TRUSTED_ORIGINS`

A comma-separated list of extra browser origins, empty by default. `allowedOrigins()`
returns the loopback set plus whatever this names.

Empty by default is the whole design. Nothing about P80's reachability changes unless
somebody writes an origin into `.env.local`, and the value they write is the exact origin
that becomes acceptable.

### 2. Entries are bare origins, and a wildcard is refused

`scheme://host[:port]`, `http` or `https`, no path, no query, no credentials, no `*`.
Anything else fails at startup naming the offending entry, rather than being sanitised into
something acceptable — the same stance `CLAUDE.md` rule 4 takes for media paths, for the
same reason: a value that is *nearly* an origin, half-honoured at request time, is how an
allowlist becomes a formality.

A wildcard is the specific thing worth refusing by name. `https://*.example.ts.net` looks
like a convenience and is a standing invitation, since P80 has no second line of defence
behind it.

### 3. It is boot-tier, not runtime-editable

ADR 0019 kept `P80_ALLOW_LAN` out of the settings surface on the grounds that rule 13's
opt-in should not be something a page can do. Widening the CORS allowlist is the same
decision wearing different clothes, so it gets the same treatment: displayed on the settings
surface with its reason, editable only in `.env.local` followed by a restart.

### 4. Setting it warns at startup

`isLanExposed()` stays *false* under a proxy — `P80_BIND_HOST` really is still `127.0.0.1`,
and that is not a technicality, it is why the proxy is the only route in. But a warning that
fires on the variable rather than on the situation would be silent for the exact
configuration that makes P80 reachable from another machine. So a non-empty
`P80_TRUSTED_ORIGINS` logs its own warning, naming the origins and the thing that actually
matters:

> P80 has no authentication, so whatever can reach these origins can read and change
> everything.

## Consequences

- **The proxy's access control is the entire security model.** P80 has no accounts, no
  sessions, and no auth of any kind — accounts are a spec §6 non-goal and rule 17 binds it.
  This was already true of `P80_ALLOW_LAN`; naming an origin here makes it true across a
  network boundary, which is a bigger surface for the same absence.
- **Do not put P80 on the public internet.** A mesh VPN restricted to your own devices is
  the intended shape. A public tunnel — Tailscale Funnel, `ngrok`, a port forward on a
  router — hands the library, the transcripts, and the review history to anyone with the
  URL. The empty default and the startup warning are the two places this is said in the
  product; this is the third.
- The CORS refusal message now names the permitted origins instead of asserting "loopback
  origins only", which stopped being true the moment the list became configurable. A refusal
  that misstates the rule sends the reader to the wrong file.
- `CLAUDE.md` rule 15 is untouched. This changes which *inbound* requests are accepted; the
  runtime outbound list is still empty, and a reverse proxy is not something P80 calls.
- Rule 14 is untouched. An origin is not a credential, and the key-allowlist test in
  `packages/core/test/config.test.ts` — which exists to make "no API keys" mechanical —
  carries it as an ordinary entry.

## Alternatives considered

**Bind to the VPN interface and set `P80_ALLOW_LAN=true`.** The existing opt-in, and it does
not solve the problem: the browser's origin is then `http://100.x.y.z:5180`, which is not on
the allowlist either, so the same writes fail. It also gives up TLS and puts P80 on a
listening socket that anything routable can reach, where a proxy can require device
authentication first. Strictly worse in both directions, which is worth recording because it
is the obvious first thing to try.

**Trust any origin when `P80_ALLOW_LAN` is set.** One fewer key. Rejected: it couples two
decisions that are not the same decision, and it turns a specific statement — *this proxy,
at this name* — into a blanket one at the moment the system is most exposed.

**Reflect the `Origin` header back when it matches `X-Forwarded-Host`.** Removes the
configuration entirely and trusts a header any client can send. Rejected on sight; it is an
allowlist that allows everything.

**Drop CORS for non-GET when a proxy is detected.** Rejected for the same reason, and it
would also silently weaken the protection that exists for the loopback case, where it is
doing real work — keeping a page on the open web from reading a library out of a local
server somebody left running.
