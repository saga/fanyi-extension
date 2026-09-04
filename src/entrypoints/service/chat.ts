import { parseSSEStream } from './streamParser';
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

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

function buildBody(messages: ChatMessage[], stream: boolean): string {
  return JSON.stringify({
    model: MODEL,
    messages,
    temperature: CHAT_TEMPERATURE,
    max_tokens: CHAT_MAX_TOKENS,
    user_id: USER_ID,
    thinking: { type: 'disabled' },
    stream,
  });
}

/**
 * 构建对话 system prompt：把网页正文作为上下文注入。
 * 用户用中文提问就用中文回答；答案不在页面里时明确说明，不编造。
 */
export function buildChatSystem(context: PageContext | null): string {
  const title = context?.title ?? '';
  const url = context?.url ?? '';
  const text = (context?.text ?? '').trim();

  const pageBlock = text
    ? `标题：${title}\n链接：${url}\n正文：\n${text}`
    : '（当前没有可用的网页内容）';

  return `你是一个内嵌在浏览器翻译扩展里的智能助手。用户正在阅读一个网页，你可以利用下面提供的网页内容来回答用户的问题。

规则：
- 用用户使用的语言回答（用户用中文问就用中文答）。
- 尽量基于提供的网页内容作答；如果答案不在网页内容里，明确说明"根据当前页面内容无法找到答案"，不要编造。
- 可以引用页面中的关键信息来支撑回答，必要时给出要点列表。
- 回答要简洁、有条理、直接，不要堆砌废话。

以下是用户当前正在阅读的网页内容：
<page>
${pageBlock}
</page>`;
}

/**
 * 流式对话：逐块 yield 已累积的完整文本（便于 UI 增量渲染）。
 */
export async function* chatStream(
  apiKey: string,
  messages: ChatMessage[],
): AsyncGenerator<string, void, unknown> {
  const response = await fetch(DEFAULT_API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: buildBody(messages, true),
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
  for await (const delta of parseSSEStream(reader)) {
    full += delta;
    yield full;
  }
}

/** 非流式对话（兜底 / 测试用）。 */
export async function chat(apiKey: string, messages: ChatMessage[]): Promise<string> {
  const response = await fetch(DEFAULT_API_URL, {
    method: 'POST',
    headers: buildHeaders(apiKey),
    body: buildBody(messages, false),
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
}
