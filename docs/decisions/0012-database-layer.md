# ADR 0012 — Database access layer: Drizzle over better-sqlite3

**Status:** Accepted
**Date:** 2026-08-07
**Blocks:** Stage 1 (schema, migrations), every stage that reads or writes

## Context

Spec §26.1 names "Drizzle ORM or equivalent lightweight typed ORM" and requires explicit
migrations. "Or equivalent" is a real opening, and Stage 1 has to close it before laying
down 36 tables.

Two properties of P80's schema shape the choice:

1. **The contract is complete before the code is.** `02-database.md` specifies every
   table, key, and constraint. There is nothing to discover incrementally, so a tool whose
   selling point is evolving a schema alongside code is solving a problem P80 does not
   have.
2. **Later stages need SQL the builder will not have.** Scoring uses window functions,
   the dictionary index uses FTS5, and the job claim needs
   `UPDATE ... WHERE id = (SELECT ...) RETURNING *`. Whatever is chosen must get out of
   the way cleanly.

## Decision

**Drizzle ORM over `better-sqlite3`, with hand-authored SQL migrations.**

Three parts, and the third is the one that matters:

- `better-sqlite3` for the driver. Synchronous, which suits a local single-user
  application: there is no network latency to hide and no benefit to making every read a
  promise.
- Drizzle for typed table definitions and ordinary queries.
- **Migrations are hand-authored `.sql` files, not `drizzle-kit generate` output.**
  `02-database.md` §3 rule 1 forbids applying an auto-generated diff without review, and
  a generator that is only ever reviewed is a generator earning nothing.

The Drizzle definitions are therefore a *mirror* of the SQL, not its source. A mirror
nobody checks is just two sources of truth, so `packages/database/test/schema-parity.test.ts`
walks every table and compares columns and nullability against SQLite's own
introspection. Drift fails a test instead of surfacing as `no such column` three stages
later.

## Options

### A. Drizzle + better-sqlite3 — **chosen**
Named in the spec. Typed schema in TypeScript, a raw-SQL escape hatch that returns typed
rows, and migration tooling that can be declined without losing the rest.

### B. Kysely + better-sqlite3
A query builder with no schema DSL, closer to SQL, migrations hand-written anyway. Very
close on merit. Rejected because the spec names Drizzle and nothing here argued strongly
enough to spend the deviation.

### C. `better-sqlite3` with hand-written SQL throughout
Maximum control, zero abstraction. Rejected: 36 tables of hand-maintained row types drift
from the schema, and the parity test above is only possible because there is a declared
schema to compare against.

### D. Prisma
Rejected. A separate schema language and a generated client is a second source of truth
by construction, exactly what rule 1 guards against, and its migration story is the
generate-and-apply flow the contract declines.

## Consequences

- `packages/database` owns the schema, migrations, client, backup, and repositories.
  Nothing else opens a database connection — `apps/api` and `apps/worker` both go
  through `openDatabase`.
- **Foreign keys are enforced** (`PRAGMA foreign_keys = ON`). SQLite defaults this *off*,
  and every cascade rule in the contract — including invariant 5, which keeps approved
  items alive when their video is deleted — is a foreign key. Without the pragma those
  guarantees are decorative.
- **WAL mode**, so the API can read while the worker writes.
- `db:backup` uses `VACUUM INTO`, not a file copy. In WAL mode the `.db` file alone is
  incomplete — recent commits are in the `-wal` sidecar — so copying it while the API
  holds it open yields a file missing writes.
- Raw SQL is used where it earns its place, currently only the job claim, and the reason
  is written at the call site.
- Reversible. Swapping the query builder touches `packages/database` and nothing else,
  because the migrations are plain SQL and would survive the change untouched.

## Notes

Two bugs found while building this are worth recording, because both were silent:

1. **A relative `P80_DB_PATH` gave each process its own database.** `pnpm --filter` runs
   each app in its own directory, so `./data/p80.db` resolved differently in `apps/api`
   and `apps/worker`. Every service started, migrated, and reported healthy; the API just
   could not see the worker's writes. Fixed by anchoring relative paths to the repository
   root in `loadConfig`.
2. **Concurrent migration on start was a race**, masked by the first bug. Both processes
   migrate on boot and both start at once under `pnpm dev`; reading the ledger outside
   the write lock let both see zero applied migrations. Fixed by running the whole
   read-decide-apply sequence inside `BEGIN IMMEDIATE`, so the loser blocks, re-reads,
   and correctly finds nothing to do.

Both now have regression tests. The first is the more instructive: it produced no error
message anywhere, and would have been discovered in Stage 2 as "the transcript I uploaded
never gets processed".
