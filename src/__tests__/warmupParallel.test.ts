import { describe, it, expect } from 'vitest';
import { buildChunks } from '../entrypoints/utils/chunkBuilder';
import { TranslationQueue } from '../entrypoints/utils/translationQueue';
import type { TextBlock } from '../entrypoints/utils/blockExtractor';

function makeBlock(id: string, text: string): TextBlock {
  return { id, tag: 'p', text, xpath: `/${id}` };
}

describe('warmup-then-parallel integration', () => {
  it('buildChunks produces first two warmup chunks smaller than later chunks', () => {
    // Each block: 200 tokens. WARMUP=400 → 2 blocks per warmup chunk.
    // TARGET=800 → 4 blocks per normal chunk.
    const text = 'x'.repeat(720); // ceil(720/4)+20 = 180+20 = 200 tokens
    const blocks: TextBlock[] = Array.from({ length: 8 }, (_, i) =>
      makeBlock(`b${i + 1}`, text)
    );

    const chunks = buildChunks(blocks);

    // chunk1 and chunk2 are warmup-sized: 2 blocks each (400 tokens)
    expect(chunks[0].estimatedTokens).toBeLessThanOrEqual(420);
    expect(chunks[1].estimatedTokens).toBeLessThanOrEqual(420);
    // Later chunks can be larger (up to TARGET=800)
    const normalChunks = chunks.slice(2);
    expect(normalChunks.some(c => c.estimatedTokens > 420)).toBe(true);
  });


  it('queue with warmup-then-parallel processes chunks in expected order', async () => {
    const q = new TranslationQueue(1, 0, 0);
    const order: number[] = [];

    // Create 5 fake "chunk processing" tasks
    const tasks = Array.from({ length: 5 }, (_, i) =>
      q.add(async () => {
        await new Promise(r => setTimeout(r, 10));
        order.push(i);
        return i;
      })
    );

    // Warmup: await first two serially
    await tasks[0];
    await tasks[1];

    // Bump concurrency for remaining
    q.setConcurrency(3);
    await Promise.all(tasks);

    // First two must come first (serial warmup)
    expect(order[0]).toBe(0);
    expect(order[1]).toBe(1);
    // All tasks completed
    expect(order).toEqual(expect.arrayContaining([0, 1, 2, 3, 4]));
  });

  it('single chunk skips concurrency bump', async () => {
    const q = new TranslationQueue(1, 0, 0);
    const result = await q.add(async () => 'only');
    expect(result).toBe('only');
  });

  it('two chunks both run serially without bump', async () => {
    const q = new TranslationQueue(1, 0, 0);
    const order: number[] = [];

    const tasks = Array.from({ length: 2 }, (_, i) =>
      q.add(async () => {
        order.push(i);
        await new Promise(r => setTimeout(r, 10));
        return i;
      })
    );

    await tasks[0];
    await tasks[1];

    expect(order).toEqual([0, 1]);
  });

});
