import { randomUUID } from 'node:crypto';
import { relative, sep } from 'node:path';
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
import { detectRunContext } from './ci.js';
import { log, setSilent } from './log.js';
import type {
  ExecutionStatus,
  FinalizeRunPayload,
  NijamReporterOptions,
  TestExecutionPayload,
} from './types.js';

const SETUP_DOCS = 'https://nijam.dev/docs/setup';

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
  private startedAt = new Date().toISOString();
  // Playwright `--shard` info (1-based index + total); undefined when not sharding.
  private shardIndex: number | undefined;
  private shardTotal: number | undefined;
  // Playwright rootDir — spec paths are stored relative to it (portable across
  // machines / local-vs-CI) instead of the absolute `test.location.file`.
  private rootDir = '';

  private client!: NijamClient;
  private buffer!: ExecutionBuffer;
  private uploader!: ArtifactUploader;

  // Final outcome per test id — deduped so retries don't inflate run totals.
  private readonly outcomes = new Map<string, ReturnType<TestCase['outcome']>>();

  constructor(options: NijamReporterOptions) {
    // Clone — never mutate the input options object Playwright owns.
    this.options = { ...options };
    setSilent(this.options.silent ?? false);

    if (!this.options.apiKey || !this.options.projectId) {
      log.warn(
        `missing ${!this.options.apiKey ? 'apiKey' : 'projectId'} — reporter disabled. See ${SETUP_DOCS}`,
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

  async onBegin(config: FullConfig, _suite: Suite): Promise<void> {
    if (this.disabled) return;
    try {
      // When running `--shard=i/N`, Playwright sets config.shard; all shards of one
      // CI run share a correlation key server-side, so they club into one run.
      this.shardIndex = config.shard?.current;
      this.shardTotal = config.shard?.total;
      this.rootDir = config.rootDir;

      const context = detectRunContext(this.options);
      this.startedAt = new Date().toISOString();
      this.runId = await this.client.createRun({
        ...context,
        projectId: this.options.projectId,
        environment: this.options.environment,
        startedAt: this.startedAt,
        shardIndex: this.shardIndex,
        shardTotal: this.shardTotal,
      });

      if (!this.runId) {
        // Couldn't open a run — no-op the rest of this run.
        this.disabled = true;
        log.warn('could not create run; reporting disabled for this run');
        return;
      }
      log.info(`run started (${this.runId})`);
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
      const payload: TestExecutionPayload = {
        id: executionId,
        testId: test.id,
        title: test.title,
        titlePath: test.titlePath(),
        file: relativeFile(test.location.file, this.rootDir),
        projectName: test.parent.project()?.name,
        status,
        durationMs: result.duration,
        retry: result.retry,
        errorMessage: result.error?.message,
        startedAt: result.startTime.toISOString(),
      };

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

      const stats = this.computeStats();
      const payload: FinalizeRunPayload = {
        status: normalizeRunStatus(result.status),
        finishedAt: new Date().toISOString(),
        stats,
        shardIndex: this.shardIndex,
      };
      await this.client.finalizeRun(this.runId, payload);
      log.info(`run finalized (${stats.passed}/${stats.total} passed)`);
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
 * Spec path relative to Playwright's rootDir (what Playwright's own reporters
 * show), normalized to `/`. Falls back to the absolute path if rootDir is unknown
 * or the file sits outside it — the dashboard then displays just the basename.
 */
function relativeFile(file: string, rootDir: string): string {
  if (!rootDir) return file;
  const rel = relative(rootDir, file);
  if (!rel || rel.startsWith('..')) return file;
  return sep === '/' ? rel : rel.split(sep).join('/');
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
