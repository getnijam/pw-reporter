#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { NijamClient } from './client.js';
import { detectRunContext } from './ci.js';
import type { FailedTest } from './types.js';

/**
 * `nijam-pw` CLI. The one subcommand, `fetch-failed`, asks the Nijam API which
 * tests failed in the previous run of this CI run and prints `file:line` tokens you
 * feed straight to Playwright, so a retry runs ONLY the failures:
 *
 *   nijam-pw fetch-failed --output failed.txt --export-env "$GITHUB_ENV"
 *   [ -s failed.txt ] && npx playwright test $(cat failed.txt)
 *
 * It also writes NIJAM_RUN_GROUP / NIJAM_RUN_ATTEMPT / NIJAM_RERUN (via --export-env)
 * so the retry's reporter run clubs under the original run in the dashboard.
 *
 * Unlike the reporter, this is a normal CLI: tokens go to stdout, diagnostics to
 * stderr. It never exits non-zero on a fetch/network failure (it just emits nothing,
 * so the caller's `[ -s ... ]` guard runs the full suite), only on bad usage.
 */

const HELP = `nijam-pw, Nijam Playwright helper

Usage:
  nijam-pw fetch-failed [options]

Fetch the previous run's failed tests so a retry runs only those.

Options:
  -o, --output <file>     Write the file:line tokens to <file> (default: stdout)
      --export-env <file> Append NIJAM_RUN_GROUP/ATTEMPT/RERUN as KEY=value lines
                          (use "$GITHUB_ENV" on GitHub Actions so the retry clubs)
      --project <uuid>    Project id (default: $NIJAM_PROJECT_ID)
      --ci-run-id <id>    The original CI run id to pull failures from
                          (default: auto-detected; set on CIs that mint a new id on retry)
      --api-url <url>     API base URL (default: $NIJAM_API_URL or https://api.nijam.dev)
      --api-key <key>     Ingest key (default: $NIJAM_API_KEY)
  -h, --help              Show this help

Env: NIJAM_API_KEY, NIJAM_PROJECT_ID, NIJAM_API_URL
Docs: https://docs.nijam.dev/guides/rerun-failed-tests/`;

interface Flags {
  output?: string;
  exportEnv?: string;
  project?: string;
  ciRunId?: string;
  apiUrl?: string;
  apiKey?: string;
  help?: boolean;
}

type StringFlag = 'output' | 'exportEnv' | 'project' | 'ciRunId' | 'apiUrl' | 'apiKey';

const FLAG_ALIASES: Record<string, StringFlag> = {
  '-o': 'output',
  '--output': 'output',
  '--export-env': 'exportEnv',
  '--project': 'project',
  '--ci-run-id': 'ciRunId',
  '--api-url': 'apiUrl',
  '--api-key': 'apiKey',
};

function out(text: string): void {
  process.stdout.write(text);
}

function err(message: string): void {
  process.stderr.write(`[nijam] ${message}\n`);
}

function parseArgs(argv: string[]): { command?: string; flags: Flags } {
  const flags: Flags = {};
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg.startsWith('-')) {
      const key = FLAG_ALIASES[arg];
      if (!key) throw new Error(`unknown option: ${arg}`);
      const value = argv[++i];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      flags[key] = value;
    } else if (!command) {
      command = arg;
    }
  }
  return { command, flags };
}

/** Playwright runs a single test by `file:line`; fall back to the whole file. */
function toToken(t: FailedTest): string {
  return t.line != null ? `${t.file}:${t.line}` : t.file;
}

async function fetchFailed(flags: Flags): Promise<number> {
  const apiKey = flags.apiKey ?? process.env.NIJAM_API_KEY;
  const projectId = flags.project ?? process.env.NIJAM_PROJECT_ID;
  if (!apiKey || !projectId) {
    err(`missing ${!apiKey ? 'API key (NIJAM_API_KEY)' : 'project id (NIJAM_PROJECT_ID)'}`);
    return 2;
  }

  const ctx = detectRunContext();
  const ciRunId = flags.ciRunId ?? ctx.ciRunId;
  if (!ciRunId) {
    // No CI run id to correlate against, the caller should run the full suite.
    err('no CI run id detected; pass --ci-run-id to fetch failures. Running nothing to re-run.');
    if (flags.output) writeFileSync(flags.output, '');
    return 0;
  }

  const client = new NijamClient(apiKey, flags.apiUrl ?? process.env.NIJAM_API_URL);
  const result = await client.fetchFailedTests(projectId, ciRunId);
  const tests = result?.tests ?? [];

  // Dedupe tokens (a file may have several failed tests at distinct lines).
  const tokens = [...new Set(tests.map(toToken))];
  const body = tokens.length ? tokens.join('\n') + '\n' : '';
  if (flags.output) writeFileSync(flags.output, body);
  else out(body);

  // Tell the retry's reporter run to club under the original run and tag itself a
  // partial re-run. Next attempt is the prior attempt + 1, but never below the
  // native CI attempt (a GitHub "re-run failed jobs" already bumped it).
  if (flags.exportEnv) {
    const nativeAttempt = ctx.ciRunAttempt ? Number.parseInt(ctx.ciRunAttempt, 10) || 0 : 0;
    const nextAttempt = Math.max((result?.attempt ?? 0) + 1, nativeAttempt || 1);
    appendFileSync(
      flags.exportEnv,
      `NIJAM_RUN_GROUP=${ciRunId}\nNIJAM_RUN_ATTEMPT=${nextAttempt}\nNIJAM_RERUN=1\n`,
    );
  }

  err(
    tokens.length
      ? `${tokens.length} failed test(s) from the previous run; feed them to playwright test`
      : 'no failed tests from the previous run; nothing to re-run',
  );
  return 0;
}

async function main(): Promise<void> {
  let parsed: { command?: string; flags: Flags };
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    out(`${HELP}\n`);
    process.exit(2);
  }

  if (parsed.flags.help || !parsed.command) {
    out(`${HELP}\n`);
    process.exit(0);
  }

  if (parsed.command === 'fetch-failed') {
    process.exit(await fetchFailed(parsed.flags));
  }

  err(`unknown command: ${parsed.command}`);
  out(`${HELP}\n`);
  process.exit(2);
}

void main();
