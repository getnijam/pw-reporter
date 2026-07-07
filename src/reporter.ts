import { randomUUID } from 'node:crypto';
import { isAbsolute, relative, sep } from 'node:path';
import { readFile } from 'node:fs/promises';
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from '@playwright/test/reporter';
import { NijamClient } from './client.js';
import { ExecutionBuffer } from './buffer.js';
import { ArtifactUploader } from './artifacts.js';
import { detectRunContext, detectGitRoot, envInt } from './ci.js';
import { log, setSilent } from './log.js';
import type {
  ExecutionStatus,
  FinalizeRunPayload,
  NijamReporterOptions,
  TestExecutionPayload,
} from './types.js';

const SETUP_DOCS = 'https://docs.nijam.dev/reporter/configuration/';
const SHARD_DOCS = 'https://docs.nijam.dev/reporter/ci-integration/#sharded-runs';

/**
 * Nijam Playwright reporter. Captures runs and ships them to the Nijam API.
 *
 * Golden rule: NEVER throw from a Reporter method. Every async block is wrapped
 * in try/catch; on any failure we log via [nijam] and continue (or no-op the run).
 */
export default class NijamReporter implements Reporter {
  private readonly options: NijamReporterOptions;
  private disabled = false;
  private runId: string | null = null;
  // The run's dashboard URL (from createRun), printed at the start and again at the
  // end of the log so it's clickable from CI / terminal output without scrolling back.
  private runUrl: string | null = null;
  private startedAt = new Date().toISOString();
  // Playwright `--shard` info (1-based index + total); undefined when not sharding.
  private shardIndex: number | undefined;
  private shardTotal: number | undefined;
  // Playwright rootDir, the fallback base for spec paths when there's no git repo.
  private rootDir = '';
  // Git repo root, the PRIMARY base for spec paths: relative to it gives the
  // repo-relative path the dashboard's View-source links need (keeps a monorepo
  // subfolder prefix). rootDir is the no-git fallback. Never an absolute path.
  private gitRoot = '';
  // Unique spec files seen (relative key → absolute path), uploaded in onEnd when
  // source upload is enabled.
  private readonly sourceFiles = new Map<string, string>();
  // Source upload is opt-out: on by default, off only when explicitly `false`.
  private readonly uploadSource: boolean;
  // Finalize-on-end is opt-out: on by default. Off when the user fans tests across
  // jobs (autoComplete:false / NIJAM_AUTO_COMPLETE=false) so a single post-matrix
  // step completes the shared run; Playwright `--shard` is handled separately.
  private readonly autoComplete: boolean;

  private client!: NijamClient;
  private buffer!: ExecutionBuffer;
  private uploader!: ArtifactUploader;

  // Final outcome per test id, deduped so retries don't inflate run totals.
  private readonly outcomes = new Map<string, ReturnType<TestCase['outcome']>>();

  constructor(options: NijamReporterOptions) {
    // Clone, never mutate the input options object Playwright owns.
    this.options = { ...options };
    setSilent(this.options.silent ?? false);
    this.uploadSource = this.options.uploadSource !== false;
    const envAutoCompleteOff = ['false', '0', 'no', 'off'].includes(
      (process.env.NIJAM_AUTO_COMPLETE ?? '').trim().toLowerCase(),
    );
    this.autoComplete = this.options.autoComplete ?? !envAutoCompleteOff;

    if (!this.options.apiKey || !this.options.projectId) {
      log.warn(
        `missing ${!this.options.apiKey ? 'apiKey' : 'projectId'}, reporter disabled. See ${SETUP_DOCS}`,
      );
      this.disabled = true;
      return;
    }

    this.client = new NijamClient(this.options.apiKey, this.options.apiUrl);
    this.buffer = new ExecutionBuffer((batch) => this.flushBatch(batch));
    this.uploader = new ArtifactUploader(this.client);
  }

  // Playwright reads this to decide whether stdout/stderr is captured per test.
  printsToStdio(): boolean {
    return false;
  }

