import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Stage 2 exit criterion 5 — **P80 never acquires media, and never copies it.**
 *
 * The hard media rules (ADR 0015, `CLAUDE.md` rules 1–4) are the kind of constraint that
 * erodes by accident: someone adds a library to solve a real problem and the prohibition is
 * gone without anyone deciding to remove it. This file makes the rules mechanical, so
 * violating one fails the build rather than a review.
 *
 * This half is the static check: nothing in the tree *can* obtain media. The dynamic half —
 * running the real ingestion flow with the network stubbed to throw — lives in
 * `apps/api/test/media-policy.test.ts`, where the workspace packages resolve. Either check
 * alone is easy to satisfy while still breaking the rule.
 *
 * **What changed with ADR 0015**, recorded here because the diff is the interesting part:
 * `ffmpeg` was on the forbidden list and is now required, because decoding a file the user
 * already holds is the whole of what ASR does. The rule it used to enforce — *never isolate
 * or store an audio track* — was deleted rather than weakened. What replaces it is narrower
 * and actually checkable: **no media is ever written into P80's storage root.**
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Tools whose only purpose is obtaining media P80 was not given (rule 1).
 *
 * `ffmpeg` is deliberately absent. It reads a local file and produces no network traffic;
 * the things below fetch from a remote service, which is the actual prohibition.
 */
const FORBIDDEN_TOOLS = [
  'yt-dlp',
  'ytdl',
  'youtube-dl',
  'youtubedl',
  'play-dl',
  'streamlink',
];

/** Endpoints that serve media bytes or captions P80 must never fetch (rules 1 and 2). */
const FORBIDDEN_ENDPOINTS = [
  'googlevideo.com',
  'get_video_info',
  '/api/timedtext',
  'youtube.com/watch',
  'youtu.be/',
];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === 'dist') continue;
    if (entry === '.venv' || entry === '__pycache__' || entry === '.pytest_cache') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if (/\.(ts|tsx|js|mjs|py)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** Comments and doc strings name these tools in order to forbid them. A match inside one
 *  is the prohibition being documented, not broken. */
function codeOnly(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/#.*$/gm, '');
}

describe('nothing in the tree can obtain media', () => {
  const files = ['apps', 'packages', 'services', 'scripts'].flatMap((d) =>
    sourceFiles(join(ROOT, d)),
  );

  it('scans a plausible number of files, so a broken glob cannot pass vacuously', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it.each(FORBIDDEN_TOOLS)('imports or invokes no %s', (tool) => {
    const offenders = files.filter((file) => {
      const source = codeOnly(readFileSync(file, 'utf8'));
      return (
        new RegExp(`(?:from|require|import)\\s*\\(?['"\`][^'"\`]*${tool}`, 'i').test(source) ||
        new RegExp(`(?:spawn|exec|execSync|execFile|run)\\s*\\(\\s*['"\`]${tool}`, 'i').test(
          source,
        )
      );
    });
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it.each(FORBIDDEN_ENDPOINTS)('never builds a request to %s', (endpoint) => {
    const offenders = files.filter((file) => codeOnly(readFileSync(file, 'utf8')).includes(endpoint));
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it('declares no media-acquisition dependency in any workspace package', () => {
    const manifests = ['apps', 'packages', 'services']
      .flatMap((d) => readdirSync(join(ROOT, d)).map((p) => join(ROOT, d, p, 'package.json')))
      .filter((p) => {
        try {
          return statSync(p).isFile();
        } catch {
          return false;
        }
      });

    for (const manifest of manifests) {
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const names = Object.keys({ ...parsed.dependencies, ...parsed.devDependencies });
      for (const tool of FORBIDDEN_TOOLS) {
        expect(names.filter((n) => n.includes(tool))).toEqual([]);
      }
    }
  });
});

/**
 * Rule 3 — **P80 never copies media into its own storage.**
 *
 * This is the rule that replaced *never isolate or store an audio track*, and it is worth
 * more than its predecessor because it is mechanically checkable: the storage root is a
 * path P80 builds, so every write to it goes through a small number of helpers, and none
 * of them may produce a media file.
 */
describe('no media is written into P80 storage', () => {
  it('builds no storage path with a media or audio extension', () => {
    const storage = readFileSync(join(ROOT, 'packages/core/src/storage.ts'), 'utf8');

    // The extension map is closed and keyed on transcript format. A media extension
    // appearing in it would mean the storage root had learned to hold media.
    const mapBody = storage.slice(
      storage.indexOf('FORMAT_EXTENSIONS'),
      storage.indexOf('}', storage.indexOf('FORMAT_EXTENSIONS')),
    );
    for (const ext of ['mp4', 'mkv', 'webm', 'mov', 'wav', 'mp3', 'm4a', 'flac', 'opus']) {
      expect(mapBody).not.toContain(ext);
    }
  });

  it('resolves media only against the media root, never the storage root', () => {
    const mediaPath = readFileSync(join(ROOT, 'packages/core/src/media-path.ts'), 'utf8');
    expect(mediaPath).toContain('mediaRoot');
    // Reading media relative to `P80_STORAGE_PATH` would be the two roots collapsing,
    // which is how a "temporary" decoded file becomes a permanent stored one.
    expect(codeOnly(mediaPath)).not.toContain('P80_STORAGE_PATH');
  });

  it('never writes a file whose path came from the media root', () => {
    // Production code only. `apps/api/test/helpers.ts` writes fixture media into a temp
    // root on purpose, which is a test arranging a state, not P80 storing media.
    const files = ['apps', 'packages']
      .flatMap((d) => sourceFiles(join(ROOT, d)))
      .filter((f) => !/[/\\](test|tests|__tests__)[/\\]/.test(f));
    const offenders = files.filter((file) => {
      const source = codeOnly(readFileSync(file, 'utf8'));
      if (!source.includes('P80_MEDIA_ROOT') && !source.includes('assertInsideMediaRoot')) {
        return false;
      }
      // A module that resolves a media path may read it and must never write near it.
      return /createWriteStream|writeFileSync|writeFile\(|copyFile|mkdirSync/.test(source);
    });
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});

/**
 * Rule 4 — **a media path is untrusted input** — is asserted against the resolver's
 * behaviour in `packages/core/test/media-path.test.ts`, which is where the workspace
 * packages resolve. This project is the static scan and cannot import them.
 */

/**
 * The deletions are asserted too.
 *
 * ADR 0015 removed two rules, and the failure mode for a deleted rule is that someone
 * reintroduces it as a hedge — a UI that still apologises for imprecise seeking, or a
 * lingering keyframe tolerance. Both would be false now, and false-but-cautious copy is
 * still false.
 */
describe('the deleted rules stay deleted', () => {
  const uiFiles = sourceFiles(join(ROOT, 'apps/web/src'));

  it('claims no keyframe imprecision anywhere in the rendered copy', () => {
    // `codeOnly` here for the same reason it is used above: a comment explaining that the
    // claim was deleted is the record of the deletion, not the claim.
    const offenders = uiFiles.filter((file) =>
      /keyframe|frame-accurate|nearest key/i.test(codeOnly(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });

  it('mentions no external player or watch link in the client', () => {
    const offenders = uiFiles.filter((file) =>
      /youtube|iframe player|open it on/i.test(codeOnly(readFileSync(file, 'utf8'))),
    );
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});
