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

  it('buildChunks with many blocks produces warmup chunks then normal chunks', () => {
    // 200 token blocks → 2 blocks per warmup chunk (WARMUP=400)
    const text = 'x'.repeat(720);
    const blocks = Array.from({ length: 8 }, (_, i) =>
      makeBlock(`b${i + 1}`, text)
    );

    const chunks = buildChunks(blocks);

    // First two chunks: 2 blocks each (warmup limit)
    expect(chunks[0].blocks.length).toBeLessThanOrEqual(2);
    expect(chunks[1].blocks.length).toBeLessThanOrEqual(2);
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

  it('only first two chunks are warmup sized with small blocks', () => {
    // Blocks that are ~50 tokens each
    const text = 'x'.repeat(120); // ceil(120/4)+20 = 30+20=50 tokens
    const blocks = Array.from({ length: 28 }, (_, i) =>
      makeBlock(`b${i + 1}`, text)
    );

    const chunks = buildChunks(blocks);

    // WARMUP=400 → 8 blocks of 50 = 400 tokens
    // Chunk 1 and 2 warmup: each ≤400 tokens (≤ 8 blocks)
    expect(chunks[0].blocks.length).toBeLessThanOrEqual(8);
    expect(chunks[1].blocks.length).toBeLessThanOrEqual(8);
    // Chunk 3+ normal: can hold more (TARGET=800 → up to 16 blocks)
    for (let i = 2; i < chunks.length; i++) {
      expect(chunks[i].estimatedTokens).toBeLessThanOrEqual(820);
    }
    // At least one normal chunk is larger than any warmup chunk could be
    const warmupMaxTokens = Math.max(chunks[0].estimatedTokens, chunks[1].estimatedTokens);
    const normalChunks = chunks.slice(2);
    const normalMaxTokens = Math.max(...normalChunks.map(c => c.estimatedTokens));
    expect(normalMaxTokens).toBeGreaterThanOrEqual(warmupMaxTokens);
  });
});