  async onBegin(config: FullConfig, suite: Suite): Promise<void> {
    if (this.disabled) return;
    try {
      // When running `--shard=i/N`, Playwright sets config.shard; all shards of one
      // CI run share a correlation key server-side, so they club into one run. Manual
      // fan-out (specs split across CI jobs WITHOUT --shard) has no config.shard, so
      // fall back to NIJAM_SHARD_INDEX / NIJAM_SHARD_TOTAL, each job stamps its machine
      // and the clubbed run auto-completes once all shards report (like native --shard).
      this.shardIndex = config.shard?.current ?? envInt('NIJAM_SHARD_INDEX');
      this.shardTotal = config.shard?.total ?? envInt('NIJAM_SHARD_TOTAL');
      this.rootDir = config.rootDir;
      this.gitRoot = detectGitRoot() ?? '';

      const context = detectRunContext(this.options);
      this.startedAt = new Date().toISOString();
      const created = await this.client.createRun({
        ...context,
        projectId: this.options.projectId,
        environment: this.options.environment,
        startedAt: this.startedAt,
        shardIndex: this.shardIndex,
        shardTotal: this.shardTotal,
        // Set by `nijam-pw fetch-failed` when this run is a failed-only retry, so the
        // dashboard tags it "re-run of failed".
        partialRerun: isRerun(),
      });

      if (!created) {
        // Couldn't open a run, no-op the rest of this run.
        this.disabled = true;
        log.warn('could not create run; reporting disabled for this run');
        return;
      }
      this.runId = created.id;
      this.runUrl = created.url ?? null;
      // Print the run's dashboard link so it's clickable straight from CI / terminal logs.
      log.info(this.runUrl ? `run started, view it at ${this.runUrl}` : `run started (${created.id})`);

      // Report the full suite up front so the dashboard shows the true total and every
      // spec file immediately, instead of a count that climbs as tests finish. `suite`
      // is this shard's slice; the server sums the totals and unions the files. Fire and
      // forget, it resolves while tests run and soft-fails without affecting the run.
      const allTests = suite.allTests();
      const plannedFiles = [
        ...new Set(allTests.map((t) => relativeFile(t.location.file, this.rootDir, this.gitRoot))),
      ];
      void this.client.plan(this.runId, { plannedTotal: allTests.length, plannedFiles });
    } catch (err) {
      this.disabled = true;
      log.warn(`onBegin failed: ${describe(err)}`);
    }
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (this.disabled || !this.runId) return;
    try {
      const status = normalizeStatus(result.status);
      this.outcomes.set(test.id, test.outcome());

      const executionId = randomUUID();
      const file = relativeFile(test.location.file, this.rootDir, this.gitRoot);
      const payload: TestExecutionPayload = {
        id: executionId,
        testId: test.id,
        title: test.title,
        titlePath: test.titlePath(),
        file,
        projectName: test.parent.project()?.name,
        status,
        durationMs: result.duration,
        retry: result.retry,
        errorMessage: result.error?.message,
        line: test.location.line,
        startedAt: result.startTime.toISOString(),
      };

      if (this.uploadSource && !this.sourceFiles.has(file)) {
        this.sourceFiles.set(file, test.location.file);
      }

      this.buffer.add(payload);
      // Fire-and-forget; never block test execution on a network call.
      this.uploader.maybeUpload(this.runId, executionId, result);
    } catch (err) {
      log.warn(`onTestEnd failed: ${describe(err)}`);
    }
  }

  async onEnd(result: FullResult): Promise<void> {
    if (this.disabled || !this.runId) return;
    try {
      await this.buffer.drain();
      await this.uploader.drain();
      if (this.uploadSource) await this.uploadSources();

      // Manual fan-out (autoComplete:false / NIJAM_AUTO_COMPLETE=false): this process
      // is one of many feeding a shared run whose total ISN'T known (e.g. a matrix
      // where each job runs a different spec), so it must NOT finalize, a single
      // post-matrix step completes the run via `POST /v1/runs/complete`. Playwright
      // `--shard` is different: each shard finalizes (sending its index) and the
      // server completes the run once every shard has reported, so no extra step is
      // needed. Either way the dashboard shows running/failing until completion (the
      // server also auto-cancels runs idle >1h).
      if (!this.autoComplete) {
        log.info(`this job done, complete the run via your post-matrix step (see ${SHARD_DOCS})`);
        if (this.runUrl) log.info(`view the run at ${this.runUrl}`);
        return;
      }

      const stats = this.computeStats();
      const payload: FinalizeRunPayload = {
        status: normalizeRunStatus(result.status),
        finishedAt: new Date().toISOString(),
        stats,
        // Which shard finalized, for `--shard` runs, the server marks it reported and
        // completes the clubbed run once all shards are in. Undefined when not sharding.
        shardIndex: this.shardIndex,
      };
      await this.client.finalizeRun(this.runId, payload);
      log.info(
        `run finalized (${stats.passed}/${stats.total} passed)${this.runUrl ? `, view it at ${this.runUrl}` : ''}`,
      );
    } catch (err) {
      log.warn(`onEnd failed: ${describe(err)}`);
    }
  }

