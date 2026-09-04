import { parseSSEStream, parseSSEStreamWithUsage, type SSEUsage } from './streamParser';
import type { PageContext } from '../../types/messages';
import { logger } from '../../utils/logger';

const DEFAULT_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const USER_ID = 'fanyi-extension';
const CHAT_TEMPERATURE = 0.7;
const CHAT_MAX_TOKENS = 2000;

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** KV Cache 命中遥测：从流式尾帧的 usage 归一化而来，供 UI 展示缓存命中率。 */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
}

/** chatStream / chat 的可选参数。 */
export interface ChatOptions {
  /** 原生 JSON 模式：附加 response_format=json_object（DeepSeek 要求 prompt 含 'json' 字样）。
   *  聊天默认关闭以保持对话自然；结构化抽取场景由调用方开启。 */
  jsonMode?: boolean;
  /** 取消信号：用户关闭侧栏 / 导航时中断在途请求。 */
  signal?: AbortSignal;
  /** KV Cache 命中遥测：流结束（含 usage）后回传归一化用量，用于观察缓存命中率。 */
  onUsage?: (usage: ChatUsage) => void;
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildBody(messages: ChatMessage[], stream: boolean, opts?: ChatOptions): string {
  const body: Record<string, unknown> = {
    model: MODEL,
    messages,
    temperature: CHAT_TEMPERATURE,
    max_tokens: CHAT_MAX_TOKENS,
    user_id: USER_ID,
    thinking: { type: 'disabled' },
    stream,
  };
  // 流式下需显式开启才能拿到 usage（含 prompt_cache_hit/miss_tokens）
  if (stream) body.stream_options = { include_usage: true };
  // 原生 JSON 模式：结构化输出，避免偶发非 JSON 触发上层整段重解析
  if (opts?.jsonMode) body.response_format = { type: 'json_object' };
  return JSON.stringify(body);
}

/** 把 DeepSeek 原始 usage 归一化为 provider 无关的 ChatUsage。
 *  prompt_cache_hit + prompt_cache_miss ≈ prompt_tokens（命中+未命中）。 */
function normalizeUsage(u: SSEUsage): ChatUsage {
  const cacheHit = u.prompt_cache_hit_tokens ?? 0;
  const cacheMiss =
    u.prompt_cache_miss_tokens ?? Math.max((u.prompt_tokens ?? 0) - cacheHit, 0);
  return {
    promptTokens: u.prompt_tokens ?? 0,
    completionTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? 0,
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
  };
}

/**
 * 构建对话 system prompt：把网页正文作为上下文注入。
 * 用户用中文提问就用中文回答；答案不在页面里时明确说明，不编造。
 */
export function buildChatSystem(context: PageContext | null, jsonMode = false): string {
  const title = context?.title ?? '';
  const url = context?.url ?? '';
  const text = (context?.text ?? '').trim();

  const pageBlock = text
    ? `标题：${title}\n链接：${url}\n正文：\n${text}`
    : '（当前没有可用的网页内容）';

  const jsonRule = jsonMode
    ? '\n- 始终以 JSON 对象形式回复（JSON 模式已开启），不要包含任何解释性文字或代码块包裹，直接输出可被解析的 JSON。'
    : '';

  return `你是一个内嵌在浏览器翻译扩展里的智能助手。用户正在阅读一个网页，你可以利用下面提供的网页内容来回答用户的问题。

规则：
- 用用户使用的语言回答（用户用中文问就用中文答）。
- 尽量基于提供的网页内容作答；如果答案不在网页内容里，明确说明"根据当前页面内容无法找到答案"，不要编造。
- 可以引用页面中的关键信息来支撑回答，必要时给出要点列表。
- 回答要简洁、有条理、直接，不要堆砌废话。${jsonRule}

以下是用户当前正在阅读的网页内容：
<page>
${pageBlock}
</page>`;
}

/**
 * 流式对话：逐块 yield 已累积的完整文本（便于 UI 增量渲染）。
 * 通过 opts.onUsage 在流结束（含 usage）后回传 KV Cache 命中遥测；
 * opts.signal 可中断在途请求（用户关闭侧栏时）。
 */
export async function* chatStream(
  apiKey: string,
  messages: ChatMessage[],
  opts?: ChatOptions,
): AsyncGenerator<string, void, unknown> {
  const response = await fetch(DEFAULT_API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: buildBody(messages, true, opts),
    signal: opts?.signal,
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`DeepSeek API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
  }

  if (!response.body) {
    throw new Error('DeepSeek API error: response body is null');
  }

  const reader = response.body.getReader();
  let full = '';
  let lastUsage: SSEUsage | null = null;
  for await (const chunk of parseSSEStreamWithUsage(reader)) {
    if (chunk.delta) {
      full += chunk.delta;
      yield full;
    }
    if (chunk.usage) lastUsage = chunk.usage;
  }

  if (opts?.onUsage && lastUsage) opts.onUsage(normalizeUsage(lastUsage));

  // 偶发空内容（DeepSeek 已知问题，JSON 模式更常见）→ 抛错交由上层提示重试
  if (!full.trim()) {
    throw new Error('DeepSeek 返回了空内容，请重试');
  }
}

/** 非流式对话（兜底 / 测试用）。JSON 模式偶发空内容时单次重试。 */
export async function chat(
  apiKey: string,
  messages: ChatMessage[],
  opts?: ChatOptions,
): Promise<string> {
  const body = buildBody(messages, false, opts);

  const tryOnce = async (): Promise<string> => {
    const response = await fetch(DEFAULT_API_URL, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body,
      signal: opts?.signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`DeepSeek API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    const data = JSON.parse(await response.text());
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('DeepSeek 返回了无效响应: 缺少 choices[0].message.content');
    }
    return content as string;
  };

  let text = await tryOnce();
  if (opts?.jsonMode && !text.trim()) text = await tryOnce();
  return text;
}
