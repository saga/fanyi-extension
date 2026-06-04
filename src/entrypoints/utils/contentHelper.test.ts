import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TextBlock } from './blockExtractor';
import type { Chunk } from './chunkBuilder';

const mockExtractBlocks = vi.fn();
const mockBuildChunks = vi.fn();

vi.mock('./blockExtractor', () => ({
  extractBlocks: (...args: any[]) => mockExtractBlocks(...args),
}));

vi.mock('./chunkBuilder', () => ({
  buildChunks: (...args: any[]) => mockBuildChunks(...args),
}));

import { prepareDocument } from './contentHelper';

describe('prepareDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const makeBlock = (id: string, text: string): TextBlock => ({
    id,
    tag: 'p',
    text,
    xpath: `/${id}`,
  });

  const makeChunk = (id: string, blocks: TextBlock[]): Chunk => ({
    id,
    blocks,
    estimatedTokens: blocks.reduce((sum, b) => sum + Math.ceil(b.text.length / 4), 0),
    jsonContent: JSON.stringify(blocks.map((b) => ({ id: b.id, text: b.text }))),
  });

  it('calls extractBlocks with the root element', () => {
    const root = document.createElement('div');
    const blocks = [makeBlock('b1', 'Hello')];
    mockExtractBlocks.mockReturnValue(blocks);
    mockBuildChunks.mockReturnValue([makeChunk('chunk1', blocks)]);

    prepareDocument(root);

    expect(mockExtractBlocks).toHaveBeenCalledWith(root);
  });

  it('calls buildChunks with extracted blocks', () => {
    const root = document.createElement('div');
    const blocks = [makeBlock('b1', 'Hello'), makeBlock('b2', 'World')];
    mockExtractBlocks.mockReturnValue(blocks);
    mockBuildChunks.mockReturnValue([makeChunk('chunk1', blocks)]);

    prepareDocument(root);

    expect(mockBuildChunks).toHaveBeenCalledWith(blocks);
  });

  it('returns blocks, chunks, and fullText', () => {
    const root = document.createElement('div');
    const blocks = [
      makeBlock('b1', 'Hello world'),
      makeBlock('b2', 'Goodbye world'),
    ];
    const chunks = [makeChunk('chunk1', blocks)];
    mockExtractBlocks.mockReturnValue(blocks);
    mockBuildChunks.mockReturnValue(chunks);

    const result = prepareDocument(root);

    expect(result.blocks).toEqual(blocks);
    expect(result.chunks).toEqual(chunks);
    expect(result.fullText).toBe('Hello world\n\nGoodbye world');
  });

  it('joins block texts with double newline for fullText', () => {
    const root = document.createElement('div');
    const blocks = [
      makeBlock('b1', 'Line 1'),
      makeBlock('b2', 'Line 2'),
      makeBlock('b3', 'Line 3'),
    ];
    mockExtractBlocks.mockReturnValue(blocks);
    mockBuildChunks.mockReturnValue([makeChunk('chunk1', blocks)]);

    const result = prepareDocument(root);

    expect(result.fullText).toBe('Line 1\n\nLine 2\n\nLine 3');
  });

  it('throws when no blocks are extracted', () => {
    const root = document.createElement('div');
    mockExtractBlocks.mockReturnValue([]);

    expect(() => prepareDocument(root)).toThrow('No translatable content found');
    // buildChunks should not be called when blocks is empty
    expect(mockBuildChunks).not.toHaveBeenCalled();
  });

  it('works with a single block', () => {
    const root = document.createElement('div');
    const blocks = [makeBlock('b1', 'Solo text')];
    mockExtractBlocks.mockReturnValue(blocks);
    mockBuildChunks.mockReturnValue([makeChunk('chunk1', blocks)]);

    const result = prepareDocument(root);

    expect(result.blocks).toHaveLength(1);
    expect(result.chunks).toHaveLength(1);
    expect(result.fullText).toBe('Solo text');
  });
});