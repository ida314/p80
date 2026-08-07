# P80 — Status

> Single source of truth for *where the project is*. Read at the start of every session,
> update at the end of every session. Keep it short — this is a dashboard, not a journal.

**Current stage:** Stage 2 — Manual video and transcript ingestion (not started)
**Milestone:** M1 — First vertical slice
**Last updated:** 2026-08-07

---

## Now

**Stage 1 is done.** All five spec exit criteria pass as tests, plus eight
contract-derived ones the spec left unchecked. 50 TypeScript tests, 3 Python tests, nine
packages typechecking clean, and `scripts/smoke.sh` green 10/10 against a live `pnpm dev`.

The repo now exists:

| | |
|---|---|
| Processes | `apps/api`, `apps/worker`, `apps/web`, `services/nlp` — one `pnpm dev` |
| Clients | `apps/web` (media surfaces) and `apps/tui` (management), both over `/api/*` only |
| Database | SQLite, WAL, foreign keys **on**, all 36 contracted tables in migration 0001 |
| DB layer | Drizzle over `better-sqlite3`; migrations hand-authored, never generated (**ADR 0012**) |
| Inference | Nothing. No provider is constructed and nothing checks for one at startup |

## Blocked on

Nothing blocks Stage 2.

**Outstanding Stage 0 work**, unchanged, none of which gated the skeleton:

- [ ] **ADR 0006 Pass A** — video 1, exhaustive word labels (~500 lemmas) plus
      `worth_learning` and reasons. ~1 day. *Still the only unmet Stage 0 exit criterion.*
      It gates Stage 4 tuning, and it is now the nearest thing to a critical path item.
- [ ] Stage 0 step 7 — source-use and privacy notices (`docs/policy/`)
- [ ] Stage 0 step 9 — initial German function-word list, in the adapter

## Done

- [x] Repo initialized, spec frozen, contracts extracted, `CLAUDE.md` written
- [x] **ADRs 0001–0011 accepted** — see `docs/decisions/README.md`
- [x] **Stage 1 complete (2026-08-07)** — `docs/plan/stage-01-skeleton.md`.
      Monorepo, four processes, full schema, migrations, structured logging, strict CORS,
      loopback binding, error envelope, backup, one-command start.
- [x] **ADR 0012 accepted** — Drizzle over `better-sqlite3`. The migrations stay
      hand-authored SQL, because `02-database.md` §3 rule 1 forbids applying a generated
      diff without review. A parity test keeps the Drizzle mirror honest.

## Next actions

1. **Write the Stage 2 brief**, then build it. Most of the groundwork is already laid:
   `MediaSourceAdapter` / `TranscriptParseResult` / `ParseWarning` are declared in
   `packages/providers`, the `videos` unique constraint *is* duplicate detection, and
   `transcript_corrections` exists so segments are never mutated. Stage 2 should be
   application code against an existing schema.
2. **Label ADR 0006 Pass A.** It blocked nothing in Stage 1 and blocks nothing in Stage 2,
   which is exactly why it keeps not happening — and Stage 4 cannot be tuned without it.
3. Verify ADR 0001's readiness checklist as Stage 4 approaches. The resources are *named*,
   none is *verified*, and the boxes stay unticked until a fixture exercises each.

## Milestones

| # | Stages | Outcome | State |
|---|---|---|---|
| M0 | 0 | Scope locked, providers chosen, evaluation set exists | **decisions done; Pass A outstanding** |
| M1 | 1–3 | First complete vertical slice: add video → manual item → review it | **Stage 1 done; 2–3 next** |
| M2 | 4–6 | Deterministic extraction + dictionary-grounded meanings | not started |
| M3 | 7–8 | LLM disambiguation, expressions, constructions | not started |
| M4 | 9–10 | Learner model, adaptive admission, video difficulty | not started |
| M5 | 11–12 | Video loop, struggle diagnosis, recommendations | not started |
| M6 | 13 | Metrics, export, pilot readiness | not started |

## Open questions

