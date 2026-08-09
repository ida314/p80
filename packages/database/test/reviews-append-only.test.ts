import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Stage 3 exit criterion 8 — `reviews` is append-only.
 *
 * This is a **source test**, not a behaviour test, and that is the point. "No delete path
 * exists" is a claim about the whole codebase, and no runtime assertion can make it:
 * exercising every route and finding the row still there proves only that the routes
 * exercised did not delete it. What can be checked is that nothing anywhere is written to.
 *
 * `02-database.md` and `CLAUDE.md` both state the invariant — review history is
 * append-only, and it is what makes an item's behaviour interpretable at all. The one
 * legitimate write is `recordRating` and `recordAttempt` filling in columns of a row this
 * session just opened, which is completing a record rather than rewriting one. Both are
 * allowlisted by name below.
 *
 * When this fails, the fix is almost never to add to the allowlist. It is to ask why
 * something wants to rewrite history.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..');

/** Every file that may contain SQL against `reviews`. Kept explicit rather than globbed,
 *  because a glob that silently stops matching is a test that silently stops testing. */
const SOURCES = [
  'packages/database/src/repositories/review.ts',
  'packages/database/src/repositories/items.ts',
  'apps/api/src/routes/review.ts',
  'apps/api/src/routes/items.ts',
];

/** Columns a review row acquires *after* it is opened. Writing these completes a record;
 *  writing anything else rewrites one. */
const COMPLETABLE = [
  'answered_at',
  'response_text',
  'response_latency_ms',
  'source_context_used',
  'scheduler_rating',
  'user_rating',
  'hint_count',
  'machine_classification',
];

function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8');
}

describe('the reviews table has no rewrite path', () => {
  it('is never deleted from', () => {
    for (const source of SOURCES) {
      const sql = read(source);
      expect(sql, `${source} deletes from reviews`).not.toMatch(/DELETE\s+FROM\s+reviews/i);
    }
  });

  it('is only ever updated in the columns a row acquires after it is opened', () => {
    for (const source of SOURCES) {
      const text = read(source);
      const updates = [...text.matchAll(/UPDATE\s+reviews\b([\s\S]*?)WHERE/gi)];
      for (const [, body] of updates) {
        const columns = [...(body ?? '').matchAll(/(\w+)\s*=\s*[?\w]/g)].map((m) => m[1]);
        for (const column of columns) {
          expect(
            COMPLETABLE,
            `${source} updates reviews.${column}, which is not a column a row acquires later`,
          ).toContain(column);
        }
      }
    }
  });

  it('never rewrites the identity or the timing of a rep', () => {
    // Implied by the allowlist above, and asserted separately because these four are the
    // reason the allowlist exists. `shown_at` in particular is when the retrieval started,
    // and §23.1's latency measurement is only honest if it cannot move afterwards.
    const IMMUTABLE = ['id', 'shown_at', 'created_at', 'card_id', 'item_id', 'session_id'];
    for (const source of SOURCES) {
      const text = read(source);
      for (const [, body] of text.matchAll(/UPDATE\s+reviews\b([\s\S]*?)WHERE/gi)) {
        const columns = [...(body ?? '').matchAll(/(\w+)\s*=\s*[?\w]/g)].map((m) => m[1]);
        for (const column of IMMUTABLE) {
          expect(columns, `${source} updates reviews.${column}`).not.toContain(column);
        }
      }
    }
  });

  it('exposes no repository function whose name suggests one', () => {
    const repository = read('packages/database/src/repositories/review.ts');
    for (const forbidden of ['deleteReview', 'updateReview', 'clearReviews', 'resetReview']) {
      expect(repository, `review.ts exports ${forbidden}`).not.toContain(
        `export function ${forbidden}`,
      );
    }
  });
});
