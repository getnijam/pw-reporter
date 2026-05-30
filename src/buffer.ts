import { log } from './log.js';
import type { TestExecutionPayload } from './types.js';

const FLUSH_SIZE = 50;
const FLUSH_INTERVAL_MS = 2_000;

/**
 * Batches test executions and flushes them when the buffer hits 50 items,
 * 2s elapse since the last flush, or `flush()` is called explicitly.
 * Failed flushes drop the batch (handled by the flush fn) — CI is short-lived.
 */
export class ExecutionBuffer {
  private items: TestExecutionPayload[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void>[] = [];

  constructor(private readonly flushFn: (batch: TestExecutionPayload[]) => Promise<void>) {}

  add(item: TestExecutionPayload): void {
    this.items.push(item);
    if (this.items.length >= FLUSH_SIZE) {
      this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), FLUSH_INTERVAL_MS);
    }
  }

  /** Send the current batch. Tracked so `drain()` can await the final flush. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.items.length === 0) return;

    const batch = this.items;
    this.items = [];
    const p = this.flushFn(batch).catch((err) => {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn(`dropped a batch of ${batch.length} executions: ${reason}`);
    });
    this.inFlight.push(p);
  }

  /** Flush whatever remains and wait for every in-flight flush to settle. */
  async drain(): Promise<void> {
    this.flush();
    await Promise.allSettled(this.inFlight);
    this.inFlight = [];
  }
}
