import { describe, expect, it } from 'vitest';
import {
  MEDIA_PATH_MESSAGES,
  SUPPORTED_MEDIA_EXTENSIONS,
  assertInsideMediaRoot,
  buildMediaDescriptor,
  resolveMediaPath,
} from '../src/index.js';

/**
 * `CLAUDE.md` rule 4 — **a media path is untrusted input**, resolved under
 * `P80_MEDIA_ROOT` or rejected (ADR 0015).
 *
 * This is the one media rule where the implementation *is* the claim. The others are
 * absences a static scan can check; this one is arithmetic, and a traversal that got
 * through would become an arbitrary file read served over HTTP by the media route.
 *
 * Pure functions, so every case is testable without a filesystem — which is also why the
 * roots below do not exist. A resolver that touched the disk would fail here, and that is
 * deliberate: existence is the caller's question, asked once, where there is somewhere to
 * report it.
 */

const ROOT = '/media/library';

describe('a path may not escape the media root', () => {
  it.each([
    '../secrets.mp4',
    '../../etc/passwd.mp4',
    'german/../../outside.mp4',
    'sub/../../../root.mp4',
    './../x.mp4',
  ])('rejects %s', (attempt) => {
    const result = resolveMediaPath(attempt, ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('escapes_root');
  });

  it('rejects a sibling directory that merely shares the root as a prefix', () => {
    // The `root + sep` case. A bare `startsWith(root)` accepts this, which is the single
    // most common way a containment check is wrong.
    const result = resolveMediaPath('../library-evil/x.mp4', ROOT);
    expect(result.ok).toBe(false);
  });

  it('rejects the root itself, which is a directory and not a file', () => {
    expect(resolveMediaPath('.', ROOT).ok).toBe(false);
  });

  it('rejects an absolute path outright rather than accepting one that lands inside', () => {
    // `/media/library/x.mp4` is inside the root and still refused. A caller sending an
    // absolute path is asking a different question than one sending a relative path, and
    // collapsing the two makes the rejection log unreadable.
    const inside = resolveMediaPath('/media/library/x.mp4', ROOT);
    expect(inside.ok).toBe(false);
    if (!inside.ok) expect(inside.reason).toBe('absolute');

    const outside = resolveMediaPath('/etc/shadow.mp4', ROOT);
    expect(outside.ok).toBe(false);
    if (!outside.ok) expect(outside.reason).toBe('absolute');
  });
});

describe('a path may not carry a character that two consumers read differently', () => {
  it('rejects a null byte before anything else touches the string', () => {
    // `x.mp4\0.png` is the classic: a NUL truncates the name in one consumer and not in
    // another, so the check and the use end up looking at different paths. Checked first,
    // before trim, before the extension test.
    const result = resolveMediaPath('ok.mp4\0.png', ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('null_byte');
  });

  it('rejects an empty or whitespace-only path', () => {
    for (const attempt of ['', '   ', '\t\n']) {
      const result = resolveMediaPath(attempt, ROOT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('empty');
    }
  });

  it('rejects a path long enough to be an attack on something downstream', () => {
    const result = resolveMediaPath(`${'a/'.repeat(600)}x.mp4`, ROOT);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('too_long');
  });
});

describe('only formats P80 can play are accepted', () => {
  it.each(['notes.txt', 'archive.zip', 'script.sh', 'x.mp4.exe', 'noextension'])(
    'refuses %s',
    (attempt) => {
      const result = resolveMediaPath(attempt, ROOT);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unsupported_extension');
    },
  );

  it.each(SUPPORTED_MEDIA_EXTENSIONS)('accepts %s', (ext) => {
    expect(resolveMediaPath(`clip${ext}`, ROOT).ok).toBe(true);
  });

  it('matches the extension case-insensitively', () => {
    // A file from a Windows-authored library is routinely `.MP4`, and refusing it would be
    // a rule about typography rather than about format.
    expect(resolveMediaPath('CLIP.MP4', ROOT).ok).toBe(true);
  });
});

describe('an accepted path is stored in one canonical form', () => {
  it('normalises redundant separators and dot segments', () => {
    const result = resolveMediaPath('german//./lektion-3.mp4', ROOT);
    expect(result.ok).toBe(true);
    // `a//b/./c` and `a/b/c` are the same file. Two spellings would become two videos —
    // the content hash catches that eventually, but only after paying for a full ingest.
    if (result.ok) expect(result.relativePath).toBe('german/lektion-3.mp4');
  });

  it('returns an absolute path anchored to the given root', () => {
    const result = resolveMediaPath('german/lektion-3.mp4', ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.absolutePath).toBe('/media/library/german/lektion-3.mp4');
  });

  it('trims surrounding whitespace, which a paste routinely carries', () => {
    const result = resolveMediaPath('  clip.mp4  ', ROOT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.relativePath).toBe('clip.mp4');
  });
});

describe('every rejection has a message a person can act on', () => {
  it('names a message for every reason the resolver can return', () => {
    // An unreachable reason would render as `undefined` in the UI, which is the failure
    // this closed map exists to make impossible.
    for (const attempt of ['', '/abs.mp4', '../x.mp4', 'x\0.mp4', 'x.txt']) {
      const result = resolveMediaPath(attempt, ROOT);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(MEDIA_PATH_MESSAGES[result.reason]).toBeTruthy();
      }
    }
  });

  it('never puts the media root into a message', () => {
    // Messages are rendered to a client that supplied a relative path and has no business
    // learning where the root lives.
    for (const message of Object.values(MEDIA_PATH_MESSAGES)) {
      expect(message).not.toContain('/media');
    }
  });
});

describe('the read-side guard', () => {
  it('returns the absolute path for a stored value that still passes', () => {
    expect(assertInsideMediaRoot('german/lektion-3.mp4', ROOT)).toBe(
      '/media/library/german/lektion-3.mp4',
    );
  });

  it('throws for a stored value that does not, rather than reading it', () => {
    // Only reachable via a hand-edited row or a database restored beside a different media
    // root. It costs one string comparison and it is the difference between that mistake
    // being a failed request and being an arbitrary file read.
    expect(() => assertInsideMediaRoot('../../etc/passwd.mp4', ROOT)).toThrow(/media root/);
    expect(() => assertInsideMediaRoot('', ROOT)).toThrow(/media root/);
  });
});

describe('the descriptor a client renders', () => {
  it('is a route, never a filesystem path', () => {
    const descriptor = buildMediaDescriptor('01ARZ3NDEKTSV4RRFFQ69G5FAV', { missing: false });
    expect(descriptor.mediaUrl).toBe('/api/videos/01ARZ3NDEKTSV4RRFFQ69G5FAV/media');
    expect(descriptor.kind).toBe('local_media');
    expect(descriptor.missing).toBe(false);
  });

  it('carries fractional seconds, because a local seek is exact', () => {
    const descriptor = buildMediaDescriptor('01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      missing: false,
      startMs: 1250,
      endMs: 3750,
    });
    // The keyframe-bounded player this replaced could not honour sub-second precision, so
    // rounding cost nothing. It costs something now.
    expect(descriptor.startSeconds).toBe(1.25);
    expect(descriptor.endSeconds).toBe(3.75);
  });

  it('never emits a negative time', () => {
    const descriptor = buildMediaDescriptor('01ARZ3NDEKTSV4RRFFQ69G5FAV', {
      missing: false,
      startMs: -500,
    });
    expect(descriptor.startSeconds).toBe(0);
  });
});