Two remain inside ADR 0011, both deliberately left to measurement. Neither blocks anything
before Stage 8.

- **Is the embedding non-compositionality path MVP or deferred?** Resolved as a *decision
  rule*: build the dictionary path in Stage 6, measure its recall against the Pass B
  idiomaticity labels at Stage 8, record the number.
- **Layer 2 write threshold** — default is persist on second sighting; validated at Stage 8.

Added by Stage 1:

- **Which TUI framework?** Deferred to Stage 5 on purpose. ADR 0007 requires the client
  but names no stack, and the surface that decides it — the candidate inbox, a long
  keyboard-driven filterable list — does not exist yet. Stage 1 ships a framework-free
  CLI (`p80 health|jobs|profile`), which is enough to prove the second client exists and
  holds no domain logic. Write ADR 0013 in Stage 5, with the real screen in front of you.

`07-extraction.md` §14 carries three further tunables with recorded defaults. One, the
recurrence promotion threshold (3 distinct videos), is **not measurable against a
two-video corpus** and has to wait for a real library.

## Notes

- **Two silent bugs found while building Stage 1**, both now with regression tests and both
  recorded in ADR 0012. The first is the instructive one: a relative `P80_DB_PATH` gave
  the API and worker **separate databases**, because `pnpm --filter` runs each in its own
  directory. Nothing errored — every service started, migrated, and reported healthy. It
  would have surfaced in Stage 2 as "my transcript never gets processed". The second, a
  race between the two processes migrating on boot, was *masked* by the first.
- **`pnpm dev` starts four processes, not three.** ADR 0002's Python sidecar is one of
  them. It ships as a stub: `/health` is real, `/annotate` returns 501. spaCy and
  `de_core_news_lg` arrive in Stage 4 — and the stub *refuses* rather than returning an
  empty token list, because silent degradation into whitespace tokenization is the named
  failure mode there.
- **Python 3.14 is ahead of spaCy's wheels.** `services/nlp` pins `>=3.11,<3.14` and
  `.python-version` pins 3.13, so Stage 4's model install fails at `uv sync` with a clear
  message rather than midway through a 500 MB download.
- **Web ships media surfaces only** — Today, Videos, Video detail, Review. Spec §35's
  "Initial pages" list also names Candidates, Items, Settings, and Diagnostics, but it
  predates ADR 0007, which assigns those to the TUI. Recorded as a divergence in the
  Stage 1 brief.
- **The empty external-request list is now structural.** Nothing in the codebase
  constructs a provider, and no startup path checks for one. vLLM will be down for all of
  Stages 1–6, which `04-providers.md` §4 treats as free exercise of the §5.2 degraded
  path — a claim that only holds because nothing was built here that assumes reachability.
- Contracts introduced 11 tables absent from spec §28. All 36 are in migration 0001, and
  `schema-parity.test.ts` compares the Drizzle definitions against SQLite's introspection
  so the mirror cannot drift silently.
- The contracts diverge from the frozen spec in three named places, all ADR-backed:
  §14.10's reject-on-value gates (ADR 0008), §27.1's enrich-before-score job order
  (ADR 0008), and §26.1's all-TypeScript monorepo (ADR 0002). All marked `RESOLVED` inline.
- **New dependency: `uselimit`** (`~/Projects/uselimit`). Not integrated until Stage 6. It
  still needs a transactional SQLite `StorageAdapter` written upstream, because the
  shipped `InMemoryAdapter` is single-process and both the API and worker consume budget.
- **Named risk: German lemmatization.** spaCy's German lemmatizer is rule/lookup-based and
  weakest on verb inflection and separable verbs — which is what §14.8 consolidation,
  §22.1 coverage, and MWE lemma identity all key on. Verify at Stage 4; the fallback is
  Stanza inside the same sidecar, a version bump rather than an architecture change.
- **Two dictionary editions introduce one failure mode worth watching:** a German-edition
  sense grounds an item, but its English rendering is an LLM bridge translation and must be
  labelled unverified. Never let that translation be presented as the dictionary's own
  definition.
