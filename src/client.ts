import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { log } from './log.js';
import type {
  ArtifactKind,
  CreateRunPayload,
  FinalizeRunPayload,
  TestExecutionPayload,
} from './types.js';

const DEFAULT_API_URL = 'https://api.nijam.dev';
const TIMEOUT_MS = 30_000;

/** Unwrap a native-fetch error to its underlying cause (code + message) for logs. */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.name === 'AbortError') return `timed out after ${TIMEOUT_MS / 1000}s`;
  const cause = (err as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: string }).code;
    return code ? `${code} — ${cause.message}` : cause.message;
  }
  return err.message;
}

export class NijamClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, apiUrl?: string) {
    this.apiKey = apiKey;
    // Default to the hosted API. Treat an unset OR blank apiUrl as "use the default":
    // `apiUrl: process.env.NIJAM_API_URL` with an empty/whitespace NIJAM_API_URL would
    // otherwise pass `''` straight through (`??` only catches null/undefined), leaving
    // baseUrl empty and every upload failing instead of falling back to api.nijam.dev.
    this.baseUrl = (apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, '');
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  /** Run a request under a 30s abort timeout. Returns the Response or null on failure. */
  private async send(
    method: string,
    path: string,
    init: RequestInit,
  ): Promise<Response | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        method,
        signal: controller.signal,
      });
      if (!res.ok) {
        if (res.status === 402) {
          // Plan limit reached (Free tier). Stop reporting for now — never break CI.
          log.warn(`${method} ${path} → 402: plan limit reached; upgrade at nijam.dev to keep reporting`);
        } else {
          log.warn(`${method} ${path} → ${res.status}`);
        }
        return null;
      }
      return res;
    } catch (err) {
      // Native fetch throws a terse "fetch failed" and hides the real reason
      // (ECONNREFUSED / ENOTFOUND / TLS) in `err.cause`. Surface both, plus the full
      // URL, so connection problems are debuggable instead of opaque.
      log.warn(`${method} ${this.baseUrl}${path} failed: ${describeFetchError(err)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open a run. Returns the run id + dashboard URL, or null if the call failed. */
  async createRun(payload: CreateRunPayload): Promise<{ id: string; url?: string } | null> {
    const res = await this.send('POST', '/v1/runs', {
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!res) return null;
    try {
      const data = (await res.json()) as { id?: string; url?: string; run?: { id?: string } };
      const id = data.id ?? data.run?.id;
      if (!id) {
        log.warn('POST /v1/runs returned no run id');
        return null;
      }
      return { id, url: data.url };
    } catch {
      log.warn('POST /v1/runs returned an unparseable body');
      return null;
    }
  }

  /** Flush a batch of executions. Failed flushes drop the batch (no retry). */
  async sendExecutions(
    runId: string,
    executions: TestExecutionPayload[],
    shardIndex?: number,
  ): Promise<void> {
    await this.send('POST', `/v1/runs/${runId}/executions`, {
      headers: this.headers(),
      body: JSON.stringify({ executions, shardIndex }),
    });
  }

  /** Upload a spec file's source for a run (opt-in). Soft-fails like the rest. */
  async uploadSource(runId: string, file: string, content: string): Promise<void> {
    await this.send('POST', `/v1/runs/${runId}/source`, {
      headers: this.headers(),
      body: JSON.stringify({ file, content }),
    });
  }

  /** Finalize a run with its summary + status. */
  async finalizeRun(runId: string, payload: FinalizeRunPayload): Promise<void> {
    await this.send('PATCH', `/v1/runs/${runId}`, {
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
  }

  /** Stream a test artifact (trace/screenshot/video) to the API without buffering it. */
  async uploadArtifact(
    runId: string,
    executionId: string,
    kind: ArtifactKind,
    filePath: string,
    contentType: string,
  ): Promise<void> {
    const nodeStream = createReadStream(filePath);
    // Web ReadableStream so fetch can stream the body.
    const body = Readable.toWeb(nodeStream) as unknown as ReadableStream;
    await this.send('POST', `/v1/runs/${runId}/executions/${executionId}/artifacts/${kind}`, {
      headers: this.headers({ 'Content-Type': contentType }),
      body,
      // Required by undici when sending a stream body.
      duplex: 'half',
    } as RequestInit);
  }
}
