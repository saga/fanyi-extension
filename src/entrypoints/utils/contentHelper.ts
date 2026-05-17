import { extractBlocks, type TextBlock } from './blockExtractor';
import { buildChunks, type Chunk } from './chunkBuilder';

export function prepareDocument(root: Document | Element): {
  blocks: TextBlock[];
  chunks: Chunk[];
  fullText: string;
} {
  console.log('[ContentHelper] prepareDocument called, root:', root.nodeName);
  const blocks = extractBlocks(root);
  console.log('[ContentHelper] extractBlocks returned', blocks.length, 'blocks');

  if (blocks.length === 0) {
    console.error('[ContentHelper] No blocks found!');
    throw new Error('No translatable content found');
  }

  const fullText = blocks.map((b) => b.text).join('\n\n');
  console.log('[ContentHelper] Full text length:', fullText.length);
  const chunks = buildChunks(blocks);

  return { blocks, chunks, fullText };
}

export type { TextBlock, Chunk };
