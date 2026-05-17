import { extractBlocks, type TextBlock } from './blockExtractor';
import { buildChunks, type Chunk } from './chunkBuilder';
import { analysisCache, translationCache } from './cacheManager';

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

export async function getCachedTranslation(cacheKey: string) {
  return translationCache.get<Map<string, string>>(cacheKey);
}

export async function cacheTranslation(cacheKey: string, data: Map<string, string>) {
  await translationCache.set(cacheKey, data, 7 * 24 * 60 * 60 * 1000);
}

export function processTranslationResult(jsonResult: string): Map<string, string> {
  const parsed = JSON.parse(jsonResult);
  const translations = parsed.translations || parsed;
  const result = new Map<string, string>();
  for (const item of translations) {
    result.set(item.id, item.translated_text);
  }
  return result;
}

export function prepareSelectionTask(text: string): string {
  return JSON.stringify([{ id: 'b1', text }]);
}

export function clearAllCache(): void {
  analysisCache.clear();
  translationCache.clear();
}
