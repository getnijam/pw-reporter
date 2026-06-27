import type { TestResult } from '@playwright/test/reporter';
import { log } from './log.js';
import type { NijamClient } from './client.js';
import type { ArtifactKind } from './types.js';

const MAX_CONCURRENT_UPLOADS = 4;

// Playwright attaches these by name; we upload any with an on-disk path.
const KIND_BY_NAME: Record<string, ArtifactKind> = {
  trace: 'trace',
  screenshot: 'screenshot',
  video: 'video',
};

const DEFAULT_CONTENT_TYPE: Record<ArtifactKind, string> = {
  trace: 'application/zip',
  screenshot: 'image/png',
  video: 'video/webm',
};

/**
 * Collects each test's trace / screenshot(s) / video attachments during the run,
 * then uploads them in `drain()`, which the reporter calls in onEnd *after* the
 * execution buffer is flushed, so the artifact's execution row already exists
 * (the upload endpoint 404s otherwise). Uploads run concurrency-capped at 4.
 */
export class ArtifactUploader {
  private readonly tasks: Array<() => Promise<void>> = [];

  constructor(private readonly client: NijamClient) {}

  /** Queue uploads for every trace/screenshot/video attachment that has a path. */
  maybeUpload(runId: string, executionId: string, result: TestResult): void {
    for (const attachment of result.attachments) {
      const kind = KIND_BY_NAME[attachment.name];
      if (!kind || !attachment.path) continue;
      const path = attachment.path;
      const contentType = attachment.contentType || DEFAULT_CONTENT_TYPE[kind];
      this.tasks.push(() => this.client.uploadArtifact(runId, executionId, kind, path, contentType));
    }
  }

  /** Run all queued uploads (≤4 in flight) and wait. Call AFTER executions persist. */
  async drain(): Promise<void> {
    const queue = this.tasks.splice(0);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        const task = queue[next++]!;
        try {
          await task();
        } catch (err) {
          log.warn(`artifact upload failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    };
    const workers = Math.min(MAX_CONCURRENT_UPLOADS, queue.length);
    await Promise.all(Array.from({ length: workers }, () => worker()));
  }
}
