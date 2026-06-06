import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TranslationQueue } from '../entrypoints/utils/translationQueue';

describe('TranslationQueue', () => {
  let queue: TranslationQueue;

  beforeEach(() => {
    queue = new TranslationQueue(2, 1, 50);
  });

  it('executes a single task', async () => {
    const result = await queue.add(() => Promise.resolve('done'));
    expect(result).toBe('done');
  });

  it('executes multiple tasks sequentially up to concurrency', async () => {
    const order: number[] = [];
    const tasks = [1, 2, 3, 4].map(i =>
      queue.add(async () => {
        order.push(i);
        await new Promise(r => setTimeout(r, 30));
        return i;
      })
    );

    const results = await Promise.all(tasks);
    expect(results).toEqual([1, 2, 3, 4]);
    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('respects concurrency limit', async () => {
    let running = 0;
    let maxRunning = 0;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      queue.add(async () => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        await new Promise(r => setTimeout(r, 50));
        running--;
        return i;
      })
    );

    await Promise.all(tasks);
    expect(maxRunning).toBeLessThanOrEqual(2);
  });

  it('retries failed tasks', async () => {
    let attempts = 0;

    const result = await queue.add(async () => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
      return 'success';
    });

    expect(result).toBe('success');
    expect(attempts).toBe(2);
  });

  it('rejects after max retries exceeded', async () => {
    let attempts = 0;

    await expect(
      queue.add(async () => {
        attempts++;
        throw new Error('permanent failure');
      })
    ).rejects.toThrow('permanent failure');

    // maxRetries=1, so 1 initial + 1 retry = 2 attempts
    expect(attempts).toBe(2);
  });

  it('reports pending and running counts', async () => {
    expect(queue.pendingCount).toBe(0);
    expect(queue.runningCount).toBe(0);

    const task = queue.add(() => new Promise(r => setTimeout(r, 100)));

    // Give a tick for the queue to start processing
    await new Promise(r => setTimeout(r, 10));

    expect(queue.runningCount).toBeLessThanOrEqual(1);

    await task;
    expect(queue.runningCount).toBe(0);
  });

  it('handles tasks that resolve immediately', async () => {
    const results = await Promise.all([
      queue.add(() => Promise.resolve('a')),
      queue.add(() => Promise.resolve('b')),
      queue.add(() => Promise.resolve('c')),
    ]);

    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('preserves result type', async () => {
    const num = await queue.add(() => Promise.resolve(42));
    const str = await queue.add(() => Promise.resolve('hello'));
    const obj = await queue.add(() => Promise.resolve({ key: 'value' }));

    expect(num).toBe(42);
    expect(str).toBe('hello');
    expect(obj).toEqual({ key: 'value' });
  });

  // --- error types ---

  it('wraps non-Error throws in Error object', async () => {
    const promise = queue.add(() => {
      throw 'string error';
    });
    await expect(promise).rejects.toThrow('string error');
  });

  it('preserves original Error instance', async () => {
    const promise = queue.add(() => {
      throw new TypeError('type error');
    });
    await expect(promise).rejects.toThrow(TypeError);
    await expect(promise).rejects.toThrow('type error');
  });

  it('handles rejection of non-Error value', async () => {
    const promise = queue.add(() => Promise.reject(42));
    await expect(promise).rejects.toThrow('42');
  });

  it('handles null rejection', async () => {
    const promise = queue.add(() => Promise.reject(null));
    await expect(promise).rejects.toThrow('null');
  });

  // --- retry with delay ---

  it('delays between retries', async () => {
    let attempts = 0;
    const start = Date.now();

    const result = await queue.add(async () => {
      attempts++;
      if (attempts < 2) throw new Error('fail');
      return 'success';
    });

    const elapsed = Date.now() - start;
    expect(result).toBe('success');
    // With retry delay of 50ms * retry# (1), should be at least 50ms
    expect(elapsed).toBeGreaterThanOrEqual(40);
  });

  // --- empty queue ---

  it('handles empty queue gracefully', () => {
    const q = new TranslationQueue(1, 1, 10);
    expect(q.pendingCount).toBe(0);
    expect(q.runningCount).toBe(0);
  });

  // --- default params ---

  it('uses default constructor params', async () => {
    const q = new TranslationQueue();
    const result = await q.add(() => Promise.resolve('default'));
    expect(result).toBe('default');
  });

  // --- sequential execution with concurrency=1 ---

  it('executes sequentially when concurrency is 1', async () => {
    const singleQueue = new TranslationQueue(1, 0, 10);
    const order: number[] = [];

    const tasks = [1, 2, 3].map(i =>
      singleQueue.add(async () => {
        order.push(i);
        await new Promise(r => setTimeout(r, 20));
        return i;
      })
    );

    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });
});
