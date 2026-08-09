import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as browser from '../src/browser.js';

/**
 * `@p80/core/browser` exists so the web client can import the domain vocabulary and the
 * shared response schemas without dragging `node:fs`, `node:path`, and `pino` into a
 * browser bundle. Exporting a module from `browser.ts` is a claim that it is pure; this
 * test checks the claim rather than trusting it, by walking the transitive imports.
 *
 * Without this, the failure mode is a Vite build that either breaks confusingly or, worse,
 * quietly ships a polyfill.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src');

function transitiveImports(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);

    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/from '(\.[^']+)\.js'/g)) {
      const specifier = match[1];
      if (specifier === undefined) continue;
      queue.push(resolve(dirname(file), `${specifier}.ts`));
    }
  }
  return seen;
}

describe('@p80/core/browser', () => {
  it('reaches no node builtin, transitively', () => {
    const offenders: string[] = [];
    for (const file of transitiveImports(resolve(SRC, 'browser.ts'))) {
      const source = readFileSync(file, 'utf8');
      if (/from 'node:/.test(source) || /require\('node:/.test(source)) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('reaches no node-only dependency', () => {
    const offenders: string[] = [];
    for (const file of transitiveImports(resolve(SRC, 'browser.ts'))) {
      const source = readFileSync(file, 'utf8');
      // `pino` is the one that matters today; `ulid` would be tolerable but belongs on the
      // server, since a client must never mint an id the server has to trust.
      if (/from '(pino|ulid)'/.test(source)) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('exports what a client actually needs', () => {
    // Named rather than counted, so adding an export is a deliberate act and removing one
    // that a client depends on fails here rather than in the browser.
    for (const name of [
      'PARSE_WARNING_KINDS',
      'TRANSCRIPT_STATUSES',
      'PROCESSING_STATUSES',
      'TRANSCRIPT_FORMATS',
      'JOB_STATES',
      'ERROR_CODES',
      'videoResponse',
      'transcriptResponse',
      'transcriptPreviewResponse',
      'segmentResponse',
      'activeSegmentIndexAt',
      'seekTargetMs',
      'expectedSeekWindow',
      'projectCorrections',
      'validateSegmentEdit',
      'formatTimecode',
      'buildMediaDescriptor',
      'resolveSpanTiming',
      'groupWords',
      'jobPollDelayMs',
    ]) {
      expect(browser).toHaveProperty(name);
    }
  });

  it('does not leak the server-only surface', () => {
    for (const name of [
      'loadConfig',
      'createLogger',
      'newId',
      'findRepoRoot',
      'transcriptStoragePath',
      // ADR 0015: the client never holds a filesystem path, so the resolver that decides
      // what is inside the media root has no business being bundled for a browser.
      'resolveMediaPath',
      'assertInsideMediaRoot',
    ]) {
      expect(browser).not.toHaveProperty(name);
    }
  });
});
