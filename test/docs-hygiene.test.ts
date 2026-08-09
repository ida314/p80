import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../packages/core/src/paths.js';

/**
 * Documentation is portable or it is not documentation.
 *
 * A path that resolves on one contributor's machine is noise to everyone else, and a
 * contact detail or a real person's name in a sample sentence is residue from someone's
 * drafting rather than something a reader needs. Both are easy to write without noticing
 * and hard to spot on review, which is exactly the shape of thing worth automating.
 *
 * Deliberately narrow: it asserts only what a regex can be certain about. The judgement
 * calls — is naming this hardware load-bearing? — stay with the author and `docs/README.md`.
 * A lint that cries wolf on prose gets suppressed, and then it catches nothing at all.
 */

const REPO = findRepoRoot(process.cwd());

/** The reference documentation set: the entry points, the specification, and the decision
 *  record. Listed rather than globbed so that adding a directory is a deliberate act. */
const ROOTS = [
  'README.md',
  'CLAUDE.md',
  'docs/README.md',
  'docs/SETUP.md',
  'docs/roadmap.md',
  'docs/original_spec.md',
  'docs/contracts',
  'docs/decisions',
];

function markdownUnder(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    if (entry.isDirectory()) return markdownUnder(full);
    return entry.isFile() && entry.name.endsWith('.md') ? [full] : [];
  });
}

const DOCS = ROOTS.flatMap((root) => {
  const full = join(REPO, root);
  return full.endsWith('.md') ? [full] : markdownUnder(full);
});

/** Whoever is committing. Read from git rather than hardcoded, so the check covers every
 *  contributor and no name is written into a tracked file in order to detect that name. */
function committerIdentity(): string[] {
  return ['user.name', 'user.email'].flatMap((key) => {
    try {
      const value = execFileSync('git', ['config', '--get', key], {
        cwd: REPO,
        encoding: 'utf8',
      }).trim();
      return value.length > 2 ? [value] : [];
    } catch {
      return []; // Unconfigured git (fresh CI checkout) — nothing to match.
    }
  });
}

const PATTERNS: { label: string; pattern: RegExp; fix: string }[] = [
  {
    label: 'machine-local path',
    pattern: /(?:~\/|\/home\/[a-zA-Z0-9._-]+\/|\/Users\/[a-zA-Z0-9._-]+\/)/g,
    fix: 'Name the sibling repository, not a directory on disk. If it is private, say so and make the document stand without it.',
  },
  {
    label: 'contact detail',
    pattern: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
    fix: 'Documentation carries no contact details.',
  },
];

describe('documentation hygiene', () => {
  it('finds the documentation tree', () => {
    // Guards the guard: a rename that silently emptied this list would make every
    // assertion below pass vacuously.
    expect(DOCS.length).toBeGreaterThan(10);
  });

  it.each(PATTERNS)('contains no $label', ({ pattern, fix }) => {
    const hits = DOCS.flatMap((file) =>
      [...readFileSync(file, 'utf8').matchAll(pattern)].map(
        (m) => `${relative(REPO, file)}: ${m[0]}`,
      ),
    );
    expect(hits, `\n${fix}\nSee docs/README.md.\n`).toEqual([]);
  });

  it("contains no real person's name", () => {
    const identity = committerIdentity();
    const hits = DOCS.flatMap((file) => {
      const text = readFileSync(file, 'utf8');
      return identity
        .filter((value) => text.includes(value))
        .map((value) => `${relative(REPO, file)}: ${value}`);
    });
    expect(
      hits,
      '\nUse a neutral placeholder in examples.\nSee docs/README.md.\n',
    ).toEqual([]);
  });

  it('has no links to files that do not exist', () => {
    const hits = DOCS.flatMap((file) => {
      const dir = join(file, '..');
      return [...readFileSync(file, 'utf8').matchAll(/\]\(([^)#][^)]*\.md)(?:#[^)]*)?\)/g)]
        .filter((m) => !m[1].startsWith('http'))
        .filter((m) => {
          try {
            readFileSync(join(dir, m[1]));
            return false;
          } catch {
            return true;
          }
        })
        .map((m) => `${relative(REPO, file)} -> ${m[1]}`);
    });
    expect(hits, '\nBroken relative link.\n').toEqual([]);
  });
});
