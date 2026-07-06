/**
 * 字幕翻译器：增量翻译 + Ahead Buffer + AbortSignal 支持。
 *
 * 重构要点（解决问题 1 一次翻译整个视频、问题 7 没有取消机制）：
 *   - translateBatch：单批翻译，接受 AbortSignal，可在 fetch 层面取消
 *   - translateAhead：Ahead Buffer 翻译，只翻译 [fromMs, fromMs + aheadMs] 时间窗口内
 *     未翻译的字幕，避免一次性翻译整集视频
 *   - 翻译状态字段 status：pending -> translating -> done/failed
 *     （Manager 据此判断是否需要预取）
 *
 * 字幕专用简化 prompt 保持不变（问题 9 Prompt 增强保留为后续迭代）。
 */
import type { CaptionEvent, ProgressCallback } from './types';

// =============================================================================
// JSON 清理工具（内联，避免依赖 vocal-saga 的 shared.ts）
// =============================================================================

/**
 * 去除推理模型可能泄漏的 think 标签。
 * 处理完整标签、截断的开标签、截断的闭标签三种情况。
 *
 * 用占位符变量拼接正则，避免在源码中出现反引号 + < 字面量导致
 * 编辑工具和 IDE 解析异常。
 */
const THINK_OPEN = String.fromCharCode(60) + 'think' + String.fromCharCode(62);
const THINK_CLOSE = String.fromCharCode(60) + '/think' + String.fromCharCode(62);
const THINK_OPEN_RE = new RegExp(THINK_OPEN.replace(/[<>\/]/g, '\\$&') + '[\\s\\S]*?' + THINK_CLOSE.replace(/[<>\/]/g, '\\$&'), 'gi');
const THINK_OPEN_ONLY_RE = new RegExp(THINK_OPEN.replace(/[<>\/]/g, '\\$&') + '[\\s\\S]*$', 'gi');

function stripThinkingTags(text: string): string {
  let result = text.replace(THINK_OPEN_RE, '');
  result = result.replace(THINK_OPEN_ONLY_RE, '');
  return result.trim();
}

/**
 * 去除模型可能包裹的 ```json ... ``` 代码块标记。
 * 处理完整和截断的代码块。
 */
function stripMarkdownCodeBlock(text: string): string {
  let result = text.trim();
  result = result.replace(/^```(?:json)?\s*\n?/i, '');
  result = result.replace(/\n?```\s*$/i, '');
  return result.trim();
}

/**
 * 修复可能被截断的 JSON（DeepSeek 在 max_tokens 不足时可能输出不完整的 JSON）。
 * 通过括号计数补全缺失的 `"` `]` `}`。
 */
