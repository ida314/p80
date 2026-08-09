import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `CLAUDE.md` rule 8 — **transcript text is untrusted input; escape it on render.**
 *
 * The web client is where transcript text is rendered most, and React escapes children by
 * default, so the rule holds as long as nobody reaches around React. There are only a few
 * ways to do that, they are all greppable, and none of them has a legitimate use in this
 * application — so this is a cheap, complete check rather than a heuristic.
 *
 * It is deliberately a repository-level test rather than a component test. P80 ships no
 * browser test runner until Stage 3 (a jsdom setup exists to serve a purpose, and at Stage
 * 2 there is not one), and the property being asserted is about the *source*, not about
 * any single rendered output.
 *
 * The companion checks live next door: `media-policy.test.ts` covers the media rules, and
 * `packages/core/test/browser-surface.test.ts` covers what the client is allowed to import.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const WEB_SRC = join(ROOT, 'apps/web/src');

/**
 * Every way to hand a string to the DOM as markup, plus the two ways to hand it to the
 * parser as code.
 *
 * `insertAdjacentHTML` and `document.write` are included because they are the ones people
 * reach for when `innerHTML` is known to be forbidden.
 */
const FORBIDDEN = [
  { pattern: /dangerouslySetInnerHTML/, name: 'dangerouslySetInnerHTML' },
  { pattern: /\.innerHTML\s*=/, name: 'innerHTML assignment' },
  { pattern: /\.outerHTML\s*=/, name: 'outerHTML assignment' },
  { pattern: /insertAdjacentHTML/, name: 'insertAdjacentHTML' },
  { pattern: /document\.write/, name: 'document.write' },
  { pattern: /\beval\s*\(/, name: 'eval' },
  { pattern: /new\s+Function\s*\(/, name: 'new Function' },
] as const;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Comments name these constructs to explain why they are avoided. Stripping them keeps
 *  the documentation from tripping the check it documents. */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('the web client cannot render untrusted text as markup', () => {
  const files = sourceFiles(WEB_SRC);

  it('scans every source file, so a broken path cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(15);
  });

  it.each(FORBIDDEN.map((f) => [f.name, f.pattern] as const))(
    'uses no %s',
    (_name, pattern) => {
      const offenders = files.filter((file) => pattern.test(code(file)));
      expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
    },
  );

  it('renders transcript text as a child, never as an attribute that could be a URL', () => {
    // `rawText`, `text`, and `normalizedText` are the three fields carrying transcript
    // content. None may reach `href`, `src`, or `action` — rule 8's "never let it build a
    // URL", which escaping alone would not catch, since `javascript:…` is perfectly valid
    // escaped text.
    const offenders: string[] = [];
    for (const file of files) {
      const source = code(file);
      if (/(?:href|src|action)=\{[^}]*\b(?:rawText|normalizedText)\b/.test(source)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
      // `segment.text` is the projected transcript text; a bare `text` identifier is too
      // common to match on, so this targets the property access.
      if (/(?:href|src|action)=\{[^}]*\.text\b/.test(source)) {
        offenders.push(file.slice(ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('opens external links without handing over the opener', () => {
    // Every `target="_blank"` in the client points at YouTube. Without `rel="noopener"`
    // the opened page gets a handle on this one — worth closing off even when the
    // destination is expected, because the video id in the URL is user-supplied.
    const offenders: string[] = [];
    for (const file of files) {
      const source = code(file);
      const blanks = source.match(/<a\b[^>]*target=(?:"_blank"|\{'_blank'\})[^>]*>/g) ?? [];
      for (const tag of blanks) {
        if (!/noopener/.test(tag)) offenders.push(`${file.slice(ROOT.length + 1)}: ${tag}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
