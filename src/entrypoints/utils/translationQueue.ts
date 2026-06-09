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
  private interChunkDelay: number;
  private lastFinishAt = 0;

  constructor(concurrency = 4, maxRetries = 2, retryDelay = 1000, interChunkDelay = 200) {
    this.concurrency = concurrency;
    this.maxRetries = maxRetries;
    this.retryDelay = retryDelay;
    this.interChunkDelay = interChunkDelay;
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

      // Inter-chunk 间隔：给 DeepSeek KV cache 一点时间把上一次请求
      // 的 prefix 完整落盘（文档："缓存构建耗时为秒级"）。200ms 是
      // 经验值——再大对总延迟影响明显，再小看不出 cache 改善。
      // 只在有"前序请求"时 sleep，避免第一次冷启动白白等。
      if (this.lastFinishAt > 0) {
        const elapsed = Date.now() - this.lastFinishAt;
        const wait = Math.max(0, this.interChunkDelay - elapsed);
        if (wait > 0) await this.delay(wait);
      }

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
        this.lastFinishAt = Date.now();
        this.process();
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  get pendingCount(): number {
    return this.queue.length;
  }

  get runningCount(): number {
    return this.running;
  }
}

// Concurrency = 1 (serial)：DeepSeek 的 prompt cache (KV cache) 在
// 第二个起飞的请求上才能命中——并行 4 个请求同 prefix 同时打过去会全
// miss，串行则让每个请求都吃前一个的 cache，省钱 + 快。
// 测试与移动端也保持 1。
export const globalQueue = new TranslationQueue(1, 2, 1000);
