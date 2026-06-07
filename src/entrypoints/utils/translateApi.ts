import { translationCache } from './cacheManager';

export async function getCachedTranslation(cacheKey: string): Promise<Map<string, string> | null> {
  const raw = await translationCache.get<Record<string, string>>(cacheKey);
  if (!raw) return null;
  
  // Convert plain object back to Map for compatibility
  const map = new Map<string, string>();
  for (const [key, value] of Object.entries(raw)) {
    map.set(key, value);
  }
  return map;
}

export async function cacheTranslation(cacheKey: string, data: Map<string, string>) {
  // Convert Map to plain object for storage compatibility
  const obj: Record<string, string> = {};
  for (const [key, value] of data.entries()) {
    obj[key] = value;
  }
  await translationCache.set(cacheKey, obj, 7 * 24 * 60 * 60 * 1000);
}

export function processTranslationResult(jsonResult: string): Map<string, string> {
  const parsed = JSON.parse(jsonResult);
  const translations = parsed.translations || parsed;
  const result = new Map<string, string>();
  for (const item of translations) {
    if (typeof item?.id !== 'string' || typeof item?.translated_text !== 'string') {
      continue;
    }
    result.set(item.id, item.translated_text);
  }
  return result;
}

/**
 * Compare a raw LLM translation response against the original blocks to flag
 * cases where the model silently returned the source text unchanged — a sign
 * that the model refused, hit a content filter, or ignored instructions.
 *
 * LLM-agnostic: works for any translation service that returns the
 * {"translations":[{"id","translated_text"}]} shape. Returns the same JSON
 * string untouched so callers can pass it through to the parser.
 */
export function logUnchangedBlocks(
  rawJson: string,
  originalBlocks: Array<{ id: string; text: string }>
): string {
  try {
    const parsed = JSON.parse(rawJson);
    const translations = parsed.translations || parsed;
    if (!Array.isArray(translations)) return rawJson;

    const byId = new Map(originalBlocks.map((b) => [b.id, b.text]));
    const seenIds = new Set<string>();
    let unchanged = 0;
    let extraIds = 0;
    for (const item of translations) {
      seenIds.add(item.id);
      const original = byId.get(item.id);
      if (original === undefined) {
        extraIds++;
        continue;
      }
      if (typeof item.translated_text === 'string' && item.translated_text === original) {
        unchanged++;
        console.warn(
          '[TranslateApi] Block',
          item.id,
          'came back unchanged (LLM refused / no-op). Original:',
          original.substring(0, 80)
        );
      }
    }
    // Count input blocks that the model never produced output for.
    const inputMissing = originalBlocks.length - seenIds.size;
    const totalMissing = extraIds + inputMissing;
    const total = originalBlocks.length;
    if (total > 0 && unchanged === translations.length) {
      console.error(
        '[TranslateApi] ALL',
        translations.length,
        'translated blocks came back unchanged — prompt may be too weak or content was filtered'
      );
    } else if (totalMissing > 0) {
      console.warn(
        '[TranslateApi]',
        totalMissing,
        'blocks missing from response (input had',
        total,
        'blocks)'
      );
    } else if (unchanged > 0) {
      console.warn(
        '[TranslateApi]',
        unchanged,
        '/',
        translations.length,
        'blocks returned unchanged'
      );
    }
  } catch {
    // If the raw string isn't valid JSON the downstream parser will throw
    // with a more useful error.
  }
  return rawJson;
}

export async function clearAllCache(): Promise<void> {
  await translationCache.clear();
}
