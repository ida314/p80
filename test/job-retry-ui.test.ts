import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `POST /api/jobs/:id/retry` has a caller.
 *
 * It existed from Stage 1 and nothing called it, which was invisible until it mattered: a
 * sidecar lost its ASR package, every transcription failed, the package was reinstalled,
 * and the browser's only offer was still "upload a transcript instead" — the one path that
 * throws away what the user was trying to do. Recovery meant `curl`.
 *
 * Source-scanning rather than rendered, for the same reason `test/settings-ui.test.ts` is:
 * P80 ships no browser test runner. What this holds is not the button's appearance but the
 * property that went wrong — a route with no consumer, and a *stopped* poll behind a
 * control that restarts the thing being polled.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

describe('the retry route has a client', () => {
  it('is reachable from the browser, not only from curl', () => {
    expect(read('apps/web/src/api.ts')).toMatch(/\/api\/jobs\/\$\{id\}\/retry/);

    const callers = sourceFiles('apps/web/src').filter(
      (file) => !file.endsWith('api.ts') && /\bretryJob\b/.test(read(file)),
    );
    expect(callers.length).toBeGreaterThan(0);
  });

  it('offers it on both surfaces where a transcription can fail', () => {
    // The video page is where someone asks on a later visit; the upload panel is where
    // they are standing when it happens. Fixing only one leaves the other silent.
    expect(read('apps/web/src/pages/VideoDetail.tsx')).toMatch(/<RetryJob/);
    expect(read('apps/web/src/components/JobStatus.tsx')).toMatch(/<RetryJob/);
  });

  it('restarts the polling the retry invalidates', () => {
    /**
     * Both hooks stop on purpose — `useJob` at a terminal state, `useLatestJob` after one
     * answer — and both are wrong the instant a job is queued again. A retry button in
     * front of a stopped poll is worse than no button: the work restarts and the page goes
     * on showing the old failure, which reads as a control that does nothing.
     */
    expect(read('apps/web/src/hooks/useJob.ts')).toMatch(/\}, \[jobId, nonce\]\)/);
    expect(read('apps/web/src/hooks/useLatestJob.ts')).toMatch(
      /\}, \[entityId, jobType, nonce\]\)/,
    );
    for (const page of ['apps/web/src/pages/Library.tsx', 'apps/web/src/pages/VideoDetail.tsx']) {
      expect(read(page)).toMatch(/retryNonce/);
    }
  });

  it('does not hide the button when the failure said retrying will not help', () => {
    // `retryable: false` means *waiting* will not help (ADR 0027). It says nothing about
    // whether the person reading it has since installed the missing model, which is the
    // only reason a manual retry exists.
    const component = read('apps/web/src/components/RetryJob.tsx');
    expect(component).not.toMatch(/if \(!retryable\) return null/);
    expect(component).toMatch(/\{!retryable && \(/);
  });
});
