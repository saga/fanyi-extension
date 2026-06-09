type Task<T> = () => Promise<T>;

interface QueueItem<T> {
  task: Task<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  retries: number;
}

export class TranslationQueue {
  private queue: QueueItem<any>[] = [];
  private running = 0;
  private concurrency: number;
  private maxRetries: number;
  private retryDelay: number;

  constructor(concurrency = 4, maxRetries = 2, retryDelay = 1000) {
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
  }

  async add<T>(task: Task<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve, reject, retries: 0 });
      this.process();
    });
  }

  private async process() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;

      this.running++;

      try {
        const result = await item.task();
        item.resolve(result);
      } catch (error) {
        if (item.retries < this.maxRetries) {
          item.retries++;
          await this.delay(this.retryDelay * item.retries);
          this.queue.unshift(item);
        } else {
          item.reject(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        this.running--;
        this.process();
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  setConcurrency(n: number): void {
    this.concurrency = n;
    this.process();
  }

  /**
   * Add multiple tasks with warmup-then-parallel strategy:
   * first `warmupCount` tasks run serially (concurrency=1), then the
   * remaining tasks run at up to `maxConcurrency`.
   */
  async addAllWithWarmup<T>(
    tasks: (() => Promise<T>)[],
    warmupCount: number,
    maxConcurrency: number,
  ): Promise<T[]> {
    const promises = tasks.map(t => this.add(t));

    for (let i = 0; i < Math.min(warmupCount, promises.length); i++) {
      await promises[i];
    }

    if (promises.length > warmupCount) {
      this.setConcurrency(maxConcurrency);
    }

    return Promise.all(promises);
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running;
  }
}

// Content 层已经保证前两个 chunk 串行预热 KV cache，第三个起采用并行
// 模式（桌面 4 / 移动 2）。globalQueue 允许最高 4 并发，不拖后腿。
// 如果有多个标签页同时翻译，globalQueue 也会自然限流到 4。
export const globalQueue = new TranslationQueue(4, 2, 1000);
