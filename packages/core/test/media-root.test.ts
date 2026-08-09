import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MEDIA_ROOT_MESSAGES, validateMediaRoot } from '../src/media-root.js';

/**
 * Stage 2b exit criterion 4 (ADR 0019 §3).
 *
 * The media root stopped being trusted configuration the moment a `PUT` could change it.
 * These are the guards that replaced "it came from a file only the operator could edit" —
 * and, as ADR 0019 says plainly, they are not a security boundary. What they buy is that
 * the worst single keystroke is not `/`.
 */
describe('validateMediaRoot', () => {
  let dir: string;
  let storage: string;
  let file: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'p80-root-'));
    storage = join(dir, 'storage');
    file = join(dir, 'not-a-directory.txt');
    writeFileSync(file, 'x');
    // The storage directory must exist for the containment check to be about anything.
    mkdtempSync(join(tmpdir(), 'p80-storage-'));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('accepts an existing readable directory and returns it normalised', () => {
    const result = validateMediaRoot(`${dir}/`, storage);
    expect(result).toEqual({ ok: true, path: dir });
  });

  it('normalises so that one directory cannot become two different roots', () => {
    // `/library/` and `/library` are the same directory, and the containment check in
    // `media-path.ts` compares string prefixes — two spellings would be two roots.
    const trailing = validateMediaRoot(`${dir}/`, storage);
    const dotted = validateMediaRoot(join(dir, 'sub', '..'), storage);
    expect(trailing).toEqual(dotted);
  });

  it.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['relative/path', 'not_absolute'],
    ['/', 'filesystem_root'],
    ['/etc', 'system_directory'],
    ['/etc/ssl/private', 'system_directory'],
    ['/proc/self', 'system_directory'],
    ['/usr/share/videos', 'system_directory'],
    ['/var/lib/anything', 'system_directory'],
  ] as const)('rejects %s as %s', (input, reason) => {
    const result = validateMediaRoot(input, storage);
    expect(result).toEqual({ ok: false, reason });
  });

  it('rejects a null byte before anything else touches the string', () => {
    // First, deliberately: a NUL truncates a path in one consumer and not in another,
    // which is the classic way a check and a use end up looking at different things.
    expect(validateMediaRoot('/media\0/etc', storage)).toEqual({
      ok: false,
      reason: 'null_byte',
    });
  });

  it('rejects a path longer than the limit', () => {
    expect(validateMediaRoot('/' + 'a'.repeat(1100), storage)).toEqual({
      ok: false,
      reason: 'too_long',
    });
  });

  it('does not treat a sibling of a system directory as inside it', () => {
    // A bare `startsWith('/usr')` would reject `/usr-videos`, which is a perfectly
    // ordinary place to keep files and not inside `/usr` at all.
    const result = validateMediaRoot('/usr-videos', storage);
    expect(result).toEqual({ ok: false, reason: 'not_found' });
  });

  it('rejects a path that exists but is a file', () => {
    expect(validateMediaRoot(file, storage)).toEqual({
      ok: false,
      reason: 'not_a_directory',
    });
  });

  it('rejects a path that does not exist rather than reporting an empty library', () => {
    expect(validateMediaRoot(join(dir, 'nope'), storage)).toEqual({
      ok: false,
      reason: 'not_found',
    });
  });

  it('rejects the storage directory and anything inside it', () => {
    // Rule 3: `P80_STORAGE_PATH` holds transcripts and derived artifacts, never media. A
    // root containing it would make that statement false by construction.
    const realStorage = mkdtempSync(join(tmpdir(), 'p80-storage-real-'));
    try {
      expect(validateMediaRoot(realStorage, realStorage)).toEqual({
        ok: false,
        reason: 'inside_storage',
      });
      expect(validateMediaRoot(join(realStorage, 'sub'), realStorage)).toEqual({
        ok: false,
        reason: 'inside_storage',
      });
    } finally {
      rmSync(realStorage, { recursive: true, force: true });
    }
  });

  it('has an actionable message for every rejection', () => {
    // These reach the user through the error envelope. A message that only says "invalid"
    // is a rejection they cannot act on.
    for (const [reason, message] of Object.entries(MEDIA_ROOT_MESSAGES)) {
      expect(message.length, reason).toBeGreaterThan(20);
      expect(message, reason).not.toMatch(/^invalid/i);
    }
  });
});
