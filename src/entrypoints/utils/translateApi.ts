import { DeepSeekTranslationService } from '../service/deepseek';
import type { GlossaryEntry, DocumentAnalysis } from '../service/_service';
import { getConfig } from './config';
import { extractBlocks, buildNodeMap, type TextBlock } from './blockExtractor';
import { buildChunks, buildContextForChunk, type Chunk } from './chunkBuilder';
import { parseTranslationXml } from './xmlParser';

const cache = new Map<string, any>();

function generateCacheKey(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `cache_${Math.abs(hash)}`;
}

export async function analyzeDocument(
  root: Document | Element
): Promise<{
  blocks: TextBlock[];
  analysis: DocumentAnalysis;
  chunks: Chunk[];
}> {
  const config = await getConfig();

  if (!config.deepseekApiKey) {
    throw new Error('DeepSeek API Key not configured');
  }

  const service = new DeepSeekTranslationService(config.deepseekApiKey);

  const blocks = extractBlocks(root);

  if (blocks.length === 0) {
    throw new Error('No translatable content found');
  }

  const fullText = blocks.map((b) => b.text).join('\n\n');
  const cacheKey = generateCacheKey(fullText.substring(0, 8000));

  if (cache.has(cacheKey)) {
    const cached = cache.get(cacheKey);
    const chunks = buildChunks(blocks);
    return { blocks, analysis: cached.analysis, chunks };
  }

  const analysis = await service.analyzeDocument(
    fullText,
    config.sourceLang,
    config.targetLang
  );

  cache.set(cacheKey, { analysis });

  const chunks = buildChunks(blocks);

  return { blocks, analysis, chunks };
}

export async function translateChunks(
  chunks: Chunk[],
  analysis: DocumentAnalysis,
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, string>> {
  const config = await getConfig();

  if (!config.deepseekApiKey) {
    throw new Error('DeepSeek API Key not configured');
  }

  const service = new DeepSeekTranslationService(config.deepseekApiKey);

  const glossaryText = analysis.glossary
    .map((g: GlossaryEntry) => `${g.term} => ${g.translation}`)
    .join('\n');

  const translationMap = new Map<string, string>();

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];

    const context = buildContextForChunk(
      chunk,
      chunks,
      glossaryText,
      analysis.summary
    );

    const xmlResult = await service.translate(
      chunk.xmlContent,
      config.sourceLang,
      config.targetLang,
      analysis.glossary,
      context
    );

    const parsedBlocks = parseTranslationXml(xmlResult);

    for (const block of parsedBlocks) {
      translationMap.set(block.id, block.translatedText);
    }

    onProgress?.(i + 1, chunks.length);
  }

  return translationMap;
}

export async function translateText(
  text: string
): Promise<string> {
  const config = await getConfig();

  if (!config.deepseekApiKey) {
    throw new Error('DeepSeek API Key not configured');
  }

  const service = new DeepSeekTranslationService(config.deepseekApiKey);

  const xmlContent = `<DOC><BLOCK id="b1">${text}</BLOCK></DOC>`;

  const result = await service.translate(
    xmlContent,
    config.sourceLang,
    config.targetLang,
    []
  );

  const parsed = parseTranslationXml(result);
  return parsed[0]?.translatedText || text;
}

export function clearCache(): void {
  cache.clear();
}
