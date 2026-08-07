import { ulid } from 'ulid';

/** Primary keys are text ULIDs (`02-database.md`, conventions). */
export function newId(): string {
  return ulid();
}

/** Timestamps are integer epoch milliseconds. SQLite has no date type, and storing text
 *  dates invites comparison bugs (`02-database.md`, conventions). */
export function now(): number {
  return Date.now();
}
