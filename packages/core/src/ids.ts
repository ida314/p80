import { monotonicFactory } from 'ulid';

/**
 * Primary keys are text ULIDs (`02-database.md`, conventions).
 *
 * **Monotonic within a process.** Plain `ulid()` randomises the whole entropy section on
 * every call, so two ids minted in the same millisecond sort in an arbitrary order.
 * `monotonicFactory` increments the entropy instead, which makes id order agree with
 * insertion order whenever the timestamp cannot separate two rows.
 *
 * That is not a cosmetic property. `transcript_corrections` resolves "which correction
 * wins" by `(created_at, id)`, and a user nudging a timestamp with a keyboard produces two
 * corrections inside one millisecond routinely. With random entropy the older correction
 * wins about half the time, non-deterministically — a bug that hides in a passing test
 * suite and surfaces as "my edit did not take".
 *
 * Across processes the guarantee does not hold: the API and the worker each have their own
 * counter. Where a tie could genuinely be cross-process, SQL orders by `rowid`, which is
 * the database's own insertion order and needs no cooperation.
 */
const nextId = monotonicFactory();

export function newId(): string {
  return nextId();
}

/** Timestamps are integer epoch milliseconds. SQLite has no date type, and storing text
 *  dates invites comparison bugs (`02-database.md`, conventions). */
export function now(): number {
  return Date.now();
}
