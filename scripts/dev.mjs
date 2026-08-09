#!/usr/bin/env node
/**
 * One command starts every local service (spec §35 Stage 1 step 10, exit criterion 1).
 *
 * Four processes, not the spec's three: ADR 0002 added the Python NLP sidecar. As that
 * ADR notes, the application was already multi-process, so a fourth is an incremental
 * cost rather than a new category of complexity.
 *
 * Two long-lived processes are deliberately **not** started here, per `CLAUDE.md` §4:
 *
 *   - **vLLM** (ADR 0005) is expensive to start and expected to be down through Stages
 *     1-6. That is the spec §5.2 degraded path getting free exercise, not a problem.
 *   - **uselimit** is not integrated until enrichment exists, in Stage 6.
 *
 * A third is *conditionally* not started: when `P80_NLP_BASE_URL` names a host other than
 * loopback, the sidecar is running somewhere else and starting a local one would leave a
 * Python process on 5181 that nothing talks to. That is the shape of bug this repo has
 * hit six times — two processes, one of them silently ignored — so the skip is loud.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

if (!existsSync(join(root, '.env.local'))) {
  process.stdout.write(
    'note: no .env.local found; using defaults. `cp .env.example .env.local` to change ports.\n',
  );
}

const COLORS = {
  api: '\u001b[36m',
  worker: '\u001b[35m',
  web: '\u001b[32m',
  nlp: '\u001b[33m',
};
const RESET = '\u001b[0m';
const WIDTH = 6;

/**
 * Where the sidecar is, read the same way `loadConfig()` reads it: the process
 * environment over `.env.local`. Deliberately a small independent parse rather than an
 * import of `@p80/core` — this script runs before anything is built and must not acquire
 * a workspace dependency to answer one question.
 */
function nlpBaseUrl() {
  if (process.env.P80_NLP_BASE_URL) return process.env.P80_NLP_BASE_URL;
  try {
    const file = readFileSync(join(root, '.env.local'), 'utf8');
    for (const line of file.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) continue;
      if (trimmed.slice(0, eq).trim() !== 'P80_NLP_BASE_URL') continue;
      return trimmed.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch {
    // No file is fine — the schema default is loopback.
  }
  return 'http://127.0.0.1:5181';
}

const NLP_URL = nlpBaseUrl();
const nlpIsLocal = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(
  (() => {
    try {
      return new URL(NLP_URL).hostname;
    } catch {
      // An unparseable URL is `loadConfig`'s problem, not this script's. Assume local so
      // the sidecar still starts and the real error surfaces where it belongs.
      return '127.0.0.1';
    }
  })(),
);

const services = [
  { name: 'api', cmd: 'pnpm', args: ['--filter', '@p80/api', 'dev'] },
  { name: 'worker', cmd: 'pnpm', args: ['--filter', '@p80/worker', 'dev'] },
  { name: 'web', cmd: 'pnpm', args: ['--filter', '@p80/web', 'dev'] },
];

if (nlpIsLocal) {
  services.push({
    name: 'nlp',
    cmd: 'uv',
    args: ['run', '--project', join(root, 'services/nlp'), 'p80-nlp'],
  });
} else {
  // Loud, not silent. "Three processes started" and "four processes started" look alike
  // in a scrollback, and the difference decides which machine transcribes.
  process.stdout.write(
    `note: NLP sidecar not started — P80_NLP_BASE_URL points at ${NLP_URL}.\n` +
      '      Start it there, and remember the sidecar opens media paths on its OWN\n' +
      '      filesystem: that host needs P80_MEDIA_ROOT at the same absolute path.\n',
  );
}

const children = [];
let shuttingDown = false;

function prefix(name) {
  const colour = COLORS[name] ?? '';
  return `${colour}${name.padEnd(WIDTH)}${RESET}| `;
}

function pipe(name, stream, sink) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) sink.write(`${prefix(name)}${line}\n`);
  });
}

for (const service of services) {
  const child = spawn(service.cmd, service.args, {
    cwd: root,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  pipe(service.name, child.stdout, process.stdout);
  pipe(service.name, child.stderr, process.stderr);

  child.on('error', (error) => {
    process.stderr.write(
      `${prefix(service.name)}failed to start: ${error.message}\n` +
        (service.name === 'nlp'
          ? `${prefix('nlp')}is uv installed? see docs/SETUP.md\n`
          : ''),
    );
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    process.stderr.write(
      `${prefix(service.name)}exited (${signal ?? code}); shutting the rest down\n`,
    );
    // One dead service means a broken system. Limping along with three of four running
    // produces confusing failures somewhere else entirely.
    shutdown(code ?? 1);
  });

  children.push({ ...service, child });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { child } of children) {
    if (child.exitCode === null) child.kill('SIGTERM');
  }
  setTimeout(() => {
    for (const { child } of children) {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    process.exit(code);
  }, 3000).unref();
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(0));
}
