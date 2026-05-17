import { extractBlocks, type TextBlock } from './blockExtractor';
import { buildChunks, buildContextForChunk, type Chunk } from './chunkBuilder';

export function prepareDocument(root: Document | Element): {
  blocks: TextBlock[];
  chunks: Chunk[];
  fullText: string;
} {
  const blocks = extractBlocks(root);

  if (blocks.length === 0) {
    throw new Error('No translatable content found');
  }

  const fullText = blocks.map((b) => b.text).join('\n\n');
  const chunks = buildChunks(blocks);

  return { blocks, chunks, fullText };
}

export function buildTranslationContext(
  chunk: Chunk,
  allChunks: Chunk[],
  glossaryText: string,
  summary: string
): string {
  return buildContextForChunk(chunk, allChunks, glossaryText, summary);
}

export type { TextBlock, Chunk };
