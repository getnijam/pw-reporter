# @nijam/pw-reporter, Claude instructions

Playwright reporter for **Nijam**. Implements Playwright's `Reporter` interface to capture test runs and ship them (plus traces) to the Nijam API.

**This is the most public-facing artifact of Nijam**, installed via `npm`, read on GitHub, pasted into users' `playwright.config.ts`. Code quality, minimal dependencies, and a great README matter more here than anywhere else.

License: **MIT** (separate from the BSL platform, must be maximally adoptable, including by enterprises that won't touch BSL).

> `../plans/` is temporary (removed after v0.1). This file is the durable source of truth for the reporter.

## Stack (locked, ask before changing the public options shape)
- TypeScript, strict, `noUncheckedIndexedAccess`.
- **Zero runtime dependencies.** Peer dep: `@playwright/test` (>=1.40). Built/tested on Node 22, supports Node 18+.
- HTTP: **native `fetch`** only (no axios/node-fetch/undici/ofetch).
- Build: `tsup` → dual ESM/CJS + `.d.ts` (`target: node18`).
- Manual testing only, no automated suite in v0.1.

## Layout
```
src/
  reporter.ts   # NijamReporter (default export), implements Reporter
  client.ts     # NijamClient, HTTP to the Nijam API (native fetch)
  ci.ts         # detectRunContext, CI/git metadata
  buffer.ts     # ExecutionBuffer, batch + flush
  trace.ts      # TraceUploader, concurrency-capped trace uploads
  types.ts      # NijamReporterOptions + payload shapes
  log.ts        # [nijam]-prefixed warn/info
  index.ts      # public entry, re-exports reporter
```

## Public API (design backward from this)
```ts
reporter: [['@nijam/pw-reporter', {
  apiKey: process.env.NIJAM_API_KEY,   // required
  projectId: '<project-uuid>',          // required, the project's UUID from the dashboard
  apiUrl: process.env.NIJAM_API_URL,    // optional, default https://api.nijam.dev
  silent: false,                        // optional
  environment: 'staging',               // optional
  autoComplete: true,                   // optional (default true), set false when fanning specs across
                                        //   CI jobs WITHOUT --shard, so a post-matrix step finalizes (see Sharding)
}]]
```
`NijamReporterOptions` is the contract, don't change its shape without asking. Validate at construction; missing `apiKey`/`projectId` → warn with the docs link + `this.disabled = true`, no further work.

## Lifecycle & behavior
- `onBegin` → `detectRunContext` + `POST /v1/runs`, store `runId`; on failure log + no-op the rest of the run.
- `onTestEnd` → build a `TestExecution` (client-generated uuid `id`), push to buffer, fire-and-forget trace upload if `failed`/`timedOut` and a `trace` attachment exists. Never block the test path on the network.
- `onEnd` → drain buffer + uploader, then `PATCH /v1/runs/:id` to finalize with status + stats + `shardIndex`.
- **Sharding** (`--shard=i/N`): each shard is a separate process, but they **club into one Nijam run**. The reporter reads `config.shard` in `onBegin` and sends `shardIndex`/`shardTotal` (+ `ciRunAttempt` from `GITHUB_RUN_ATTEMPT`); the server keys on `ciRunId#attempt` and get-or-creates a single run, stamps each execution's shard, derives run stats from the merged executions, and **only finalizes once every shard reports** (Playwright knows the total). No user config, works automatically when Playwright shards; no post-matrix step needed.
- **Manual fan-out** (`autoComplete: false` / `NIJAM_AUTO_COMPLETE=false`): for teams that split specs across CI matrix jobs **without** `--shard` (e.g. one spec file per job), so the **total is unknown**. With this set, `onEnd` drains/uploads but **skips finalize**, no job ends the clubbed run. A single **post-matrix step** then calls `POST /v1/runs/complete` (keyed by `projectId` + the shared `ciRunId`) to finalize + fire Slack. (`--shard` ignores this, it self-completes.) Until completion the run shows running/failing; the server auto-cancels any run idle >1h as a safety net.
- **Buffer**: flush at 50 items / 2s / `onEnd`. Failed flushes **drop the batch** with a warning (CI is short-lived; no retries).
- **Trace upload**: only `failed`/`timedOut`; stream the `.zip` (never buffer); cap **4 in flight**.
- **CI detection** (`ci.ts`): per-field resolution `CI vars → generic GIT_* → git shell-out → empty`. Captures commit, branch, prNumber, ciProvider, **ciRunId**, ciRunUrl, repository, **authorEmail/authorName**. Providers: GitHub, GitLab, CircleCI, **Bitbucket**, generic. Author email falls back to `git log -1`/`git config user.email` (GitHub/CircleCI/Bitbucket expose no author-email var). **Leave `branch` undefined when unknown**, the dashboard renders "No Branch Info"; never bake that string here.
- **HTTP**: Bearer `apiKey`, 30s `AbortController` timeout, no retries, errors via `log.warn(method, path, status)`.

## Guard rails, do NOT
- ❌ **Throw from any Reporter method**, wrap every async block in try/catch, `log.warn`, continue. The reporter MUST NOT break a user's CI. Ever.
- ❌ **Dynamically `import()`**, static top-level imports only (e.g. `import { createReadStream } from 'node:fs'`).
- ❌ Add runtime dependencies (zero-dep goal) · pull Playwright as a regular dep (peer only).
- ❌ Block `onTestEnd` on network · do sync file I/O on the test path · retry failed API calls.
- ❌ Log at info level by default (noisy CI) · `console.log` in src (use `log.ts`).
- ❌ Mutate the input options object (clone first) · read user code/config beyond what's passed in.
- ❌ Change `NijamReporterOptions` shape without asking.
- ❌ **Ternary hell**, never nest ternaries (`a ? b : c ? d : e`, or a ternary inside a branch); one `cond ? a : b` level max. Use a lookup object, an early-return helper, or `if`/`else`. ❌ **IIFEs** (`(() => { … })()`), name the function and call it.
- ❌ **Em dashes (U+2014) or en dashes (U+2013) anywhere, never generate one.** Not in CLI/log output, error strings, the README, or code/comments. Use a comma, colon, parentheses, or two sentences for prose; a plain hyphen-minus for ranges, IDs, and compound words. The published package must contain zero em/en dashes.

## Build & publish
- `npm run build` (tsup) · `npm run typecheck` · `npm run dev` (watch).
- Versions: `0.1.0-alpha.N` until platform launch, then `0.1.0`; semver after. Bump the alpha on each meaningful change.
- After changes: `pnpm/npm link` into a sample Playwright project and watch behavior. Keep the README copy-paste runnable.
