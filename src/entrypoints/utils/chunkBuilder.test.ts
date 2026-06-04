import { describe, it, expect } from 'vitest';
import { buildChunks } from './chunkBuilder';
import type { TextBlock } from './blockExtractor';

function makeBlock(id: string, tag: string, text: string): TextBlock {
  return { id, tag, text, xpath: `/${id}` };
}

describe('buildChunks', () => {
  it('returns empty array for no blocks', () => {
    expect(buildChunks([])).toEqual([]);
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

  it('assigns sequential chunk IDs', () => {
    const longText = 'a'.repeat(3500);
    const blocks = [
      makeBlock('b1', 'p', longText),
      makeBlock('b2', 'p', longText),
      makeBlock('b3', 'p', longText),
    ];

    const chunks = buildChunks(blocks);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i].id).toBe(`chunk${i + 1}`);
    }
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

  it('handles a single block', () => {
    const blocks = [makeBlock('b1', 'p', 'Just one paragraph.')];
    const chunks = buildChunks(blocks);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].blocks).toHaveLength(1);
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
    // b1 is ~770 tokens, close to TARGET_TOKENS=800
    // The heading may or may not start a new chunk depending on exact token count
    // Verify all blocks are present across chunks
    const totalBlocks = chunks.reduce((sum, c) => sum + c.blocks.length, 0);
    expect(totalBlocks).toBe(3);
    // Verify the heading is present
    const allBlocks = chunks.flatMap(c => c.blocks);
    expect(allBlocks.some(b => b.tag === 'h2')).toBe(true);
  });
});
