import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from '../packages/core/src/paths.js';

/**
 * What the container deployment is not allowed to quietly stop doing (ADR 0025).
 *
 * These are text assertions over the Dockerfile and the compose file, in the same spirit
 * as `test/docs-hygiene.test.ts` and for the same reason: the alternative is building an
 * image in CI on the wrong architecture to discover that somebody deleted a flag. A regex
 * cannot tell you the deployment works. It can tell you the four properties that were
 * decided on purpose are still written down.
 *
 * Each one below is a defect that has either already happened here or would be invisible
 * until a transcription failed minutes into a job.
 */

const REPO = findRepoRoot(process.cwd());

const read = (path: string) => readFileSync(join(REPO, path), 'utf8');

/** Comment lines explain the wrong way in order to rule it out, so matching them would
 *  make several of these checks fail on their own rationale. Same helper, same reason, as
 *  `test/deploy-parity.test.ts`. */
function instructions(path: string): string {
  return read(path)
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
}

describe('the sidecar image bakes in its ASR extra', () => {
  const dockerfile = instructions('deploy/docker/Dockerfile.nlp');

  it('runs uv sync at all', () => {
    // Guards the guard. A rewrite that installed dependencies some other way would make
    // the assertion below pass vacuously.
    expect(dockerfile).toMatch(/uv sync/);
  });

  it.each([...dockerfile.matchAll(/uv sync[^\n\\]*/g)].map((m) => m[0].trim()))(
    'asks for the ASR extra: %s',
    (invocation) => {
      expect(
        invocation.includes('--extra asr'),
        `\ndeploy/docker/Dockerfile.nlp runs \`${invocation}\`.\n` +
          'The whole reason this image exists is that the ASR extra cannot be pruned out\n' +
          'of it. An image built without `--extra asr` reports transcribe_available:false\n' +
          'and every TRANSCRIBE job fails ASR_UNAVAILABLE. See ADR 0025.\n',
      ).toBe(true);
    },
  );

  it('pins the uv it builds with', () => {
    // `:latest` would let the resolver change under a rebuild, which is the same class of
    // problem — an environment moving without anybody deciding it should — that this
    // image is here to remove.
    const copied = dockerfile.match(/COPY --from=ghcr\.io\/astral-sh\/uv:(\S+)/);
    expect(copied?.[1]).toBeDefined();
    expect(copied?.[1]).not.toBe('latest');
  });
});

describe('compose keeps the guarantees the systemd units made', () => {
  const compose = read('docker-compose.yml');
  const instructionsOnly = instructions('docker-compose.yml');

  /** The `x-node` anchor block: everything the TypeScript services share, which is where
   *  their media mount is written once rather than four times. */
  const anchorBlock = () => compose.slice(compose.indexOf('x-node:'), compose.indexOf('\nservices:'));

  /** One service's YAML block, by name. Crude but exact: a service key is the only thing
   *  at two-space indentation, so the next one ends the block. */
  function serviceBlock(name: string): string {
    const start = compose.indexOf(`\n  ${name}:\n`);
    expect(start, `no ${name} service in docker-compose.yml`).toBeGreaterThan(-1);
    const rest = compose.slice(start + 1);
    const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1 ? rest : rest.slice(0, next + 1);
  }

  const mediaMode = (block: string) =>
    block.match(/\$\{P80_MEDIA_ROOT[^}]*\}:[^:\n]+:(\w+)/)?.[1];

  it('binds loopback in the host namespace rather than publishing a port', () => {
    // CLAUDE.md rule 13. Under `network_mode: host` the process still reads
    // P80_BIND_HOST and binds 127.0.0.1 itself. Swapping to a bridge network moves that
    // guarantee out of the process and into a publish flag, which is a decision, not a
    // refactor.
    expect(instructionsOnly).toMatch(/network_mode:\s*host/);
    expect(instructionsOnly).not.toMatch(/^\s*ports:/m);
  });

  it('never writes a home directory into a tracked file', () => {
    // Rule 19, and portability. The media root is one machine's answer; the compose file
    // has to ask for it rather than know it.
    expect(instructionsOnly).not.toMatch(/\/home\/[a-z]/i);
    expect(compose).toContain('${P80_MEDIA_ROOT');
  });

  it('fails loudly when the media root is unset', () => {
    // `config.ts` gives P80_MEDIA_ROOT no default on the grounds that a wrong guess would
    // be a silent one. An empty interpolation here would bind-mount the working directory
    // and be exactly that.
    expect(compose).toMatch(/\$\{P80_MEDIA_ROOT:\?/);
  });

  it('mounts the media root at the same absolute path it has on the host', () => {
    // The worker sends the sidecar an already-resolved absolute path and the sidecar opens
    // it without re-deriving containment. Mounting somewhere else means it opens the wrong
    // file, or no file — ADR 0021 named this as the central risk of containerising P80,
    // and it is the one property here that is silently wrong rather than loudly broken.
    const mounts = [...compose.matchAll(/\$\{P80_MEDIA_ROOT[^}]*\}:([^:\n]+):(\w+)/g)];
    expect(mounts.length, 'no media-root bind mount found').toBeGreaterThan(0);
    for (const [, target] of mounts) expect(target).toBe('${P80_MEDIA_ROOT}');
  });

  it('gives the sidecar read-only media and the API read-write', () => {
    // Rule 3 puts every media write in the API, into `<media root>/uploads/` and its
    // staging directory. The sidecar only reads, so `ro` makes that a property of the mount
    // rather than an observation about the code — and a second writer would be the exact
    // thing `test/media-policy.test.ts` exists to refuse.
    expect(mediaMode(serviceBlock('nlp'))).toBe('ro');
    // The shared block the API, worker, migrate, and backup all inherit.
    expect(mediaMode(anchorBlock())).toBe('rw');
  });

  it('keeps the speech-model cache off the container filesystem', () => {
    // Roughly 1.5 GB, and an image that re-downloads it per start fails as slowness rather
    // than as misconfiguration. The sidecar's systemd unit pinned HF_HOME explicitly for
    // this reason before ADR 0025, and the container has to keep doing it.
    expect(compose).toContain('/.cache/huggingface');
  });
});
