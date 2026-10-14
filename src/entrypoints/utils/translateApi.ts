import { translationCache } from './cacheManager';

import { logger } from '../../utils/logger';

/**
 * 翻译条目表的严格 JSON Schema（OpenAI json_schema 形状）。
 * 只用于本机 Agent 重试升级轮：经 --json-schema 约束解码，逼模型吐完整数组。
 * 必须包一层 object：CLI StructuredOutput 工具不支持顶层 array schema，
 * 直接传 array 会 deterministic 报 400 invalid function call parameters（已实测）。
 * 不要求 additionalProperties=false——目标是"数组形状 + 必填 id"，额外字段直接忽略。
 */
export const TRANSLATIONS_OBJECT_SCHEMA = {
  type: 'object',
  properties: {
    translations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          translated_text: { type: 'string' },
        },
        required: ['id', 'translated_text'],
      },
    },
  },
  required: ['translations'],
} as const;
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

/**
 * 缓存只有在包含本批每个输入 ID 的非空译文、且没有额外 ID 时才可复用。
 * LLM 可能返回合法 JSON 但只翻译了部分 block；这类结果不能当成完整缓存。
 */
export function hasCompleteTranslationSet(
  translations: Map<string, string>,
  expectedIds: string[],
): boolean {
  if (!expectedIds.length) return false;
  const expected = new Set(expectedIds);
  if (expected.size !== expectedIds.length || translations.size !== expected.size) return false;
  for (const id of expected) {
    const value = translations.get(id);
    if (typeof value !== 'string' || !value.trim()) return false;
  }
  return true;
}

export function processTranslationResult(jsonResult: string): Map<string, string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonResult);
  } catch {
    throw new Error(
      '模型返回不是合法 JSON（输出 ' + jsonResult.length + ' 字符，尾部：' +
      JSON.stringify(jsonResult.slice(-160)) + '）',
    );
  }
  const translations =
    parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>).translations ?? parsed
      : parsed;
  // 单块 chunk 时模型经常返回裸对象 {"id":"b1","translated_text":"..."} 而不是单元素数组：
  // 形状合法，包一层继续走正常流程（缺的块仍由 missing 重试处理）。
  const list = Array.isArray(translations)
    ? translations
    : translations !== null && typeof translations === 'object' &&
      typeof (translations as Record<string, unknown>).id === 'string'
      ? [translations]
      : null;
  // 其他裸对象（如 {"answer": "..."} 或 {"translations": {...}}）仍然是形状错误，
  // 抛带形状信息的错误，不再是没头没尾的 "translations is not iterable"。
  if (!list) {
    const shape =
      parsed !== null && typeof parsed === 'object'
        ? '顶层 keys：' + Object.keys(parsed).join(',')
        : '顶层类型：' + typeof parsed;
    throw new Error(
      '模型返回的 JSON 不是翻译数组（' + shape +
      '，输出 ' + jsonResult.length + ' 字符，头部：' + jsonResult.slice(0, 200) + '）',
    );
  }
  const result = new Map<string, string>();
  for (const item of list) {
    if (typeof item?.id !== 'string') continue;
    // 模型可能用 `text` / `translated_text` / `translation` 中的任意一个——
    // 都接受。prompt 里说的是 `translated_text`，但实际跑下来模型经常
    // 自由发挥用 `text`，硬编码 `translated_text` 会让 result Map 是空。
    const translated =
      typeof item.translated_text === 'string'
        ? item.translated_text
        : typeof item.text === 'string'
        ? item.text
        : typeof item.translation === 'string'
        ? item.translation
        : null;
    if (translated === null) continue;
    result.set(item.id, translated);
  }
  return result;
}

/**
 * 空转（no-op）判定：长文本在不同语言间不可能完全相同。
 * 模型把原文照抄返回 = 拒绝 / 内容过滤 / 太弱没跟上指令，必须当失败处理，
 * 绝不能当"译文"存住——否则英文冒充中文写入缓存，重试也命中脏数据。
 *
 * 短文本（术语、编号、纯数字）原文返回可能是合法的（如术语表要求保留原文），
 * 所以只看长度 >= minChars 的段落；一批全是短段时无法判定，返回 false。
 */
export const NO_OP_MIN_CHARS = 20;

type OriginalBlocks = ReadonlyMap<string, string> | Array<{ id: string; text?: string }>;

function originalsById(originals: OriginalBlocks): ReadonlyMap<string, string> {
  if (Array.isArray(originals)) {
    return new Map(originals.map((block) => [block.id, block.text ?? ''] as [string, string]));
  }
  return originals;
}

export function isUnchangedTranslation(
  translated: string,
  original: string,
  minChars = NO_OP_MIN_CHARS,
): boolean {
  return original.length >= minChars && translated.trim() === original.trim();
}

/** 返回译文 Map 中属于空转的 id（只看有原文对照且够长的段）。 */
export function findNoOpBlockIds(
  translations: ReadonlyMap<string, string>,
  originals: OriginalBlocks,
  minChars = NO_OP_MIN_CHARS,
): string[] {
  const byId = originalsById(originals);
  const noOp: string[] = [];
  for (const [id, translated] of translations) {
    const original = byId.get(id);
    if (original !== undefined && isUnchangedTranslation(translated, original, minChars)) {
      noOp.push(id);
    }
  }
  return noOp;
}

/**
 * 整批空转：期望 id 里至少有一段长文本，且所有长文本段全部原文返回。
 * 调用方应在 sourceLang !== targetLang 时才使用（同语言翻译原文返回是正确的）。
 */
export function isAllLongBlocksNoOp(
  translations: ReadonlyMap<string, string>,
  originals: OriginalBlocks,
  expectedIds?: readonly string[],
  minChars = NO_OP_MIN_CHARS,
): boolean {
  const byId = originalsById(originals);
  const ids = expectedIds ?? Array.from(translations.keys());
  const longIds = ids.filter((id) => (byId.get(id) ?? '').length >= minChars);
  if (!longIds.length) return false;
  return longIds.every((id) =>
    isUnchangedTranslation(translations.get(id) ?? '', byId.get(id) ?? '', minChars),
  );
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
      // 同样的字段名宽松：text / translated_text / translation 都认
      const translatedText =
        typeof item.translated_text === 'string'
          ? item.translated_text
          : typeof item.text === 'string'
          ? item.text
          : typeof item.translation === 'string'
          ? item.translation
          : null;
      seenIds.add(item.id);
      const original = byId.get(item.id);
      if (original === undefined) {
        extraIds++;
        continue;
      }
      if (translatedText !== null && translatedText === original) {
        unchanged++;
        logger.warn(
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
      logger.error(
        '[TranslateApi] ALL',
        translations.length,
        'translated blocks came back unchanged — prompt may be too weak or content was filtered'
      );
    } else if (totalMissing > 0) {
      logger.warn(
        '[TranslateApi]',
        totalMissing,
        'blocks missing from response (input had',
        total,
        'blocks)'
      );
    } else if (unchanged > 0) {
      logger.warn(
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
