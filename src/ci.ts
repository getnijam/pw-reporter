import { execFileSync } from 'node:child_process';
import type { NijamReporterOptions, RunContext } from './types.js';

const env = process.env;

type GitAuthor = { email?: string; name?: string };

/** First non-empty value wins. */
function firstOf(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

/** Last-resort commit SHA from git. Swallows errors (shallow clones, no git, etc.). */
function gitHead(): string | undefined {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return undefined;
  }
}

/** HEAD commit author (email + name) from git. Swallows errors. */
function gitAuthor(): GitAuthor {
  try {
    const out = execFileSync('git', ['log', '-1', '--format=%ae%n%an'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const lines = out.split('\n');
    return { email: lines[0]?.trim() || undefined, name: lines[1]?.trim() || undefined };
  } catch {
    return {};
  }
}

/** Configured git email (often a bot in CI) — last-resort fallback. */
function gitConfigEmail(): string | undefined {
  try {
    return (
      execFileSync('git', ['config', 'user.email'], {
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
      }).trim() || undefined
    );
  } catch {
    return undefined;
  }
}

/** Parse a "Display Name <email@host>" string into parts. */
function parseAuthor(raw: string | undefined): GitAuthor {
  if (!raw) return {};
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1]?.trim() || undefined, email: m[2]?.trim() || undefined };
  return raw.includes('@') ? { email: raw.trim() } : { name: raw.trim() };
}

function githubRunUrl(): string | undefined {
  if (!env.GITHUB_RUN_ID || !env.GITHUB_REPOSITORY) return undefined;
  const server = env.GITHUB_SERVER_URL ?? 'https://github.com';
  return `${server}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function bitbucketRunUrl(): string | undefined {
  const origin = env.BITBUCKET_GIT_HTTP_ORIGIN;
  const num = env.BITBUCKET_BUILD_NUMBER;
  if (!origin || !num) return undefined;
  return `${origin.replace(/\/+$/, '')}/pipelines/results/${num}`;
}

/**
 * Detect commit / branch / PR / CI run id+url / git author from the environment.
 * Resolution order per field: CI-specific > generic GIT_* > git shell-out > empty.
 * Branch stays undefined when unknown — the dashboard renders "No Branch Info".
 */
export function detectRunContext(_options: NijamReporterOptions): RunContext {
  const ciProvider = env.GITHUB_ACTIONS
    ? 'github'
    : env.GITLAB_CI
      ? 'gitlab'
      : env.CIRCLECI
        ? 'circleci'
        : env.BITBUCKET_BUILD_NUMBER || env.BITBUCKET_PIPELINE_UUID
          ? 'bitbucket'
          : env.CI
            ? 'generic'
            : undefined;

  const commitSha = firstOf(
    env.GITHUB_SHA,
    env.CI_COMMIT_SHA,
    env.CIRCLE_SHA1,
    env.BITBUCKET_COMMIT,
    env.COMMIT_SHA,
    env.GIT_COMMIT,
    gitHead(),
  );

  const branch = firstOf(
    env.GITHUB_HEAD_REF, // PR source branch on GitHub
    env.GITHUB_REF_NAME,
    env.CI_COMMIT_REF_NAME,
    env.CIRCLE_BRANCH,
    env.BITBUCKET_BRANCH, // absent on tag builds → stays undefined
    env.BRANCH,
    env.GIT_BRANCH,
  );

  const prNumber = firstOf(
    env.CI_MERGE_REQUEST_IID,
    env.CIRCLE_PULL_REQUEST?.split('/').pop(),
    env.BITBUCKET_PR_ID,
  );

  const ciRunId = firstOf(
    env.GITHUB_RUN_ID,
    env.CI_PIPELINE_ID, // GitLab
    env.CIRCLE_BUILD_NUM,
    env.BITBUCKET_BUILD_NUMBER,
    env.CI_RUN_ID,
  );

  // Re-running a workflow keeps the same run id but bumps the attempt; include it
  // in the run's correlation key so a re-run is a fresh run, not a merge.
  const ciRunAttempt = firstOf(env.GITHUB_RUN_ATTEMPT);

  const ciRunUrl = firstOf(
    githubRunUrl(),
    env.CI_PIPELINE_URL,
    env.CIRCLE_BUILD_URL,
    bitbucketRunUrl(),
    env.CI_URL,
  );

  const repository = firstOf(
    env.GITHUB_REPOSITORY,
    env.CI_PROJECT_PATH,
    env.BITBUCKET_REPO_FULL_NAME,
  );

  // Author — single git shell-out, reused for email + name.
  const fromGit = gitAuthor();
  const fromCommitAuthor = parseAuthor(env.CI_COMMIT_AUTHOR); // GitLab "Name <email>"

  const authorEmail = firstOf(
    env.GITLAB_USER_EMAIL, // who triggered the GitLab pipeline
    fromCommitAuthor.email,
    fromGit.email, // GitHub/CircleCI/Bitbucket have no native author-email var
    gitConfigEmail(),
  );

  const authorName = firstOf(
    env.GITLAB_USER_NAME,
    parseAuthor(env.BITBUCKET_COMMIT_AUTHOR).name,
    fromCommitAuthor.name,
    fromGit.name,
  );

  return {
    commitSha,
    branch,
    prNumber,
    ciProvider,
    ciRunId,
    ciRunAttempt,
    ciRunUrl,
    repository,
    authorEmail,
    authorName,
  };
}