  onError(error: { message?: string }): void {
    if (this.disabled) return;
    log.warn(`playwright error: ${error.message ?? 'unknown'}`);
  }

  private async flushBatch(batch: TestExecutionPayload[]): Promise<void> {
    if (!this.runId) return;
    await this.client.sendExecutions(this.runId, batch, this.shardIndex);
  }

  /** Read + upload each unique spec file's source (≤4 concurrent; soft-fail). */
  private async uploadSources(): Promise<void> {
    if (!this.runId) return;
    const MAX_BYTES = 256 * 1024;
    const entries = [...this.sourceFiles.entries()];
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < entries.length) {
        const [rel, abs] = entries[next++]!;
        try {
          const content = await readFile(abs, 'utf8');
          if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) continue; // skip oversized
          await this.client.uploadSource(this.runId!, rel, content);
        } catch (err) {
          log.warn(`source upload failed for ${rel}: ${describe(err)}`);
        }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  /** Roll the per-test final outcomes up into run-level totals. */
  private computeStats(): FinalizeRunPayload['stats'] {
    const stats = { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
    for (const outcome of this.outcomes.values()) {
      stats.total++;
      switch (outcome) {
        case 'expected':
          stats.passed++;
          break;
        case 'flaky':
          // Flaky tests ultimately passed, but are flagged separately.
          stats.passed++;
          stats.flaky++;
          break;
        case 'unexpected':
          stats.failed++;
          break;
        case 'skipped':
          stats.skipped++;
          break;
      }
    }
    return stats;
  }
}

function normalizeStatus(status: TestResult['status']): ExecutionStatus {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'failed':
      return 'failed';
    case 'timedOut':
      return 'timedOut';
    case 'skipped':
      return 'skipped';
    default:
      return 'interrupted';
  }
}

function normalizeRunStatus(status: FullResult['status']): FinalizeRunPayload['status'] {
  switch (status) {
    case 'passed':
      return 'passed';
    case 'timedout':
      return 'timedout';
    case 'interrupted':
      return 'interrupted';
    default:
      return 'failed';
  }
}

/**
 * Spec path relative to the **git repo root** when available, else Playwright's
 * rootDir, normalized to `/`. The repo-root form is what the dashboard needs to
 * build a working "View source" link: GitHub/GitLab serve files at
 * `/blob/<sha>/<repo-relative-path>`, so a monorepo that runs Playwright from a
 * subfolder must keep that prefix (`qa-smoke/login.spec.ts`, not `login.spec.ts`).
 * Falls back to rootDir-relative (no git), then the basename, never an absolute
 * machine path, which would 404 the View-source link.
 */
function relativeFile(file: string, rootDir: string, gitRoot?: string): string {
  // gitRoot first: relative(gitRoot, file) is the path the provider expects under
  // /blob/<sha>/…. rootDir-relative drops any folder between the repo root and
  // Playwright's rootDir, breaking the link (and disambiguation) in monorepos.
  for (const base of [gitRoot, rootDir]) {
    if (!base) continue;
    const rel = relative(base, file);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return sep === '/' ? rel : rel.split(sep).join('/');
    }
  }
  return file.split(/[\\/]/).pop() || file;
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether this run re-ran only failed tests (NIJAM_RERUN, set by `nijam-pw fetch-failed`). */
function isRerun(): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env.NIJAM_RERUN ?? '').trim().toLowerCase());
}
