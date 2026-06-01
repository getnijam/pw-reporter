# @nijam/pw-reporter

Playwright reporter for [Nijam](https://nijam.dev) — captures your test runs and ships them to the Nijam API for run history, flakiness scoring, and trace storage. Think Sentry, for your Playwright suite.

## Install

```bash
npm install --save-dev @nijam/pw-reporter
```

## Configure

Add it to your `playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  reporter: [
    [
      "@nijam/pw-reporter",
      {
        apiKey: process.env.NIJAM_API_KEY,
        projectId: "b4fdfc06-76a2-4721-89eb-9d070add8a5a", // the project's UUID from the dashboard
        apiUrl: process.env.NIJAM_API_URL, // optional, defaults to https://api.nijam.dev
        environment: process.env.NODE_ENV, // optional, free-form tag — filterable in the dashboard
        silent: false, // optional, suppresses [nijam] warnings
      },
    ],
  ],
});
```

That's the whole setup. The reporter is **fail-soft** — if the API is unreachable or misconfigured, it logs a `[nijam]` warning and gets out of the way. It will never break your CI run.

## Where do I get the API key and project ID?

Create a project in your [Nijam dashboard](https://nijam.dev). Copy its **project ID** (a UUID) into `projectId`, and set your API key as `NIJAM_API_KEY` in your CI secrets.

## Options

| Option         | Required | Default                 | Description                                            |
| -------------- | -------- | ----------------------- | ----------------------------------------------------- |
| `apiKey`       | yes      | —                       | API key from the Nijam dashboard.                     |
| `projectId`    | yes      | —                       | The project's ID (UUID) from the dashboard.           |
| `apiUrl`       | no       | `https://api.nijam.dev` | Override for self-hosted instances.                   |
| `silent`       | no       | `false`                 | Suppress all `[nijam]` log lines.                     |
| `environment`  | no       | —                       | Free-form deploy tag (e.g. `"staging"`) — adds a run filter in the dashboard. Runs without it show as **Unset**. |
| `uploadSource` | no       | `true`                  | Upload spec source so the dashboard can show it. Set `false` to opt out. |

## CI auto-detection

Commit, branch, PR number, **CI run id**, CI run URL, and the **git author (email + name)** are detected automatically. Resolution order per field: CI-specific env vars → generic `GIT_*` → `git log`/`git rev-parse` shell-out → empty. Branch is left unset when it can't be determined (the dashboard shows "No Branch Info").

Supported out of the box:

- **GitHub Actions** — `GITHUB_SHA`, `GITHUB_REF_NAME`, `GITHUB_HEAD_REF`, `GITHUB_RUN_ID`, `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`
- **GitLab CI** — `CI_COMMIT_SHA`, `CI_COMMIT_REF_NAME`, `CI_PIPELINE_ID`, `CI_MERGE_REQUEST_IID`, `GITLAB_USER_EMAIL`, `GITLAB_USER_NAME`, `CI_COMMIT_AUTHOR`
- **CircleCI** — `CIRCLE_SHA1`, `CIRCLE_BRANCH`, `CIRCLE_BUILD_NUM`, `CIRCLE_PULL_REQUEST`, `CIRCLE_BUILD_URL`
- **Bitbucket Pipelines** — `BITBUCKET_COMMIT`, `BITBUCKET_BRANCH`, `BITBUCKET_PR_ID`, `BITBUCKET_BUILD_NUMBER`, `BITBUCKET_REPO_FULL_NAME`, `BITBUCKET_GIT_HTTP_ORIGIN`
- **Generic** — `BRANCH`, `COMMIT_SHA`, `CI_URL`, `CI_RUN_ID`

**Author email/name** come from CI vars where available (`GITLAB_USER_EMAIL`, `CI_COMMIT_AUTHOR`); GitHub, CircleCI, and Bitbucket don't expose a commit-author email, so the reporter falls back to `git log -1` and then `git config user.email`.

## Environments

Pass `environment` to tag each run with its deploy target — any string you like (`"staging"`, `"production"`, `"pr-preview"`, …), often wired to an env var so each pipeline reports its own:

```ts
environment: process.env.DEPLOY_ENV, // or "staging", process.env.NODE_ENV, etc.
```

The dashboard's run list then offers an **environment filter** to scope runs to one target. Runs reported without an `environment` are grouped under **Unset**, so you can always tell which runs carried no environment info.

## Uploading test source

So the **test detail** page can render each test inline with its run history (instead of only linking out to your repo), the reporter uploads each spec file's source. This is **on by default**. After the run it reads each unique spec file that produced a test and uploads it (paths relative to the Playwright `rootDir`). Like everything else it's **fail-soft and non-blocking**: files over **256 KB are skipped**, uploads are capped at 4 concurrent, and any read/upload error is logged as a `[nijam]` warning and ignored.

Only the `*.spec`/`*.test` files Playwright runs are uploaded — never your application code. If your spec files are sensitive, opt out with `uploadSource: false` (the dashboard still links to the source at the run's commit via your provider — GitHub/GitLab/Bitbucket):

```ts
reporter: [
  [
    "@nijam/pw-reporter",
    {
      apiKey: process.env.NIJAM_API_KEY,
      projectId: "<project-uuid>",
      uploadSource: false, // ← don't send spec source to Nijam
    },
  ],
],
```

## Traces

Traces are uploaded only for tests that **fail** or **time out** (matching Playwright's default `on-first-retry` trace mode). Uploads stream straight to storage, never block your tests, and are capped at 4 concurrent uploads to spare CI bandwidth.

## Self-hosting

Running Nijam yourself? Point `apiUrl` at your instance. See [nijam.dev/docs/self-host](https://nijam.dev/docs/self-host).

## License

MIT
