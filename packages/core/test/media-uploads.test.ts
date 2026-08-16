import { describe, expect, it } from 'vitest';
import {
  SUPPORTED_MEDIA_EXTENSIONS,
  isInsideUploadDirectory,
  mediaFilenameCandidates,
  nextChunkPlan,
  resolveMediaPath,
  safeMediaFilename,
  uploadPartialPath,
  uploadRelativePath,
} from '../src/index.js';

/**
 * ADR 0024 §4 — **the filename never becomes a path.**
 *
 * The interesting assertion in this file is not the table of rejections; it is the
 * composition property at the bottom. `safeMediaFilename` is a *sanitiser*, and
 * `CLAUDE.md` rule 4 says a path is never sanitised into something acceptable. The rule is
 * not bent because the sanitiser is not what makes this safe — `resolveMediaPath` is. What
 * these tests pin down is that the two compose **totally**: whatever comes out of the
 * sanitiser, feeding it to the resolver produces a path inside the root.
 *
 * If that property ever fails, the bug is here rather than in the caller, and the caller is
 * required to treat it as an internal error rather than as bad user input.
 */

const ROOT = '/media/library';

describe('an extension is chosen from the closed list, never carried', () => {
  it.each(SUPPORTED_MEDIA_EXTENSIONS)('accepts %s', (extension) => {
    const result = safeMediaFilename(`lektion${extension}`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.extension).toBe(extension);
  });

  it('lowercases a shouted extension rather than creating a second spelling on disk', () => {
    const result = safeMediaFilename('LEKTION.MP4');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename).toBe('LEKTION.mp4');
  });

  it.each(['notes.txt', 'archive.zip', 'clip.avi', 'clip.mp4.exe', 'noextension'])(
    'refuses %s rather than coercing it',
    (name) => {
      const result = safeMediaFilename(name);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported_extension');
    },
  );
});

describe('separators and traversal never survive into a name', () => {
  it.each([
    ['../../etc/passwd.mp4', 'passwd.mp4'],
    ['..\\..\\windows\\system.mp4', 'system.mp4'],
    ['/absolute/path/clip.mp4', 'clip.mp4'],
    ['C:\\Users\\me\\clip.mp4', 'clip.mp4'],
  ])('%s becomes %s', (input, expected) => {
    const result = safeMediaFilename(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename).toBe(expected);
  });

  it('refuses a NUL before anything else reads the string', () => {
    // The classic: a NUL truncates the name in one consumer and not in another, so the
    // check and the use end up looking at different things.
    const result = safeMediaFilename('clip\0.png.mp4');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('null_byte');
  });

  it('produces no dotfile, so an uploaded file cannot be invisible in the browser', () => {
    const result = safeMediaFilename('...hidden.mp4');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename.startsWith('.')).toBe(false);
  });

  it('refuses a name that is only a path', () => {
    expect(safeMediaFilename('/').ok).toBe(false);
    expect(safeMediaFilename('').ok).toBe(false);
  });
});

describe('German survives, invisible characters do not', () => {
  it('keeps umlauts and eszett, which is the whole reason a name is accepted at all', () => {
    const result = safeMediaFilename('Übung 3 – Präpositionen groß.mp4');
    expect(result.ok).toBe(true);
    // The en-dash is not in the allowlist and becomes a separator; the letters stay.
    if (result.ok) {
      expect(result.filename).toContain('Übung');
      expect(result.filename).toContain('Präpositionen');
      expect(result.filename).toContain('groß');
      expect(result.filename.endsWith('.mp4')).toBe(true);
    }
  });

  it.each([
    ['zero-width joiner', 'a\u200db.mp4'],
    ['right-to-left override', 'a\u202eb.mp4'],
    ['bidi isolate', 'a\u2066b.mp4'],
    ['control character', 'a\u0007b.mp4'],
  ])('strips a %s, which renders as something other than what it is', (_label, input) => {
    const result = safeMediaFilename(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(/\p{C}/u.test(result.filename)).toBe(false);
  });

  it('collapses a run of replaced characters into one separator', () => {
    const result = safeMediaFilename('a     b.mp4');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename).toBe('a-b.mp4');
  });
});

describe('length is bounded in bytes, not characters', () => {
  it('keeps a four-byte-per-character name under the filesystem limit', () => {
    // 100 emoji is 400 UTF-8 bytes. A character-counted bound would pass this and then
    // fail with ENAMETOOLONG at the one moment the user cannot do anything about it.
    const result = safeMediaFilename(`${'😀'.repeat(100)}.mp4`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(new TextEncoder().encode(result.filename).length).toBeLessThanOrEqual(255);
    }
  });

  it('never leaves a half a code point behind', () => {
    const result = safeMediaFilename(`${'ä'.repeat(300)}.mp4`);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename).not.toContain('\ufffd');
  });

  it('falls back to a usable name rather than a generated id when nothing survives', () => {
    const result = safeMediaFilename('***.mp4');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.filename).toBe('video.mp4');
  });
});

describe('Windows device names are defused rather than refused', () => {
  it.each(['CON.mp4', 'nul.mp4', 'COM1.mp4', 'LPT9.mp4'])('%s gets a prefix', (name) => {
    const result = safeMediaFilename(name);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.stem.startsWith('_')).toBe(true);
  });
});

/**
 * The property that matters. Everything above is a case; this is the claim.
 */
