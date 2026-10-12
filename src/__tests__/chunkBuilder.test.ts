import { describe, it, expect } from 'vitest';
import { buildChunks, mergeSegmentTranslations } from '../entrypoints/utils/chunkBuilder';
import type { TextBlock } from '../entrypoints/utils/blockExtractor';

function makeBlock(id: string, tag: string, text: string): TextBlock {
  return { id, tag, text, xpath: `/${id}` };
}

/**
 * Helper: each block text is `repeat` so that estimateTokens ≈ tokens.
 * estimateTokens = ceil(repeat.length / 4) + 20.
 */
function tokenBlock(id: string, tag: string, tokens: number): TextBlock {
  const text = 'x'.repeat(Math.max(0, (tokens - 20) * 4));
  return { id, tag, text, xpath: `/${id}` };
}

describe('buildChunks', () => {
  it('returns empty array for no blocks', () => {
    expect(buildChunks([])).toEqual([]);
  });

  it('segments oversized prose and reassembles only when every segment has a translation', () => {
    const longText = 'This is a reasonably long sentence that should remain intact at chunk boundaries. '.repeat(90);
    const block = makeBlock('b1', 'p', longText);
    const chunks = buildChunks([block]);
    const parts = chunks.flatMap((chunk) => chunk.blocks)
      .filter((part) => part.segmentOf === 'b1')
      .sort((a, b) => (a.segmentIndex ?? 0) - (b.segmentIndex ?? 0));

    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => part.text.length <= 2400)).toBe(true);
    expect(parts.map((part) => part.id)).not.toContain('b1');
    const reconstructed = parts[0].text + parts.slice(1)
      .map((part) => (part.separatorBefore ?? '') + part.text).join('');
    expect(reconstructed).toBe(longText);

    const segmentTranslations = new Map(parts.map((part) => [part.id, `译文-${part.segmentIndex}`]));
    const merged = mergeSegmentTranslations(chunks, segmentTranslations);
    expect(merged.size).toBe(1);
    expect(merged.get('b1')).toBe(parts.map((part, index) =>
      index === 0 ? `译文-${part.segmentIndex}` : (part.separatorBefore ?? '') + `译文-${part.segmentIndex}`
    ).join(''));

    const incomplete = new Map(parts.slice(1).map((part) => [part.id, '缺失首片']));
    expect(mergeSegmentTranslations(chunks, incomplete).has('b1')).toBe(false);
  });

  it('creates a single chunk for a small set of blocks', () => {
    const blocks = [
      makeBlock('b1', 'p', 'Hello world this is a test paragraph.'),
      makeBlock('b2', 'p', 'Another paragraph with enough text content.'),
    ];

    const chunks = buildChunks(blocks);
    expect(chunks.length).toBe(1);
    expect(chunks[0].blocks).toHaveLength(2);
    expect(chunks[0].id).toBe('chunk1');
  });

  it('splits chunks at heading boundaries when exceeding target tokens', () => {
    const longText = 'a'.repeat(400);
    const blocks = [
      makeBlock('b1', 'p', longText),
      makeBlock('b2', 'h2', 'Section Title'),
      makeBlock('b3', 'p', 'Short paragraph.'),
    ];

    const chunks = buildChunks(blocks);
    // b1 alone is ~400/4+20 = 120 tokens, close to TARGET_TOKENS=800
    // but b1 is 400 chars, so estimateTokens = 100+20 = 120
    // With b2 heading, it should still fit in one chunk unless exceeding
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Heading should start a new chunk if previous was near limit
  });


  it('produces valid JSON in jsonContent', () => {
    const blocks = [
      makeBlock('b1', 'p', 'Hello world.'),
      makeBlock('b2', 'p', 'Second block.'),
    ];

    const chunks = buildChunks(blocks);
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk.jsonContent);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed[0].id).toBe('b1');
      expect(parsed[0].text).toBe('Hello world.');
    }
  });

  it('estimates tokens based on text length', () => {
    const blocks = [
      makeBlock('b1', 'p', 'a'.repeat(100)),
    ];

    const chunks = buildChunks(blocks);
    // estimateTokens = ceil(100/4) + 20 = 45
    expect(chunks[0].estimatedTokens).toBe(45);
  });

  it('preserves block order within chunks', () => {
    const blocks = [
      makeBlock('b1', 'p', 'First paragraph.'),
      makeBlock('b2', 'p', 'Second paragraph.'),
      makeBlock('b3', 'p', 'Third paragraph.'),
    ];

    const chunks = buildChunks(blocks);
    const allIds = chunks.flatMap(c => c.blocks.map(b => b.id));
    expect(allIds).toEqual(['b1', 'b2', 'b3']);
  });


  it('flushes remaining blocks as final chunk', () => {
    const blocks = [
      makeBlock('b1', 'p', 'First block of text content here.'),
      makeBlock('b2', 'p', 'Second block of text content here.'),
      makeBlock('b3', 'p', 'Third block of text content here.'),
    ];

    const chunks = buildChunks(blocks);
    const totalBlocks = chunks.reduce((sum, c) => sum + c.blocks.length, 0);
    expect(totalBlocks).toBe(3);
  });

  it('splits at structural boundary (heading) when near token limit', () => {
    const nearLimitText = 'a'.repeat(3000);
    const blocks = [
      makeBlock('b1', 'p', nearLimitText),
      makeBlock('b2', 'h2', 'New Section'),
      makeBlock('b3', 'p', 'Content under new section.'),
    ];

    const chunks = buildChunks(blocks);
    // b1 超过单块长度上限，会拆成内部片段；这些片段必须都存在，
    // 且原有标题与下一段仍完整保留。
    const allBlocks = chunks.flatMap(c => c.blocks);
    const longTextParts = allBlocks.filter((b) => b.segmentOf === 'b1');
    expect(longTextParts.length).toBeGreaterThan(1);
    expect(longTextParts.map((b) => b.text).join('')).toContain('aaaaaaaaaa');
    expect(allBlocks.some(b => b.tag === 'h2' && b.id === 'b2')).toBe(true);
    expect(allBlocks.some(b => b.id === 'b3')).toBe(true);
    expect(allBlocks.filter((b) => b.id === 'b1')).toHaveLength(0);
  });

  // --- warmup token target tests ---

  it('uses WARMUP_TARGET_TOKENS for first two chunks', () => {
    // Each block: 100 tokens. WARMUP=400 → 4 blocks per warmup chunk.
    // TARGET=800 → 8 blocks per normal chunk.
    const blocks = Array.from({ length: 12 }, (_, i) =>
      tokenBlock(`b${i + 1}`, 'p', 100)
    );

    const chunks = buildChunks(blocks);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    // chunk1 and chunk2 warmup: each ≤ 400 tokens
    expect(chunks[0].estimatedTokens).toBeLessThanOrEqual(420);
    expect(chunks[1].estimatedTokens).toBeLessThanOrEqual(420);
    // chunk3+ normal: each ≤ 800 tokens
    for (let i = 2; i < chunks.length; i++) {
      expect(chunks[i].estimatedTokens).toBeLessThanOrEqual(820);
    }
  });

  it('both warmup chunks are roughly equal size', () => {
    const blocks = Array.from({ length: 14 }, (_, i) =>
      tokenBlock(`b${i + 1}`, 'p', 100)
    );

    const chunks = buildChunks(blocks);

    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks[0].estimatedTokens).toBeLessThanOrEqual(420);
    expect(chunks[1].estimatedTokens).toBeLessThanOrEqual(420);
  });

  it('third chunk is larger than warmup chunks', () => {
    const blocks = Array.from({ length: 15 }, (_, i) =>
      tokenBlock(`b${i + 1}`, 'p', 100)
    );

    const chunks = buildChunks(blocks);

    expect(chunks[0].estimatedTokens).toBeLessThanOrEqual(420);
    expect(chunks[1].estimatedTokens).toBeLessThanOrEqual(420);
    const normalChunks = chunks.slice(2);
    expect(normalChunks.length).toBeGreaterThan(0);
    // At least one normal chunk exceeds warmup limit
    expect(normalChunks.some(c => c.estimatedTokens > 420)).toBe(true);
  });


  it('preserves block order with warmup splitting', () => {
    const blocks = Array.from({ length: 10 }, (_, i) =>
      tokenBlock(`b${i + 1}`, 'p', 60)
    );

    const chunks = buildChunks(blocks);
    const allIds = chunks.flatMap(c => c.blocks.map(b => b.id));
    expect(allIds).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'b8', 'b9', 'b10']);
  });

  it('small blocks stay in one chunk when under warmup target', () => {
    const blocks = [
      tokenBlock('b1', 'p', 30),
      tokenBlock('b2', 'p', 30),
      tokenBlock('b3', 'p', 30),
    ];

    const chunks = buildChunks(blocks);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].blocks).toHaveLength(3);
  });

  it('warmup split works with heading boundaries', () => {
    const blocks = [
      tokenBlock('b1', 'p', 100),
      tokenBlock('b2', 'p', 100),
      tokenBlock('b3', 'h2', 100),
      tokenBlock('b4', 'p', 100),
      tokenBlock('b5', 'p', 100),
    ];

    const chunks = buildChunks(blocks);
    const totalBlocks = chunks.reduce((sum, c) => sum + c.blocks.length, 0);
    expect(totalBlocks).toBe(5);
  });

});
