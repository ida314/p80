import { sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertInsideRoot,
  sanitizeOriginalFilename,
  transcriptStoragePath,
} from '../src/storage.js';

/**
 * Stage 2 exit criterion 10, and `CLAUDE.md` rule 8 — untrusted input never builds a path.
 *
 * The design claim under test is stronger than "we sanitise the filename": the path is not
 * derived from the filename *at all*. These tests exist to make that claim falsifiable,
 * because the tempting refactor — "just clean the name and use it" — would still pass a
 * test that only checked a few traversal strings.
 */

const ROOT = '/srv/p80/storage';
const VIDEO = '01JBQZ8K4M3N5P7R9T1V2W3X4Y';
const FILE = '01JBQZ8K4M3N5P7R9T1V2W3X50';

const ATTACKS = [
  '../../../../home/user/.ssh/authorized_keys',
  '../../data/p80.db',
  '..',
  '../',
  '....//....//etc/passwd',
  '/etc/passwd',
  'C:\\Windows\\System32\\drivers\\etc\\hosts',
  'x.srt:$DATA',
  'x.srt\u0000.png',
  '.'.repeat(64),
  'a'.repeat(4096),
  '',
  'lektion-3.srt',
];

describe('transcriptStoragePath', () => {
  it('produces the same path no matter what filename was uploaded', () => {
    const expected = transcriptStoragePath({
      storageRoot: ROOT,
      videoId: VIDEO,
      transcriptFileId: FILE,
      format: 'srt',
    });
    // The filename is not an argument. That is the point — there is no parameter through
    // which any of the strings above could reach the path.
    expect(expected).toBe(`${ROOT}/transcripts/${VIDEO}/${FILE}.srt`);
    expect(expected.startsWith(`${ROOT}${sep}`)).toBe(true);
  });

  it('picks the extension from the sniffed format, never from a filename', () => {
    const ext = (format: 'vtt' | 'srt' | 'pasted_timestamped' | 'internal_json') =>
      transcriptStoragePath({
        storageRoot: ROOT,
        videoId: VIDEO,
        transcriptFileId: FILE,
        format,
      }).split('.').pop();

    expect(ext('vtt')).toBe('vtt');
    expect(ext('srt')).toBe('srt');
    expect(ext('pasted_timestamped')).toBe('txt');
    expect(ext('internal_json')).toBe('json');
  });

  it('refuses an id that is not a ULID', () => {
    // Traversal is impossible because the alphabet has no `.` and no `/`. This assertion
    // guards the assumption: a caller passing a user-supplied string as an id is exactly
    // the mistake the structural guarantee depends on not happening.
    for (const bad of ['../..', 'not-a-ulid', '', VIDEO.toLowerCase(), `${VIDEO}X`]) {
      expect(() =>
        transcriptStoragePath({
          storageRoot: ROOT,
          videoId: bad,
          transcriptFileId: FILE,
          format: 'srt',
        }),
      ).toThrow(/ULID/);
      expect(() =>
        transcriptStoragePath({
          storageRoot: ROOT,
          videoId: VIDEO,
          transcriptFileId: bad,
          format: 'srt',
        }),
      ).toThrow(/ULID/);
    }
  });
});

describe('sanitizeOriginalFilename', () => {
  it('never returns anything containing a path separator or a control character', () => {
    for (const attack of ATTACKS) {
      const cleaned = sanitizeOriginalFilename(attack);
      if (cleaned === null) continue;
      expect(cleaned).not.toContain('/');
      expect(cleaned).not.toContain('\\');
      expect(cleaned).not.toMatch(/^\.+/);
      expect(cleaned.length).toBeLessThanOrEqual(255);
      // eslint-disable-next-line no-control-regex
      expect(/[\u0000-\u001F\u007F-\u009F]/.test(cleaned)).toBe(false);
    }
  });

  it('keeps an ordinary filename readable, because it is shown to the user', () => {
    expect(sanitizeOriginalFilename('lektion-3.srt')).toBe('lektion-3.srt');
    expect(sanitizeOriginalFilename('Übung 2 — Teil A.vtt')).toBe('Übung 2 — Teil A.vtt');
    expect(sanitizeOriginalFilename('/home/user/subs/folge-1.vtt')).toBe('folge-1.vtt');
    expect(sanitizeOriginalFilename('C:\\subs\\folge-1.vtt')).toBe('folge-1.vtt');
  });

  it('collapses a name with nothing left in it to null', () => {
    expect(sanitizeOriginalFilename('...')).toBeNull();
    expect(sanitizeOriginalFilename('   ')).toBeNull();
    expect(sanitizeOriginalFilename('')).toBeNull();
    expect(sanitizeOriginalFilename(null)).toBeNull();
    expect(sanitizeOriginalFilename(undefined)).toBeNull();
  });
});

describe('assertInsideRoot', () => {
  it('accepts a path under the root', () => {
    expect(assertInsideRoot(`${ROOT}/transcripts/${VIDEO}/${FILE}.srt`, ROOT)).toBe(
      `${ROOT}/transcripts/${VIDEO}/${FILE}.srt`,
    );
  });

  it('rejects traversal out of the root', () => {
    expect(() => assertInsideRoot(`${ROOT}/../../etc/passwd`, ROOT)).toThrow(
      /outside the storage root/,
    );
    expect(() => assertInsideRoot('/etc/passwd', ROOT)).toThrow(/outside the storage root/);
  });

  it('rejects a sibling directory that merely shares the prefix', () => {
    // A bare `startsWith(root)` accepts this, which is why the check appends the
    // separator. It is the kind of thing that only shows up when someone names a
    // directory unluckily.
    expect(() => assertInsideRoot('/srv/p80/storage-evil/x.srt', ROOT)).toThrow(
      /outside the storage root/,
    );
  });

  it('normalizes before comparing, so a path is judged by where it lands', () => {
    expect(assertInsideRoot(`${ROOT}/transcripts/../transcripts/x.srt`, ROOT)).toBe(
      `${ROOT}/transcripts/x.srt`,
    );
  });
});
