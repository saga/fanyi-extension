import type { TextBlock } from './blockExtractor';

export interface Chunk {
  id: string;
  blocks: TextBlock[];
  jsonContent: string;
  estimatedTokens: number;
}

const MAX_INPUT_TOKENS = 500000;
const TARGET_TOKENS = 800;

/**
 * 首 chunk 的硬上限块数。h1 + 副标题 + 几段引言对模型来说才是
 * "高价值、必须翻译"的内容；超过这个阈值就把剩余正文推到第二
 * chunk，宁可让首 chunk 小一点也要保住 h1/副标题稳定出译文。
 *
 * 设大点（比如 30）就跟 TARGET_TOKENS 没区别了；设小点（比如 6）
 * 又会让正文散得稀碎。当前 12 是经验值：覆盖 h1 + 副标题 +
 * 4-5 段引言/第一段正文，剩下正文进 chunk 2+。
 */
const FIRST_CHUNK_MAX_BLOCKS = 12;

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
    // 首 chunk 块数超阈值也要切，避免正文段落挤爆首 chunk 把
    // h1/副标题挤出译文。直接切到 chunk 2+ 让正文慢慢翻译。
    const wouldExceedFirstChunkCap =
      chunks.length === 0 && currentBlocks.length >= FIRST_CHUNK_MAX_BLOCKS;

    if (mustFlush) {
      flushChunk();
      currentBlocks.push(block);
      currentTokens = blockTokens;
    } else if (wouldExceedFirstChunkCap) {
      // 首 chunk 块数已达上限（即使 token 还没爆），强制切到
      // chunk 2，把剩余正文留给后续 chunk。
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
    // chunk 级别 summary：id / block 数 / token 估算 / blockId 列表。
    // 排查 chunk 切分问题（chunk 太大/太小、blockIds 是否连续）时这就够。
    // 单块的 tag/text 不打：20 块就要 21 行，污染日志。
    console.log(
      '[ChunkBuilder] Chunk sizes:',
      chunks.map((c) => ({
        id: c.id,
        blocks: c.blocks.length,
        tokens: c.estimatedTokens,
        blockIds: c.blocks.map((b) => b.id).join(','),
      })),
    );
  }
  return chunks;
}

function findNextBoundary(blocks: TextBlock[], startIndex: number): number | null {
  for (let i = startIndex + 1; i < blocks.length; i++) {
    if (isStructuralBoundary(blocks[i])) return i;
  }
  return null;
}
