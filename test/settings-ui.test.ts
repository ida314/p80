import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Two properties of the settings page that are invisible in review and silent at runtime.
 *
 * Repository-level and source-scanning, for the same reason `web-safety.test.ts` is: P80
 * ships no browser test runner until Stage 3, and both of these are properties of the
 * markup rather than of any rendered output.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS = readFileSync(join(ROOT, 'apps/web/src/pages/Settings.tsx'), 'utf8');

describe('the settings page', () => {
  it('does not wrap a field in a label, which would make the help marker toggle it', () => {
    /**
     * A `<label>` forwards clicks to its control. With the help marker inside one, clicking
     * `?` on `P80_ASR_REQUIRE_GPU` would flip the setting — the user reads the tooltip and
     * silently disarms the GPU refusal, then finds out partway into a CPU
     * transcription.
     *
     * The page uses `<div className="field">` with an explicit `htmlFor`. Collapsing that
     * back to a wrapping label is the tempting simplification, and this is the test that
     * makes it fail loudly instead of quietly.
     */
    expect(SETTINGS).not.toMatch(/<label[^>]*className="field"/);
    expect(SETTINGS).toMatch(/<div className="field">/);
    expect(SETTINGS).toMatch(/htmlFor=\{id\}/);
  });

  it('opens the help on focus as well as hover, and says what it is', () => {
    // A pointer-only tooltip is unreachable by keyboard and by touch. The marker is a real
    // button so both routes work; `aria-describedby` binds the text to it.
    expect(SETTINGS).toMatch(/<button type="button" className="tip__mark"/);
    expect(SETTINGS).toMatch(/aria-describedby=\{id\}/);
    expect(SETTINGS).toMatch(/role="tooltip"/);

    const css = readFileSync(join(ROOT, 'apps/web/src/styles.css'), 'utf8');
    expect(css).toMatch(/\.tip__mark:focus-visible \+ \.tip__body/);
  });

  it('leaves the live state of a setting on the page, not behind a hover', () => {
    // The description is reference material read once. An unreadable stored value and the
    // value reverting would restore are the current state of *this* setting, and hiding a
    // live warning behind a hover is how it goes unnoticed.
    expect(SETTINGS).toMatch(/hint--warning/);
    expect(SETTINGS).toMatch(/row\.invalid !== undefined/);
  });

  it('offers the revert only where there is an override to drop', () => {
    // ADR 0026 §3. On a row already tracking the environment there is nothing to revert,
    // and a disabled button would imply otherwise. The control lives inside the
    // `source === 'database'` branch, next to the value it would restore.
    const overridden = SETTINGS.indexOf("row.source === 'database' && (");
    expect(overridden).toBeGreaterThan(-1);
    expect(SETTINGS.slice(overridden, overridden + 700)).toMatch(/onClick=\{onRevert\}/);
  });

  it('reverts through the draft, so the media root keeps its confirmation', () => {
    /**
     * The tempting shortcut is a button that PUTs `null` on the spot. It would work for
     * six of the seven keys and lose the orphan count on the seventh: reverting the media
     * root can strand a whole library, and the 409 that says so is only useful if there is
     * an unsaved change to attach the confirmation to.
     */
    expect(SETTINGS).toMatch(/setDrafts\(\(current\) => \(\{ \.\.\.current, \[key\]: null \}\)\)/);
    // `??` here would read a null draft as an absent one and silently drop the revert.
    expect(SETTINGS).not.toMatch(/drafts\[row\.key\] \?\? row\.value/);
    expect(SETTINGS).toMatch(/row\.key in drafts/);
  });
});
