# Stage 1 — Local application skeleton

**Milestone:** M1
**Depends on:** Stage 0
**Spec reference:** `docs/original_spec.md` §35, Stage 1

## Objective

A four-process local application that starts with one command, migrates its own database,
persists a profile, runs a job through a worker, and refuses non-loopback origins. After
this stage there is somewhere for Stage 2's transcripts and Stage 3's cards to go.

**No domain logic ships here.** No extraction, no scoring, no FSRS, no providers.

## Contracts in scope

Read before starting:

- `docs/contracts/02-database.md` — the whole schema, both §1 and §2
- `docs/contracts/03-api.md` §1 (conventions, error envelope), §8 (jobs, health), §10 (security)
- `docs/contracts/04-providers.md` §2 (LanguageAdapter registry), §4 (degraded mode)
- `docs/contracts/07-extraction.md` §12 (job pipeline — the RESOLVED list, not spec §27.1)

Changed by this stage (with an ADR):

- **ADR 0012** — database access layer: Drizzle over `better-sqlite3`, hand-authored SQL migrations

**Must not be changed by this stage:**

- Any formula in `06-scoring.md`
- The extraction architecture in `07-extraction.md`
- The card and review model in `05-cards-and-review.md`

## Steps

Spec §35 lists fourteen. Their state:

- [x] 1. TypeScript monorepo — pnpm workspaces, `apps/{api,worker,web,tui}`, `packages/*`, `services/nlp`
- [x] 2. React web application — Vite + TypeScript, media surfaces only (see divergence below)
- [x] 3. Fastify API — Zod validation at every route boundary
- [x] 4. Worker process — SQLite job polling, atomic claim
- [x] 5. Shared types — `packages/core`: domain enums, job types, error envelope
- [x] 6. SQLite — `better-sqlite3`, WAL, foreign keys **on**
- [x] 7. Migration system — numbered, forward-only, hand-authored, ledgered, checksummed
- [x] 8. Structured logging — one `pino` factory, redaction paths configured
- [x] 9. Health endpoints — `/api/health` and the sidecar's `/health`
- [x] 10. Local process-start command — `pnpm dev` starts four processes
- [x] 11. Environment configuration — Zod-parsed, closed key allowlist, `.env.example`
- [x] 12. Bind to localhost — API, web, and sidecar all `127.0.0.1`; LAN is opt-in and warns
- [x] 13. Error boundary and global error display — React boundary plus envelope rendering
- [x] 14. Database backup command — `pnpm db:backup`, `VACUUM INTO`

Added beyond the spec's list:

- [x] `apps/tui` scaffolded (ADR 0007) as a framework-free CLI — see *Notes*
- [x] `services/nlp` scaffolded as a stub (ADR 0002) — `/health` real, `/annotate` 501
- [x] Migration 0001 creates the **whole** contracted schema, 36 tables

## Exit criteria

| # | Criterion | Verified by | State |
|---|---|---|---|
| 1 | One command starts all local services | `scripts/smoke.sh` against `pnpm dev` — 10/10 | ☑ |
| 2 | Database migrations run automatically | `packages/database/test/migrate.test.ts` | ☑ |
| 3 | Application persists profile settings | `apps/api/test/profile.test.ts` | ☑ |
| 4 | Worker can claim and complete a test job | `apps/worker/test/claim.test.ts` | ☑ |
| 5 | Services reject unsupported remote origins | `apps/api/test/cors.test.ts` | ☑ |

Contract-derived, added here because the spec's five leave them unchecked:

| # | Criterion | Verified by | State |
|---|---|---|---|
| 6 | Every service binds `127.0.0.1` | `scripts/smoke.sh`; config test | ☑ |
| 7 | Config reads no credential-shaped key | `packages/core/test/config.test.ts` | ☑ |
| 8 | Errors leave the API in the contracted envelope | `apps/api/test/errors.test.ts` | ☑ |
| 9 | `db:backup` produces a *restorable* file | `packages/database/test/backup.test.ts` | ☑ |
| 10 | Drizzle schema matches the migration | `packages/database/test/schema-parity.test.ts` | ☑ |
| 11 | Two processes migrating at once is safe | `packages/database/test/concurrent-migrate.test.ts` | ☑ |
| 12 | Contract invariants hold as constraints | `packages/database/test/migrate.test.ts` | ☑ |
| 13 | The sidecar refuses rather than degrades | `services/nlp/tests/test_health.py` | ☑ |

**50 TypeScript tests, 3 Python tests, 9 packages typechecking clean.**

## Explicitly out of scope

- Extraction, scoring, FSRS, session generation
- `uselimit` — the enrichment ceilings bind at Stage 6–7, and it still owes a
  transactional SQLite `StorageAdapter` upstream
- Dictionary index, frequency counts, spaCy model, vLLM
- Provider implementations — `packages/providers` holds interfaces only
- The German `LanguageAdapter` and the function-word list (Stage 0 step 9)
- The rest of the `03-api.md` surface. A 501 route is a claim that the endpoint exists
- TUI framework selection — Stage 5

## Risks

- **§38.8 YouTube dependency** — untouched here. Nothing added pulls in a stream extractor.
- **Hand-authored DDL for 36 tables** is where a typo hides. Mitigated by the parity test,
  the table-list test, and foreign keys being on so a wrong reference fails loudly.
- **Python ahead of spaCy** — this machine runs 3.14; the sidecar pins `>=3.11,<3.14` and
  `.python-version` pins 3.13, so Stage 4's model install fails at `uv sync` with a clear
  message rather than midway through a large download.
- **Degraded-mode discipline** — vLLM is down for all of Stages 1–6. Nothing in Stage 1
  performs a startup provider check, so `04-providers.md` §4's claim that this exercises
  the §5.2 path stays true.

## Notes

**Divergence from spec §35's "Initial pages" list.** The spec names Today, Videos,
Candidates, Items, Settings, and Diagnostics as web pages. That list predates ADR 0007,
which assigns the last four to the TUI. The browser therefore has Today, Videos, Video
detail, and Review — the surfaces that need the IFrame player and `MediaRecorder`.
Building the other four in React would have created pages to be deleted in Stage 5.

**The TUI ships without a framework, deliberately.** ADR 0007 requires the client but
names no stack, and the surface that decides the stack is the candidate inbox in Stage 5:
a long, keyboard-driven, filterable list. Stage 1 ships `p80 health`, `p80 jobs`, and
`p80 profile` as a plain CLI, which is enough to prove the second client exists and holds
no domain logic. Pick the framework in Stage 5 with the real screen in front of you, and
write ADR 0013 then.

**Two silent bugs found and fixed** (both now have regression tests, both recorded in
ADR 0012):

1. A relative `P80_DB_PATH` gave the API and worker **separate databases**, because
   `pnpm --filter` runs each in its own directory. Nothing errored — both migrated, both
   reported healthy. Would have surfaced in Stage 2 as "my transcript never gets
   processed". Fixed by anchoring relative paths to the repository root.
2. Concurrent migration on boot was a race, masked by the first bug. Fixed with
   `BEGIN IMMEDIATE` around the whole read-decide-apply sequence.

**For Stage 2.** `MediaSourceAdapter`, `TranscriptParseResult`, and `ParseWarning` are
already declared in `packages/providers`; the `videos` unique constraint already
implements duplicate detection; `transcript_corrections` already exists so segments are
never mutated. Stage 2 should be application code against an existing schema.
