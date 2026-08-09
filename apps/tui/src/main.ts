#!/usr/bin/env node
import { loadConfig, type Config } from '@p80/core';

/**
 * The management client (ADR 0007).
 *
 * **No TUI framework yet — deliberately.** ADR 0007 requires this client but names no
 * stack, and the surface that decides the stack is the candidate inbox in Stage 5: a
 * long, keyboard-driven, filterable list. Picking Ink or OpenTUI now would be choosing
 * against a screen nobody has designed. Until then this is a plain CLI, and its whole
 * job is to prove the second client exists and holds no domain logic.
 *
 * Everything here goes through `/api/*` and nothing else. No database import, no
 * scoring, no scheduling. If a command here ever needs to compute something, the API
 * response is incomplete (ADR 0007's `curl` test).
 */

const config = loadConfig();
const base = `http://${config.P80_BIND_HOST}:${config.P80_API_PORT}`;

interface HealthReport {
  name: string;
  url: string;
  ok: boolean;
  detail: string;
}

async function probe(name: string, url: string): Promise<HealthReport> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    const body = (await response.json()) as Record<string, unknown>;
    return {
      name,
      url,
      ok: response.ok,
      detail: typeof body.status === 'string' ? body.status : String(response.status),
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      detail: error instanceof Error ? error.message : 'unreachable',
    };
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

async function health(cfg: Config): Promise<number> {
  const reports = await Promise.all([
    probe('api', `${base}/api/health`),
    probe('nlp', `${cfg.P80_NLP_BASE_URL}/health`),
  ]);

  for (const r of reports) {
    process.stdout.write(
      `${r.ok ? '  ok  ' : ' down '} ${pad(r.name, 6)} ${pad(r.url, 34)} ${r.detail}\n`,
    );
  }

  // The web dev server and the worker have no health endpoint of their own — the worker
  // is not an HTTP service at all. Its liveness is visible through the jobs table, which
  // is what `p80 jobs` shows.
  process.stdout.write(
    `\nworker liveness: run \`p80 jobs\` — a claimed job carries claimedBy.\n`,
  );

  return reports.every((r) => r.ok) ? 0 : 1;
}

interface Job {
  id: string;
  jobType: string;
  status: string;
  attemptCount: number;
  maxAttempts: number;
  claimedBy: string | null;
  createdAt: number;
}

async function jobs(): Promise<number> {
  const response = await fetch(`${base}/api/jobs?limit=20`);
  if (!response.ok) {
    const body = (await response.json()) as { error?: { message?: string } };
    process.stderr.write(`${body.error?.message ?? response.statusText}\n`);
    return 1;
  }

  const rows = (await response.json()) as Job[];
  if (rows.length === 0) {
    process.stdout.write('No jobs.\n');
    return 0;
  }

  process.stdout.write(
    `${pad('ID', 28)}${pad('TYPE', 26)}${pad('STATUS', 11)}${pad('TRY', 6)}CLAIMED BY\n`,
  );
  for (const job of rows) {
    process.stdout.write(
      pad(job.id, 28) +
        pad(job.jobType, 26) +
        pad(job.status, 11) +
        pad(`${job.attemptCount}/${job.maxAttempts}`, 6) +
        (job.claimedBy ?? '—') +
        '\n',
    );
  }
  return 0;
}

async function profile(): Promise<number> {
  const response = await fetch(`${base}/api/profile`);
  if (!response.ok) {
    process.stderr.write(`API returned ${response.status}\n`);
    return 1;
  }
  const p = (await response.json()) as Record<string, unknown>;
  for (const [key, value] of Object.entries(p)) {
    process.stdout.write(`${pad(key, 20)}${String(value)}\n`);
  }
  return 0;
}

interface SettingRow {
  key: string;
  tier: 'live' | 'boot';
  value: string | number | boolean;
  source: 'environment' | 'database';
  environmentValue: string | number | boolean;
  editable: boolean;
  description: string;
  invalid?: string;
}

/**
 * `p80 settings` — the management half of ADR 0019's surface.
 *
 * Holds no knowledge of what any setting means. The tier, the editability, the description,
 * and the refusal all come from `/api/settings`; this prints rows and posts strings. That is
 * ADR 0007's rule, and here it is also what lets the web page and this command disagree
 * about nothing.
 */
