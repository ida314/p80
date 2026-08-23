import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../packages/core/src/paths.js';

/**
 * A deploy updates what the lockfile manages. It does not uninstall what the operator
 * installed alongside it.
 *
 * `uv sync` is exact by default: it removes every package outside the set it just
 * resolved. The sidecar's ASR and alignment extras live deliberately outside that set —
 * `docs/SETUP.md` installs them as two independent choices on top of the base sync — so a
 * plain `uv sync` in the deploy path silently uninstalled `faster-whisper`, and the next
 * transcription failed with `ASR_UNAVAILABLE` having never been touched by the change
 * being deployed. The failure was invisible from the deploy's own output, survived
 * `scripts/smoke.sh`, and was only findable by reading the worker's logs.
 *
 * **ADR 0025 removed the subject rather than the flag.** The deployed sidecar is an image
 * whose extras are a build instruction, so a deploy has no environment left to prune. That
 * guarantee now lives in `test/docker-parity.test.ts`, which asserts the image asks for the
 * extra; what remains here is the assertion that the old hazard has not come back — a
 * `uv sync` reintroduced into the deploy path would be operating on the venv that
 * `pnpm dev` still uses, and would prune it exactly as before.
 */

const REPO = findRepoRoot(process.cwd());

/** Every `uv sync ...` invocation, wherever it appears in a script — real command or
 *  dry-run echo. The dry-run line exists to tell the operator what the real one will do,
 *  so it is held to the same rule rather than exempted. */
const UV_SYNC = /uv sync[^\n"'`]*/g;

/** Comment lines are prose and routinely quote the wrong way of doing it in order to
 *  explain why it is wrong — including, in `deploy.sh`, the comment recording this very
 *  removal. Matching them would make the check fail on its own rationale. */
function commandLines(script: string): string {
  return readFileSync(join(REPO, script), 'utf8')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

/** Every real `uv sync` names the project it is syncing. Requiring that is what separates
 *  an invocation from a two-word display label passed to a progress printer. */
function invocations(script: string): string[] {
  return [...commandLines(script).matchAll(UV_SYNC)]
    .map((match) => match[0].trim())
    .filter((invocation) => invocation.includes('--project'));
}

describe('deploy does not prune the sidecar environment', () => {
  it('does not manage a Python environment at all', () => {
    // The strongest form of the original assertion. Deploying builds an image; the venv in
    // the checkout belongs to `pnpm dev` and is no longer any of the deploy's business.
    expect(
      invocations('scripts/deploy.sh'),
      '\nscripts/deploy.sh runs `uv sync` again.\n' +
        'ADR 0025 moved the sidecar into an image so the deploy would stop having an\n' +
        'environment to damage. If a sync genuinely belongs here again, it needs\n' +
        '`--inexact` or an explicit `--extra` — see this file\'s history and\n' +
        'docs/SETUP.md, "Speech recognition".\n',
    ).toEqual([]);
  });

  it.each(['scripts/service-install.sh', 'scripts/deploy.sh'])(
    'leaves no destructive sync in %s',
    (script) => {
      // Belt and braces: if either script grows one back, it has to be non-destructive.
      for (const invocation of invocations(script)) {
        expect(
          invocation.includes('--inexact') || invocation.includes('--extra'),
          `\n${script} runs \`${invocation}\`, which prunes the ASR extra.\n`,
        ).toBe(true);
      }
    },
  );

  it('leaves CI deliberately bare', () => {
    // The opposite rule, asserted so the two do not get "made consistent" by someone
    // applying this file's reasoning where it does not hold. CI has no models installed
    // and the sidecar tests are written to pass either way, so the extras are gigabytes of
    // download for no signal. CI also builds no images — it is on the wrong architecture
    // to run them — so nothing there is protected by docker-parity instead.
    const ci = invocations('.github/workflows/ci.yml');
    expect(ci.length).toBeGreaterThanOrEqual(1);
    for (const invocation of ci) {
      expect(invocation).not.toContain('--extra');
    }
  });
});
