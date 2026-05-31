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

export class NijamClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(apiKey: string, apiUrl?: string) {
    this.apiKey = apiKey;
    this.baseUrl = (apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
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
        log.warn(`${method} ${path} → ${res.status}`);
        return null;
      }
      return res;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`${method} ${path} failed: ${reason}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Open a run. Returns the run id, or null if the call failed. */
  async createRun(payload: CreateRunPayload): Promise<string | null> {
    const res = await this.send('POST', '/v1/runs', {
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!res) return null;
    try {
      const data = (await res.json()) as { id?: string; run?: { id?: string } };
      return data.id ?? data.run?.id ?? null;
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
