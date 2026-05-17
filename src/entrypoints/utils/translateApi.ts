import { extractBlocks, type TextBlock } from './blockExtractor';
import { buildChunks, buildContextForChunk, type Chunk } from './chunkBuilder';
import { parseTranslationXml } from './xmlParser';
import { analysisCache, translationCache } from './cacheManager';

function generateCacheKey(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `analysis_${Math.abs(hash)}`;
}

function generateTranslationCacheKey(
  xmlContent: string,
  sourceLang: string,
  targetLang: string
): string {
  let hash = 0;
  const combined = `${xmlContent}_${sourceLang}_${targetLang}`;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `translation_${Math.abs(hash)}`;
}

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

export async function getAnalyzeTask(
  fullText: string,
  sourceLang: string,
  targetLang: string
): Promise<{ cacheKey: string; needsAnalysis: boolean }> {
  const cacheKey = generateCacheKey(fullText.substring(0, 8000));
  const cached = await analysisCache.get(cacheKey);

  return {
    cacheKey,
    needsAnalysis: !cached,
  };
}

export async function getTranslationTasks(
  chunks: Chunk[],
  sourceLang: string,
  targetLang: string
): Promise<Array<{
  cacheKey: string;
  needsTranslation: boolean;
  chunk: Chunk;
}>> {
  return Promise.all(
    chunks.map(async (chunk) => {
      const cacheKey = generateTranslationCacheKey(
        chunk.xmlContent,
        sourceLang,
        targetLang
      );
      const cached = await translationCache.get<Map<string, string>>(cacheKey);

      return {
        cacheKey,
        needsTranslation: !cached,
        chunk,
      };
    })
  );
}

export async function getCachedAnalysis(cacheKey: string) {
  return analysisCache.get(cacheKey);
}

export async function getCachedTranslation(cacheKey: string) {
  return translationCache.get<Map<string, string>>(cacheKey);
}

export async function cacheAnalysis(cacheKey: string, data: any) {
  await analysisCache.set(cacheKey, data, 24 * 60 * 60 * 1000);
}

export async function cacheTranslation(cacheKey: string, data: Map<string, string>) {
  await translationCache.set(cacheKey, data, 7 * 24 * 60 * 60 * 1000);
}

export function buildTranslationContext(
  chunk: Chunk,
  allChunks: Chunk[],
  glossaryText: string,
  summary: string
): string {
  return buildContextForChunk(chunk, allChunks, glossaryText, summary);
}

export function processTranslationResult(xmlResult: string): Map<string, string> {
  const parsedBlocks = parseTranslationXml(xmlResult);
  const result = new Map<string, string>();
  for (const block of parsedBlocks) {
    result.set(block.id, block.translatedText);
  }
  return result;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function prepareSelectionTask(text: string): string {
  return `<DOC><BLOCK id="b1">${escapeXml(text)}</BLOCK></DOC>`;
}

export function clearAllCache(): void {
  analysisCache.clear();
  translationCache.clear();
}
