/** Artifact kinds captured per test execution and streamed to the API. */
export type ArtifactKind = 'trace' | 'screenshot' | 'video';

/** Options passed from the user's playwright.config.ts (the second array element). */
export type NijamReporterOptions = {
  /** Required — API key from the Nijam dashboard. */
  apiKey: string;
  /** Required — the project's ID (UUID) from the Nijam dashboard. */
  projectId: string;
  /** Optional — defaults to https://api.nijam.dev */
  apiUrl?: string;
  /** Optional — suppress [nijam] log lines (default: false). */
  silent?: boolean;
  /** Optional — free-form environment tag (e.g. "staging"). */
  environment?: string;
};

/** CI / git metadata detected from the environment. */
export type RunContext = {
  commitSha?: string;
  branch?: string;
  prNumber?: string;
  ciProvider?: string;
  ciRunId?: string;
  ciRunUrl?: string;
  repository?: string;
  authorEmail?: string;
  authorName?: string;
};

/** Payload sent to POST /v1/runs to open a run. */
export type CreateRunPayload = RunContext & {
  projectId: string;
  environment?: string;
  startedAt: string;
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
};
