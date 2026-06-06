import { extractBlocks, type TextBlock } from './blockExtractor';
import { buildChunks, type Chunk } from './chunkBuilder';

const ARTICLE_SELECTORS = [
  'article',
  '[role="main"]',
  '[role="article"]',
  'main',
  '.article-content',
  '.article-body',
  '.article-text',
  '.story-content',
  '.story-body',
  '.main-content',
  '.content-body',
  '.post-content',
  '.entry-content',
  '.page-content',
];

function findArticleRoot(doc: Document): Element {
  for (const selector of ARTICLE_SELECTORS) {
    const el = doc.querySelector(selector);
    if (el) {
      console.log('[ContentHelper] Found article root:', selector);
      return el;
    }
  }
  console.log('[ContentHelper] No article root found, falling back to body');
  return doc.body || doc.documentElement;
}

export function prepareDocument(root: Document | Element): {
  blocks: TextBlock[];
  chunks: Chunk[];
  fullText: string;
} {
  console.log('[ContentHelper] prepareDocument called, root:', root.nodeName);

  // 优先使用文章容器，减少 TreeWalker 遍历范围
  const effectiveRoot = root instanceof Document ? findArticleRoot(root) : root;
  const blocks = extractBlocks(effectiveRoot);
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