async function listSettings(): Promise<number> {
  const response = await fetch(`${base}/api/settings`);
  if (!response.ok) {
    process.stderr.write(`API returned ${response.status}\n`);
    return 1;
  }

  const { settings } = (await response.json()) as { settings: SettingRow[] };
  const width = Math.max(...settings.map((s) => s.key.length));

  for (const tier of ['live', 'boot'] as const) {
    const rows = settings.filter((s) => s.tier === tier);
    if (rows.length === 0) continue;

    process.stdout.write(
      tier === 'live'
        ? '\nEditable — takes effect on the next use, no restart\n\n'
        : '\nRead-only — set in .env.local, applied at startup\n\n',
    );

    for (const row of rows) {
      // The source marker matters more than it looks: a value that no longer matches
      // .env.local is overridden, not ignored, and those look identical without it.
      const marker = row.source === 'database' ? '*' : ' ';
      process.stdout.write(`${marker} ${pad(row.key, width + 2)}${String(row.value)}\n`);
      if (row.source === 'database') {
        process.stdout.write(
          `  ${pad('', width + 2)}(.env.local: ${String(row.environmentValue)})\n`,
        );
      }
      if (row.invalid) {
        process.stdout.write(`  ${pad('', width + 2)}! ${row.invalid}\n`);
      }
    }
  }

  process.stdout.write('\n* overridden here; `p80 settings set <key> <value>` to change\n');
  return 0;
}

/**
 * Values arrive as strings and are coerced only for the two unambiguous cases — `true`/
 * `false` and a bare number. Anything else goes as a string and the API's schema decides,
 * which is the right place for it: a client that knew `P80_ASR_LANG_MIN_PROB` was a number
 * would be holding a copy of the registry.
 */
async function setSetting(
  key: string,
  raw: string,
  acknowledgeOrphans: boolean,
): Promise<number> {
  const value =
    raw === 'true' ? true : raw === 'false' ? false : /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;

  const response = await fetch(`${base}/api/settings`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ settings: { [key]: value }, acknowledgeOrphans }),
  });

  if (!response.ok) {
    const body = (await response.json()) as {
      error?: { code?: string; message?: string; details?: Record<string, unknown> };
    };
    process.stderr.write(`${body.error?.message ?? response.statusText}\n`);
    // The orphan gate is a confirmation, not a failure, so it says how to confirm rather
    // than leaving the user to guess that a flag exists.
    if (body.error?.code === 'MEDIA_ROOT_WOULD_ORPHAN') {
      process.stderr.write(
        '\nRe-run with --acknowledge-orphans to proceed. Nothing is deleted, and setting\n' +
          'the root back restores playback for every video.\n',
      );
    }
    return 1;
  }

  process.stdout.write(`${key} set.\n`);
  return 0;
}

function usage(): number {
  process.stdout.write(
    [
      'p80 — P80 management client',
      '',
      'Usage: p80 <command>',
      '',
      '  health    check the API and NLP sidecar',
      '  jobs      list recent background jobs',
      '  profile   show the current profile',
      '  settings  show configuration, editable and read-only',
      '',
      '  settings set <key> <value> [--acknowledge-orphans]',
      '            change one setting. --acknowledge-orphans confirms a media root',
      '            under which some videos would stop resolving.',
      '',
      'Media surfaces — review sessions, the video loop, video detail — are in the',
      'browser client, because playback needs a video surface (ADR 0007).',
      '',
    ].join('\n'),
  );
  return 0;
}

const command = process.argv[2];
const exitCode = await (async () => {
  switch (command) {
    case 'health':
      return health(config);
    case 'jobs':
      return jobs();
    case 'profile':
      return profile();
    case 'settings': {
      if (process.argv[3] !== 'set') return listSettings();
      const [key, value] = [process.argv[4], process.argv[5]];
      if (!key || value === undefined) {
        process.stderr.write('Usage: p80 settings set <key> <value>\n');
        return 1;
      }
      return setSetting(key, value, process.argv.includes('--acknowledge-orphans'));
    }
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      return usage();
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      usage();
      return 1;
  }
})();

process.exit(exitCode);