function repairTruncatedJson(text: string): string {
  let result = text.trim();
  let braceDepth = 0;
  let bracketDepth = 0;
  let inString = false;
  let escape = false;
  for (let i = 0; i < result.length; i++) {
    const ch = result[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') braceDepth++;
    if (ch === '}') braceDepth--;
    if (ch === '[') bracketDepth++;
    if (ch === ']') bracketDepth--;
  }
  if (inString) result += '"';
  for (let i = 0; i < bracketDepth; i++) result += ']';
  for (let i = 0; i < braceDepth; i++) result += '}';
  return result;
}

// =============================================================================
// 单批翻译
// =============================================================================

const CAPTION_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const CAPTION_MODEL = 'deepseek-v4-flash';

/**
 * 字幕专用简化 system prompt。
 *
 * 比通用 prompt 短 ~80 tokens，针对字幕特点：
 * - 短文本、口语化
 * - 保持时间轴顺序（id 即顺序）
 * - 不需要术语表 / 站点规则
 */
const CAPTION_SYSTEM_PROMPT = [
  'Translate English subtitles to Simplified Chinese.',
  '',
  '1. Return {"translations":[{"id":"0","translated_text":"译文"}]}. One entry per subtitle, same ids.',
  '2. Translate naturally and concisely. Subtitles are spoken language — use colloquial Chinese.',
  '3. Keep numbers, URLs, and code unchanged.',
  '4. Keep each subtitle short — match the original\'s brevity.',
].join('\n');

interface TranslationEntry {
  id: string;
  translated_text: string;
}

/**
 * 调用 DeepSeek API 翻译一批字幕。返回 id -> translated_text 的映射。
 *
 * @param apiKey DeepSeek API Key
 * @param blocks 要翻译的字幕块（id + text）
 * @param signal AbortSignal，取消时立即中止 fetch 请求
 */
export async function translateBatch(
  apiKey: string,
  blocks: Array<{ id: string; text: string }>,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  if (blocks.length === 0) return new Map();

  // 取消检查：如果已经 abort，直接返回空 map
  if (signal?.aborted) return new Map();

  const blocksJson = JSON.stringify(blocks, null, 2);
  // 估算输入 token 数（英文 ≈ 4 字符/token，JSON 结构开销另算）
  // 输出通常和输入差不多（中文翻译可能更短，但留余量 ×2）
  const estimatedInputTokens = Math.ceil(blocksJson.length / 4);
  const maxTokens = Math.max(2048, estimatedInputTokens * 2);

  const body = {
    model: CAPTION_MODEL,
    messages: [
      { role: 'system' as const, content: CAPTION_SYSTEM_PROMPT },
      { role: 'user' as const, content: 'JSON:\n\n' + blocksJson },
    ],
    response_format: { type: 'json_object' },
    temperature: 0.1,
    max_tokens: maxTokens,
    thinking: { type: 'disabled' },
    stream: false,
  };

  const response = await fetch(CAPTION_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
    },
    body: JSON.stringify(body),
    signal, // 让 fetch 在 abort 时抛 AbortError
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error('DeepSeek API error: HTTP ' + response.status + ' - ' + text.substring(0, 200));
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('DeepSeek 返回了无效响应: 缺少 choices[0].message.content');
  }

  // 调试日志：查看 API 实际返回的内容（定位"字幕不翻译"问题的关键证据）
  console.log('[YouTubeCaptions] API returned (blocks=' + blocks.length + '):', content.substring(0, 300));

  let cleaned = stripThinkingTags(content);
  cleaned = stripMarkdownCodeBlock(cleaned);
  try {
    const parsed = JSON.parse(cleaned);
    const result = parseTranslations(parsed);
    console.log('[YouTubeCaptions] Parsed:', result.size, 'translations from', blocks.length, 'blocks');
    return result;
  } catch {
    const repaired = repairTruncatedJson(cleaned);
    try {
      const parsed = JSON.parse(repaired);
      const result = parseTranslations(parsed);
      console.log('[YouTubeCaptions] Parsed (after repair):', result.size, 'translations from', blocks.length, 'blocks');
      return result;
    } catch {
      console.error('[YouTubeCaptions] Failed to parse translation:', cleaned.substring(0, 200));
      return new Map();
    }
  }
}

/**
 * 从 DeepSeek 返回的 JSON 中提取翻译结果。
 *
 * 兼容多种返回格式（防止模型不严格遵守 prompt 指令导致静默失败）：
 *   - {"translations": [{"id":"0","translated_text":"你好"}]}
 *   - {"results": [...]}
 *   - {"data": [...]}
 *   - [{"id":"0","translated_text":"你好"}, ...]  （直接返回数组）
 *
 * 字段名也兼容：
 *   - translated_text / translation / translatedText
 *   - id 可能是 number 或 string
 */
function parseTranslations(parsed: any): Map<string, string> {
  // 兼容多种容器字段名
  let translations: any[] = [];
  if (Array.isArray(parsed)) {
    // 直接返回数组
    translations = parsed;
  } else if (Array.isArray(parsed?.translations)) {
    translations = parsed.translations;
  } else if (Array.isArray(parsed?.results)) {
    translations = parsed.results;
  } else if (Array.isArray(parsed?.data)) {
    translations = parsed.data;
  }

  const map = new Map<string, string>();
  for (const t of translations) {
    if (t == null || typeof t !== 'object') continue;
    // 兼容多种字段名
    const translated = t.translated_text || t.translation || t.translatedText || t.text;
    if (t.id != null && translated != null) {
      map.set(String(t.id), String(translated));
    }
  }
  return map;
}

// =============================================================================
// Ahead Buffer 翻译
// =============================================================================

/** 默认 Ahead Buffer 时间窗口（90 秒预取） */
export const DEFAULT_AHEAD_MS = 90_000;

/** 每批最多翻译的字幕条数 */
export const BATCH_SIZE = 50;