describe('the sanitiser and the resolver compose totally', () => {
  const ADVERSARIAL = [
    '../',
    '..\\',
    '../../../../../../etc/shadow.mp4',
    '.',
    '..',
    '....//....//x.mp4',
    'a'.repeat(5000) + '.mp4',
    '😀'.repeat(400) + '.mkv',
    '\u202eexe.4pm.mp4',
    'CON.mp4',
    ' .mp4',
    '-.mp4',
    'ä'.repeat(300) + '.mov',
    'nor\u0000mal.mp4',
    '%2e%2e%2fetc.mp4',
    'clip.mp4/../../escape.mp4',
  ];

  const RANDOM = Array.from({ length: 2000 }, (_unused, seed) => {
    // Deterministic, because a test that fails one run in fifty is a test nobody trusts.
    let x = seed * 2654435761;
    const next = () => {
      x = (x ^ (x << 13)) >>> 0;
      x = (x ^ (x >>> 17)) >>> 0;
      x = (x ^ (x << 5)) >>> 0;
      return x;
    };
    const length = next() % 40;
    let out = '';
    for (let i = 0; i < length; i += 1) out += String.fromCodePoint(next() % 0x2ffff || 65);
    return `${out}.mp4`;
  });

  it.each([...ADVERSARIAL, ...RANDOM])(
    'whatever %j sanitises to, it resolves inside the root',
    (input) => {
      const sanitized = safeMediaFilename(input);
      // A refusal is a legitimate outcome and proves nothing about containment.
      if (!sanitized.ok) return;

      const resolved = resolveMediaPath(uploadRelativePath(sanitized.filename), ROOT);
      expect(resolved.ok).toBe(true);
      if (resolved.ok) {
        expect(resolved.absolutePath.startsWith(`${ROOT}/uploads/`)).toBe(true);
        expect(isInsideUploadDirectory(resolved.relativePath)).toBe(true);
      }
    },
  );
});

describe('collision candidates are ordered and bounded', () => {
  it('offers the plain name first, then suffixes', () => {
    const candidates = [...mediaFilenameCandidates('lektion.mp4', 4)];
    expect(candidates.slice(0, 3)).toEqual(['lektion.mp4', 'lektion-2.mp4', 'lektion-3.mp4']);
  });

  it('stops rather than spinning — a thousand collisions is a loop, not a library', () => {
    expect([...mediaFilenameCandidates('lektion.mp4', 5)]).toHaveLength(5);
  });

  it('keeps a suffixed name inside the byte budget', () => {
    const long = `${'ä'.repeat(300)}.mp4`;
    const sanitized = safeMediaFilename(long);
    expect(sanitized.ok).toBe(true);
    if (!sanitized.ok) return;
    for (const candidate of [...mediaFilenameCandidates(sanitized.filename, 20)]) {
      expect(new TextEncoder().encode(candidate).length).toBeLessThanOrEqual(255);
    }
  });
});

describe('the partial path is built from a generated id and nothing else', () => {
  const ULID = '01J9ZQK8V4T7WQZ0X1Y2A3B4C5';

  it('lands in a hidden directory beside the uploads folder', () => {
    expect(uploadPartialPath({ mediaRoot: ROOT, uploadId: ULID })).toBe(
      `${ROOT}/uploads/.p80-partial/${ULID}.part`,
    );
  });

  it.each([
    '../../../etc/passwd',
    'not-a-ulid',
    '',
    '01J9ZQK8V4T7WQZ0X1Y2A3B4C5/../..',
    'ILOU0000000000000000000000',
  ])('refuses %j, because the guarantee is only worth the id generator', (bad) => {
    expect(() => uploadPartialPath({ mediaRoot: ROOT, uploadId: bad })).toThrow(/ULID/);
  });

  it('is not a path the user-facing resolver would ever accept', () => {
    // `.part` is not a supported media extension, which is the structural reason this path
    // must be built here rather than routed through `resolveMediaPath`.
    const partial = uploadPartialPath({ mediaRoot: ROOT, uploadId: ULID });
    const relative = partial.slice(ROOT.length + 1);
    expect(resolveMediaPath(relative, ROOT).ok).toBe(false);
  });
});

describe('only files P80 wrote are deletable', () => {
  it.each(['uploads/clip.mp4', 'uploads/sub/clip.mp4'])('%s is inside', (path) => {
    expect(isInsideUploadDirectory(path)).toBe(true);
  });

  it.each(['clip.mp4', 'german/clip.mp4', 'uploads-elsewhere/clip.mp4', 'uploads'])(
    '%s is not',
    (path) => {
      expect(isInsideUploadDirectory(path)).toBe(false);
    },
  );
});

describe('the chunk plan', () => {
  it('walks a file in whole chunks and then a short one', () => {
    expect(nextChunkPlan({ receivedBytes: 0, sizeBytes: 25, chunkBytes: 10 })).toEqual({
      done: false,
      start: 0,
      end: 10,
    });
    expect(nextChunkPlan({ receivedBytes: 20, sizeBytes: 25, chunkBytes: 10 })).toEqual({
      done: false,
      start: 20,
      end: 25,
    });
  });

  it('never asks for bytes past the end of the file', () => {
    const plan = nextChunkPlan({ receivedBytes: 0, sizeBytes: 3, chunkBytes: 1024 });
    expect(plan).toEqual({ done: false, start: 0, end: 3 });
  });

  it('is done at exactly the declared size, and stays done past it', () => {
    expect(nextChunkPlan({ receivedBytes: 25, sizeBytes: 25, chunkBytes: 10 })).toEqual({
      done: true,
    });
    expect(nextChunkPlan({ receivedBytes: 30, sizeBytes: 25, chunkBytes: 10 })).toEqual({
      done: true,
    });
  });

  it('treats a zero-byte file as already done rather than looping on an empty chunk', () => {
    expect(nextChunkPlan({ receivedBytes: 0, sizeBytes: 0, chunkBytes: 10 })).toEqual({
      done: true,
    });
  });
});
