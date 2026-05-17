import type { TextBlock } from './blockExtractor';

export interface Chunk {
  id: string;
  blocks: TextBlock[];
  jsonContent: string;
  estimatedTokens: number;
}

const MAX_INPUT_TOKENS = 500000;
const TARGET_TOKENS = 400000;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildJsonContent(blocks: TextBlock[]): string {
  return JSON.stringify(
    blocks.map((b) => ({ id: b.id, text: b.text }))
  );
}

function isStructuralBoundary(block: TextBlock): boolean {
  return /^h[1-6]$/.test(block.tag);
}

function getSectionLevel(block: TextBlock): number {
  const match = block.tag.match(/^h(\d)$/);
  return match ? parseInt(match[1]) : 0;
}

export function buildChunks(blocks: TextBlock[]): Chunk[] {
  console.log('[ChunkBuilder] buildChunks called with', blocks.length, 'blocks');
  if (blocks.length === 0) return [];

  const chunks: Chunk[] = [];
  let currentBlocks: TextBlock[] = [];
  let currentTokens = 0;
  let chunkIndex = 0;

  function flushChunk() {
    if (currentBlocks.length > 0) {
      chunkIndex++;
      chunks.push({
        id: `chunk${chunkIndex}`,
        blocks: currentBlocks,
        jsonContent: buildJsonContent(currentBlocks),
        estimatedTokens: currentTokens,
      });
      currentBlocks = [];
      currentTokens = 0;
    }
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const blockTokens = estimateTokens(block.text) + 20;

    const isBoundary = isStructuralBoundary(block);
    const wouldExceed = currentTokens + blockTokens > TARGET_TOKENS;
    const mustFlush = currentTokens + blockTokens > MAX_INPUT_TOKENS;

    if (mustFlush) {
      flushChunk();
      currentBlocks.push(block);
      currentTokens = blockTokens;
    } else if (wouldExceed && currentBlocks.length > 0) {
      if (isBoundary) {
        flushChunk();
        currentBlocks.push(block);
        currentTokens = blockTokens;
      } else {
        const nextBoundary = findNextBoundary(blocks, i);
        if (nextBoundary && nextBoundary - i < 5) {
          for (let j = i; j <= nextBoundary; j++) {
            const b = blocks[j];
            currentBlocks.push(b);
            currentTokens += estimateTokens(b.text) + 20;
          }
          i = nextBoundary;
          flushChunk();
        } else {
          flushChunk();
          currentBlocks.push(block);
          currentTokens = blockTokens;
        }
      }
    } else {
      currentBlocks.push(block);
      currentTokens += blockTokens;
    }
  }

  flushChunk();
  console.log('[ChunkBuilder] Built', chunks.length, 'chunks');
  if (chunks.length > 0) {
    console.log('[ChunkBuilder] Chunk sizes:', chunks.map(c => ({ id: c.id, blocks: c.blocks.length, tokens: c.estimatedTokens })));
  }
  return chunks;
}

function findNextBoundary(blocks: TextBlock[], startIndex: number): number | null {
  for (let i = startIndex + 1; i < blocks.length; i++) {
    if (isStructuralBoundary(blocks[i])) return i;
  }
  return null;
}

export function buildContextForChunk(
  chunk: Chunk,
  allChunks: Chunk[],
  glossaryText: string,
  documentSummary: string
): string {
  const currentIndex = allChunks.findIndex((c) => c.id === chunk.id);
  const parts: string[] = [];

  if (documentSummary) {
    parts.push(`Document Summary:\n${documentSummary}`);
  }

  if (currentIndex > 0) {
    const prevChunk = allChunks[currentIndex - 1];
    const prevHeadings = prevChunk.blocks
      .filter((b) => isStructuralBoundary(b))
      .map((b) => b.text)
      .join(' → ');

    if (prevHeadings) {
      parts.push(`Previous Section Headings:\n${prevHeadings}`);
    }
  }

  if (glossaryText) {
    parts.push(`Terminology Glossary:\n${glossaryText}`);
  }

  return parts.join('\n\n');
}
