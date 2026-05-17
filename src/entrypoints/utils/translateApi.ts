import { DeepSeekTranslationService } from '../service/deepseek';
import type { GlossaryEntry, DocumentAnalysis } from '../service/_service';
import { getConfig } from './config';
import { extractBlocks, type TextBlock } from './blockExtractor';
import { buildChunks, buildContextForChunk, type Chunk } from './chunkBuilder';
import { parseTranslationXml } from './xmlParser';
import { globalQueue } from './translationQueue';
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

  const blocks = extractBlocks(root);

  if (blocks.length === 0) {
    throw new Error('No translatable content found');
  }

  const fullText = blocks.map((b) => b.text).join('\n\n');
  const cacheKey = generateCacheKey(fullText.substring(0, 8000));

  const cachedAnalysis = await analysisCache.get<DocumentAnalysis>(cacheKey);
  if (cachedAnalysis) {
    const chunks = buildChunks(blocks);
    return { blocks, analysis: cachedAnalysis, chunks };
  }

  const service = new DeepSeekTranslationService(config.deepseekApiKey);

  const analysis = await globalQueue.add(() =>
    service.analyzeDocument(fullText, config.sourceLang, config.targetLang)
  );

  await analysisCache.set(cacheKey, analysis, 24 * 60 * 60 * 1000);

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

  const translationTasks = chunks.map(async (chunk, index) => {
    const cacheKey = generateTranslationCacheKey(
      chunk.xmlContent,
      config.sourceLang,
      config.targetLang
    );

    const cachedResult = await translationCache.get<Map<string, string>>(cacheKey);
    if (cachedResult) {
      for (const [id, text] of cachedResult) {
        translationMap.set(id, text);
      }
      onProgress?.(index + 1, chunks.length);
      return;
    }

    const context = buildContextForChunk(
      chunk,
      chunks,
      glossaryText,
      analysis.summary
    );

    const xmlResult = await globalQueue.add(() =>
      service.translate(
        chunk.xmlContent,
        config.sourceLang,
        config.targetLang,
        analysis.glossary,
        context
      )
    );

    const parsedBlocks = parseTranslationXml(xmlResult);
    const chunkMap = new Map<string, string>();

    for (const block of parsedBlocks) {
      translationMap.set(block.id, block.translatedText);
      chunkMap.set(block.id, block.translatedText);
    }

    await translationCache.set(cacheKey, chunkMap, 7 * 24 * 60 * 60 * 1000);

    onProgress?.(index + 1, chunks.length);
  });

  await Promise.all(translationTasks);

  return translationMap;
}

export async function translateText(
  text: string
): Promise<string> {
  const config = await getConfig();

  if (!config.deepseekApiKey) {
    throw new Error('DeepSeek API Key not configured');
  }

  const cacheKey = generateTranslationCacheKey(
    text,
    config.sourceLang,
    config.targetLang
  );

  const cached = await translationCache.get<string>(cacheKey);
  if (cached) return cached;

  const service = new DeepSeekTranslationService(config.deepseekApiKey);

  const xmlContent = `<DOC><BLOCK id="b1">${escapeXml(text)}</BLOCK></DOC>`;

  const result = await globalQueue.add(() =>
    service.translate(
      xmlContent,
      config.sourceLang,
      config.targetLang,
      []
    )
  );

  const parsed = parseTranslationXml(result);
  const translated = parsed[0]?.translatedText || text;

  await translationCache.set(cacheKey, translated, 24 * 60 * 60 * 1000);

  return translated;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function clearCache(): void {
  analysisCache.clear();
  translationCache.clear();
}
