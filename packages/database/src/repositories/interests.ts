import { P80Error, newId, now } from '@p80/core';
import type { DatabaseHandle } from '../client.js';

/**
 * Interests and their per-video relevance (`03-api.md` §2).
 *
 * Small, but not optional: spec §12.1 step 5 puts interest tags on the add-video form, and
 * without somewhere to create them `video_interests` is a table nothing can reference.
 *
 * The two weights are deliberately different scales, and `02-database.md` resolves the
 * spec's ambiguity about how they combine:
 *
 * ```
 * interests.weight          1..5   how much the user cares about the topic
 * video_interests.relevance 0..1   how much this video is about that topic
 * effective = (weight / 5) * relevance
 * ```
 */

export interface InterestRow {
  id: string;
  profileId: string;
  name: string;
  weight: number;
  createdAt: number;
}

interface RawInterest {
  id: string;
  profile_id: string;
  name: string;
  weight: number;
  created_at: number;
}

const toInterest = (row: RawInterest): InterestRow => ({
  id: row.id,
  profileId: row.profile_id,
  name: row.name,
  weight: row.weight,
  createdAt: row.created_at,
});

export function listInterests(handle: DatabaseHandle, profileId: string): InterestRow[] {
  const rows = handle.sqlite
    .prepare('SELECT * FROM interests WHERE profile_id = ? ORDER BY name ASC')
    .all(profileId) as RawInterest[];
  return rows.map(toInterest);
}

export function createInterest(
  handle: DatabaseHandle,
  input: { profileId: string; name: string; weight: number },
): InterestRow {
  const id = newId();
  handle.sqlite
    .prepare(
      'INSERT INTO interests (id, profile_id, name, weight, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .run(id, input.profileId, input.name, input.weight, now());
  const row = handle.sqlite.prepare('SELECT * FROM interests WHERE id = ?').get(id) as
    | RawInterest
    | undefined;
  if (!row) throw new Error('Interest disappeared immediately after insert.');
  return toInterest(row);
}

export function updateInterest(
  handle: DatabaseHandle,
  id: string,
  patch: { name?: string; weight?: number },
): InterestRow {
  const sets: string[] = [];
  const params: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    params.push(patch.name);
  }
  if (patch.weight !== undefined) {
    sets.push('weight = ?');
    params.push(patch.weight);
  }
  if (sets.length > 0) {
    handle.sqlite
      .prepare(`UPDATE interests SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params, id);
  }
  const row = handle.sqlite.prepare('SELECT * FROM interests WHERE id = ?').get(id) as
    | RawInterest
    | undefined;
  if (!row) throw P80Error.notFound('Interest', { id });
  return toInterest(row);
}

export function deleteInterest(handle: DatabaseHandle, id: string): boolean {
  return handle.sqlite.prepare('DELETE FROM interests WHERE id = ?').run(id).changes > 0;
}

export interface VideoInterestRow {
  interestId: string;
  name: string;
  relevance: number;
}

export function listVideoInterests(
  handle: DatabaseHandle,
  videoId: string,
): VideoInterestRow[] {
  return handle.sqlite
    .prepare(
      `SELECT vi.interest_id AS interestId, i.name AS name, vi.relevance AS relevance
         FROM video_interests vi
         JOIN interests i ON i.id = vi.interest_id
        WHERE vi.video_id = ?
        ORDER BY i.name ASC`,
    )
    .all(videoId) as VideoInterestRow[];
}

/** Replaces the whole set for a video, so the caller sends the state it wants rather than
 *  a diff it has to compute. */
export function setVideoInterests(
  handle: DatabaseHandle,
  videoId: string,
  interests: ReadonlyArray<{ interestId: string; relevance: number }>,
): void {
  const insert = handle.sqlite.prepare(
    'INSERT INTO video_interests (video_id, interest_id, relevance) VALUES (?, ?, ?)',
  );
  handle.sqlite.transaction(() => {
    handle.sqlite.prepare('DELETE FROM video_interests WHERE video_id = ?').run(videoId);
    for (const interest of interests) {
      insert.run(videoId, interest.interestId, interest.relevance);
    }
  })();
}
