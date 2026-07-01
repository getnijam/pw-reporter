/** Artifact kinds captured per test execution and streamed to the API. */
export type ArtifactKind = 'trace' | 'screenshot' | 'video';

/** Options passed from the user's playwright.config.ts (the second array element). */
export type NijamReporterOptions = {
  /** Required, API key from the Nijam dashboard. */
  apiKey: string;
  /** Required, the project's ID (UUID) from the Nijam dashboard. */
  projectId: string;
  /** Optional, defaults to https://api.nijam.dev */
  apiUrl?: string;
  /** Optional, suppress [nijam] log lines (default: false). */
  silent?: boolean;
  /** Optional, free-form environment tag (e.g. "staging"). */
  environment?: string;
  /**
   * Optional, upload each spec file's source so the dashboard can show it in the
   * test detail. **On by default**; set `false` to opt out (this ships your test
   * source to Nijam).
   */
  uploadSource?: boolean;
  /**
   * Optional, whether the reporter finalizes the run when this process ends
   * (**default `true`**). Set `false` when you fan tests across multiple CI jobs
   * that DON'T use Playwright `--shard`, e.g. a matrix where each job runs a
   * different spec file. They all club into one Nijam run (shared CI run id), so no
   * single job may finalize it: each only streams its results, and you mark the run
   * complete once with a single post-matrix step (`POST /v1/runs/complete`). Also
   * settable via the `NIJAM_AUTO_COMPLETE=false` env var (handy when one config is
   * reused across contexts). Playwright `--shard` runs defer automatically.
   */
  autoComplete?: boolean;
};

/** CI / git metadata detected from the environment. */
export type RunContext = {
  commitSha?: string;
  branch?: string;
  prNumber?: string;
  ciProvider?: string;
  ciRunId?: string;
  /** CI run attempt (e.g. GITHUB_RUN_ATTEMPT), re-runs get a fresh Nijam run. */
  ciRunAttempt?: string;
  ciRunUrl?: string;
  repository?: string;
  authorEmail?: string;
  authorName?: string;
  /** Who triggered the CI run (actor login, may be a bot), distinct from the commit author. */
  triggeredBy?: string;
};

/** Payload sent to POST /v1/runs to open a run. */
export type CreateRunPayload = RunContext & {
  projectId: string;
  environment?: string;
  startedAt: string;
  /** Playwright shard (1-based) + total, when running `--shard`. Clubs shards into one run. */
  shardIndex?: number;
  shardTotal?: number;
  /** True when this run re-ran only the previous attempt's failed tests (NIJAM_RERUN). */
  partialRerun?: boolean;
};

/** One failed test from the previous run, returned by GET /v1/projects/:id/failed-tests. */
export type FailedTest = {
  testId: string;
  file: string;
  line: number | null;
  title: string;
  titlePath: string[];
  projectName: string | null;
};

/** Response of the failed-tests fetch (re-run only what failed). */
export type FailedTestsResult = {
  runId: string | null;
  ciRunId: string;
  attempt: number | null;
  tests: FailedTest[];
};

export type ExecutionStatus = 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted';

/** A single test execution, buffered and flushed in batches. */
export type TestExecutionPayload = {
  /** Client-generated id so traces can be uploaded without a server round-trip. */
  id: string;
  testId: string;
  title: string;
  titlePath: string[];
  file: string;
  projectName?: string;
  status: ExecutionStatus;
  durationMs: number;
  retry: number;
  errorMessage?: string;
  /** 1-based source line of the test definition (test.location.line). */
  line?: number;
  startedAt: string;
};

/** Payload sent to PATCH /v1/runs/:id to finalize. */
export type FinalizeRunPayload = {
  status: 'passed' | 'failed' | 'timedout' | 'interrupted';
  finishedAt: string;
  stats: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
  };
  /** The finalizing shard, the run completes only once every shard reports. */
  shardIndex?: number;
};