/**
 * Ahead Buffer 翻译：翻译 [fromMs, fromMs + aheadMs] 时间窗口内的未翻译字幕。
 *
 * 调用方（Manager）应该在 video.timeupdate / 定时轮询时调用此函数：
 *   - 第一次调用：fromMs = 0，翻译 0~90 秒字幕
 *   - 播放到 40 秒：fromMs = 40000，翻译 60~150 秒字幕（已翻译的会跳过）
 *
 * 翻译状态：
 *   - pending -> translating（标记中，避免重复翻译）
 *   - translating -> done（翻译成功） / failed（翻译失败，可重试）
 *
 * 取消机制：
 *   - signal.aborted 时立即返回，不再继续后续批次
 *   - fetch 在 abort 时会抛 AbortError，被 catch 后停止
 *
 * @param captions 全部字幕数组（直接修改 status 和 translatedText）
 * @param fromMs 起始时间（毫秒），通常用 video.currentTime * 1000
 * @param aheadMs 预取时间窗口（毫秒），默认 90 秒
 * @param apiKey DeepSeek API Key
 * @param signal AbortSignal，用于取消
 * @param onProgress 进度回调
 */
export async function translateAhead(
  captions: CaptionEvent[],
  fromMs: number,
  aheadMs: number,
  apiKey: string,
  signal?: AbortSignal,
  onProgress?: ProgressCallback,
): Promise<void> {
  if (captions.length === 0) return;

  const endMs = fromMs + aheadMs;

  // 收集需要翻译的字幕（在 [fromMs - 5s, endMs] 范围内，状态为 pending 或 failed）
  // -5s 是为了包含刚开始播放但还没翻完的字幕
  //
  // 同时记录每条字幕在 captions 数组中的全局索引（globalIdx），
  // 避免后续用 captions.indexOf(c) 做 O(N) 查找（旧实现是 O(N²)）。
  const lookbackMs = 5000;
  const toTranslate: Array<{ caption: CaptionEvent; globalIdx: number }> = [];
  for (let i = 0; i < captions.length; i++) {
    if (signal?.aborted) return;
    const c = captions[i];
    if (c.status === 'done' || c.status === 'translating') continue;
    // 字幕在 [fromMs-lookback, endMs] 范围内
    if (c.startMs + c.durationMs < fromMs - lookbackMs) continue;
    if (c.startMs > endMs) break; // captions 按时间排序，可以提前 break
    toTranslate.push({ caption: c, globalIdx: i });
  }

  if (toTranslate.length === 0) return;

  console.log('[YouTubeCaptions] translateAhead: need=' + toTranslate.length +
    ', fromMs=' + fromMs + ', aheadMs=' + aheadMs);

  // 分批翻译
  const total = toTranslate.length;
  let done = 0;

  for (let i = 0; i < toTranslate.length; i += BATCH_SIZE) {
    if (signal?.aborted) return;

    const batch = toTranslate.slice(i, i + BATCH_SIZE);

    // 标记为 translating（避免重复翻译）
    batch.forEach(({ caption }) => { caption.status = 'translating'; });

    // 用 globalIdx 作为 id（保证全局唯一，O(1) 无需 indexOf）
    const blocks = batch.map(({ caption, globalIdx }) => ({
      id: String(globalIdx),
      text: caption.text,
    }));

    try {
      const resultMap = await translateBatch(apiKey, blocks, signal);

      // 回填翻译结果（用 globalIdx 直接查 map，无需 indexOf）
      for (const { caption, globalIdx } of batch) {
        const id = String(globalIdx);
        const translated = resultMap.get(id);
        if (translated) {
          caption.translatedText = translated;
          caption.status = 'done';
        } else {
          caption.status = 'failed';
        }
      }
    } catch (e) {
      // fetch 抛 AbortError 时停止；其他错误标记为 failed 继续下一批
      if (signal?.aborted) {
        batch.forEach(({ caption }) => { caption.status = 'pending'; });
        return;
      }
      console.error('[YouTubeCaptions] Batch failed:', e);
      batch.forEach(({ caption }) => { caption.status = 'failed'; });
    }

    done += batch.length;
    onProgress?.(done, total);
  }
}

// =============================================================================
// 兼容接口：translateCaptions（一次性全量翻译，用于测试和回退场景）
// =============================================================================

/**
 * 一次性全量翻译所有字幕。
 *
 * 保留此函数是为了：
 *   - 兼容现有测试用例
 *   - 提供一个简单的回退接口（例如 Manager 内部初次预翻译前 N 条时可用）
 *
 * 注意：Manager 默认走 translateAhead 增量路径，不调用此函数。
 */
export async function translateCaptions(
  captions: CaptionEvent[],
  apiKey: string,
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  if (captions.length === 0) return;

  // 把所有字幕标记为 pending，然后调用 translateAhead 翻译全部
  captions.forEach((c) => {
    if (c.status !== 'done') c.status = 'pending';
  });

  // aheadMs 设为一个很大的值，相当于翻译全部
  await translateAhead(captions, 0, Number.MAX_SAFE_INTEGER, apiKey, signal, onProgress);
}
