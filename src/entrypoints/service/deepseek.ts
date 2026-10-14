import type { TranslationService, Glossary, JsonSchemaResponseFormat, TranslationSessionContext } from './_service';
import { MODEL_FETCH_TIMEOUT_MS } from './_service';
import { parseSSEStream } from './streamParser';
import { logUnchangedBlocks } from '../utils/translateApi';
import { buildStyledSystemContent, type PromptStyle, type TranslationMode } from './prompt-style';

import { logger } from '../../utils/logger';

// 文风类型与调度集中在 service/prompt-style.ts；此处再导出，
// 让既有 `from '../service/deepseek'` 的引用保持可用。
export type { PromptStyle, TranslationMode };
const DEFAULT_API_URL = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-v4-flash';
const USER_ID = 'fanyi-extension';
const TRANSLATION_TEMPERATURE = 0.1;

/**
 * 估算 max output tokens for translation.
 *
 * 真实边界（已查 https://api-docs.deepseek.com/quick_start/pricing）：
 * - deepseek-v4-flash MAX OUTPUT = 384K（硬上限非常高）
 * - 计费 = actual tokens × price，不是 reserve × price
 *   → reserve 大小不会让账单变大，只影响 worst-case latency
 * - 必须设 cap，因为 response_format: json_object 下模型失控时
 *   可能"unending stream of whitespace"跑到 384K 仍不停
 *   （见 https://api-docs.deepseek.com/api/create-chat-completion）
 *
 * 翻译 ratio 经验值（chunkBuilder TARGET_TOKENS=800 → 典型 chunk）：
 * - input 800 tokens (12 blocks) → output ~2000 tokens
 * - input 1500 tokens (18 blocks) → output ~3700 tokens
 * - input 2000 tokens (30 blocks, worst case) → output ~5000 tokens
 * - + JSON 包装（id/translated_text 键名、引号、换行）≈ +10-20%
 *
 * 当前公式：* 4 * 2 = 8x input tokens，最低 1024。
 *  - 800 input  →  6400 reserve（典型 12 块，3.2x headroom）
 *  - 1500 input → 12000 reserve（18 块，3.2x headroom）
 *  - 2000 input → 16000 reserve（30 块，3.2x headroom）
 *  - 200 input  →  1024 reserve（retry 单块的下限）
 * 3.2x headroom 给模型留出"想多说点"或"加注释"的余量，同时远
 * 小于 384K 硬上限。再大的 chunk 触顶靠 content.ts 的 per-block
 * retry 兜底（retry 切到 1-3 块的小 chunk，reserve 永远不会触顶）。
 */
function estimateMaxTokens(inputJson: string): number {
  // Rough estimate: 1 char ≈ 0.3 tokens for English, 0.5 for CJK
  const estimatedInputTokens = Math.ceil(inputJson.length * 0.5);
  return Math.max(1024, Math.ceil(estimatedInputTokens * 8 * 2));
}

function buildHeaders(apiKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  };
}

/**
 * 按文风构建 system prompt（扩展端入口）。
 *
 * 文风调度本身在 `service/prompt-style.ts`（两端共用的同步对），
 * 本函数只多做一件事：把站点规则追加到末尾。
 *
 * 注意 `sitePrompt` 在签名中位于 `glossary` 之前 —— 这是扩展端的历史签名，
 * vocal-saga 端没有站点规则，签名不同。调用方不要按位置猜参数。
 */
export function buildSystemContent(
  sourceLang: string,
  targetLang: string,
  sitePrompt?: string,
  glossary?: Glossary,
  style?: PromptStyle,
  translationMode: TranslationMode = 'technical',
): string {
  const content = buildStyledSystemContent(sourceLang, targetLang, glossary, style, translationMode);
  return sitePrompt ? content + '\n\nSite-specific rules:\n' + sitePrompt : content;
}

function buildTranslationBody(
  blocks: Array<{ id: string; text: string; contextPath?: string; kind?: string; level?: number; marker?: string }>,
  sourceLang: string,
  targetLang: string,
  sitePrompt?: string,
  glossary?: Glossary,
  style?: PromptStyle,
  modelOverride = MODEL,
  responseFormat?: JsonSchemaResponseFormat,
  translationMode: TranslationMode = 'technical',
) {
  const hasDocumentContext = blocks.some((block) => !!block.contextPath?.trim() || !!block.kind || !!block.marker);
  const blocksJson = JSON.stringify(
    blocks.map((b) => ({
      id: b.id,
      text: b.text,
      ...(b.contextPath?.trim() ? { contextPath: b.contextPath.trim() } : {}),
      ...(b.kind ? { kind: b.kind } : {}),
      ...(Number.isInteger(b.level) ? { level: b.level } : {}),
      ...(b.marker ? { marker: b.marker } : {}),
    })),
    null,
    2
  );

  // user message 精简到 "JSON:" + blocks — 比 "Output JSON only."
  // 更短，同时 "JSON" 字样满足 response_format: json_object 硬约束。
  const systemContent = buildSystemContent(
    sourceLang,
    targetLang,
    sitePrompt,
    translationMode === 'literary' || !hasGlossaryEntries(glossary) ? undefined : glossary,
    style,
    translationMode,
  );
  logger.debug('[DeepSeek] System prompt built:\n' + systemContent);
  return {
    model: modelOverride,
    messages: [
      {
        role: 'system' as const,
        content: systemContent,
      },
      {
        role: 'user' as const,
        content: hasDocumentContext
          ? `下面的 JSON 包含待翻译片段。只翻译每个对象的 text 字段。contextPath 是只读章节语境；kind、level 和 marker 是只读文档结构元数据，用于区分标题、正文和列表并保留原始编号。不要翻译这些元数据或将它们混入译文，保持原有 id 与翻译响应协议不变。\n\nJSON:\n\n${blocksJson}`
          : `JSON:\n\n${blocksJson}`,
      },
    ],
    response_format: responseFormat ?? { type: 'json_object' },
    temperature: TRANSLATION_TEMPERATURE,
    max_tokens: estimateMaxTokens(blocksJson),
    user_id: USER_ID,
    thinking: { type: 'disabled' },
    stream: false,
  };
}

async function callApi(
  apiKey: string,
  body: string,
  endpoint = DEFAULT_API_URL,
): Promise<string> {
  const isLocalAgentEndpoint = endpoint !== DEFAULT_API_URL;
  const serviceLabel = isLocalAgentEndpoint ? '本机 Agent 服务' : 'DeepSeek API';
  try {
    logger.debug(
      '[' + (isLocalAgentEndpoint ? 'LocalAgent' : 'DeepSeek') + '] request start',
      { endpoint, requestChars: body.length },
    );
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body,
      // 无超时会无限"翻译中…"：stall 转 TimeoutError，下方 catch 转中文错。
      signal: AbortSignal.timeout(MODEL_FETCH_TIMEOUT_MS),
    });

    logger.debug('[' + (isLocalAgentEndpoint ? 'LocalAgent' : 'DeepSeek') + '] Response status:', response.status);

    const responseText = await response.text().catch(() => '');

    if (!response.ok) {
      let errorMessage = `HTTP ${response.status}`;

      if (isLocalAgentEndpoint) {
        logger.error('[LocalAgent] HTTP request failed', {
          endpoint,
          status: response.status,
          responseBody: responseText.slice(0, 2000),
        });
      }

      try {
        const errorJson = JSON.parse(responseText);
        if (errorJson.error) {
          errorMessage += ` - ${errorJson.error.message || errorJson.error}`;
          if (errorJson.error.type) errorMessage += ` [${errorJson.error.type}]`;
          if (errorJson.error.code) errorMessage += ` (code: ${errorJson.error.code})`;
          // Local-agent failures include a request ID that can be matched to the service log/history.
          if (errorJson.error.request_id) errorMessage += ` (local request: ${errorJson.error.request_id})`;
          if (errorJson.error.provider) errorMessage += ` (provider: ${errorJson.error.provider})`;
          if (Number.isFinite(errorJson.error.output_chars)) errorMessage += ` (model output: ${errorJson.error.output_chars} chars)`;
          if (Number.isFinite(errorJson.error.duration_ms)) errorMessage += ` (duration: ${errorJson.error.duration_ms} ms)`;
          if (errorJson.error.model) errorMessage += ` (model: ${errorJson.error.model})`;
        } else if (errorJson.message) {
          errorMessage += ` - ${errorJson.message}`;
        } else {
          errorMessage += ` - ${responseText.substring(0, 200)}`;
        }
      } catch {
        errorMessage += ` - ${responseText.substring(0, 200)}`;
      }

      if (isLocalAgentEndpoint) {
        if (response.status === 401) {
          errorMessage += '\n\n请检查扩展中的 Local service token 是否与 LOCAL_AGENT_TOKEN 一致。';
        } else if (response.status === 502) {
          errorMessage += '\n\n本机 Provider 未能完成请求；使用上方 local request ID 查询本机终端日志或 GET /api/history。';
        }
      } else if (response.status === 401) {
        errorMessage += '\n\n可能原因: API Key 无效或已过期';
      } else if (response.status === 403) {
        errorMessage += '\n\n可能原因: 账户余额不足或被封禁';
      } else if (response.status === 429) {
        errorMessage += '\n\n可能原因: 请求频率超限，请稍后重试';
      } else if (response.status === 500 || response.status === 503) {
        errorMessage += '\n\n可能原因: DeepSeek 服务暂时不可用';
      }

      throw new Error(`${serviceLabel} error: ${errorMessage}`);
    }

    const data = JSON.parse(responseText);

    const content = data.choices?.[0]?.message?.content;

    if (!content) {
      logger.error(
        '[' + (isLocalAgentEndpoint ? 'LocalAgent' : 'DeepSeek') + '] Invalid response structure:',
        { endpoint, responsePreview: JSON.stringify(data).substring(0, 1000) },
      );
      throw new Error(
        isLocalAgentEndpoint
          ? '本机 Agent 服务返回了无效响应：缺少 choices[0].message.content'
          : 'DeepSeek 返回了无效响应: 缺少 choices[0].message.content',
      );
    }

    return content;
  } catch (error) {
    if (error instanceof DOMException && error.name === 'TimeoutError') {
      const hint = isLocalAgentEndpoint
        ? '本机服务 180s 无响应；若服务终端有 local request ID 可对照日志定位卡在哪一段'
        : 'DeepSeek 长时间无响应，请稍后重试';
      logger.error('[' + (isLocalAgentEndpoint ? 'LocalAgent' : 'DeepSeek') + '] Request timed out', { endpoint });
      throw new Error(`${serviceLabel}请求超时（180s）：${hint}`);
    }
    if (error instanceof TypeError && error.message.includes('fetch')) {
      if (isLocalAgentEndpoint) {
        logger.error('[LocalAgent] Local service connection failed', {
          endpoint,
          message: error.message,
        });
        throw new Error(
          `本机 Agent 服务连接失败（${endpoint}）：${error.message}\n\n请确认本机服务已启动并监听该地址；当前为强制本机模式，不会回退到远程 API。`,
        );
      }
      logger.error('[DeepSeek] Fetch error - possible network/CORS issue:', error);
      throw new Error(`网络请求失败: ${error.message}\n\n可能原因:\n1. 网络连接问题\n2. Firefox 扩展权限不足\n3. 被防火墙/代理拦截`);
    }
    throw error;
  }
}

function hasGlossaryEntries(glossary?: Glossary): boolean {
  return (glossary?.document_terms?.length ?? 0) > 0;
}

export class DeepSeekTranslationService implements TranslationService {
  private apiKey: string;
  /** 翻译文风，默认 undefined 表示使用通用直译风格 */
  private style?: PromptStyle;
  private endpoint: string;
  private model: string;
  private translationMode: TranslationMode;

  constructor(apiKey: string, style?: PromptStyle, options?: { endpoint?: string; model?: string; translationMode?: TranslationMode }) {
    this.apiKey = apiKey;
    this.style = style;
    this.endpoint = options?.endpoint || DEFAULT_API_URL;
    this.model = options?.model || MODEL;
    this.translationMode = options?.translationMode === 'literary' ? 'literary' : 'technical';
  }

  async translate(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string,
    responseFormat?: JsonSchemaResponseFormat,
    sessionContext?: TranslationSessionContext,
  ): Promise<string> {
    const blocks = JSON.parse(jsonContent);

    const body: Record<string, any> = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang,
      context,
      hasGlossaryEntries(glossary) ? glossary : undefined,
      this.style,
      this.model,
      responseFormat,
      this.translationMode,
    );
    // The local service uses this metadata to route document batches to one isolated SDK
    // session. Do not send the extension's internal session identifiers to remote providers.
    if (sessionContext && this.endpoint !== DEFAULT_API_URL) {
      body.metadata = {
        documentSessionId: sessionContext.documentSessionId,
        sessionRole: sessionContext.role,
        sourceLang: sessionContext.sourceLang,
        targetLang: sessionContext.targetLang,
        promptStyle: sessionContext.promptStyle || this.style || 'default',
        translationMode: sessionContext.translationMode || this.translationMode,
        contextVersion: sessionContext.contextVersion || 'book-session-v1',
      };
    }

    const raw = await callApi(this.apiKey, JSON.stringify(body), this.endpoint);
    return logUnchangedBlocks(raw, blocks);
  }

  async *translateStream(
    jsonContent: string,
    sourceLang: string,
    targetLang: string,
    glossary?: Glossary,
    context?: string,
  ): AsyncGenerator<string, string, unknown> {
    // 本机 Agent 服务暂不流式输出，生成完整 chunk 后作为最后一个 partial 返回。
    if (this.endpoint !== DEFAULT_API_URL) {
      const finalContent = await this.translate(jsonContent, sourceLang, targetLang, glossary, context);
      yield finalContent;
      return finalContent;
    }
    const blocks = JSON.parse(jsonContent);

    const bodyObj = buildTranslationBody(
      blocks,
      sourceLang,
      targetLang,
      context,
      hasGlossaryEntries(glossary) ? glossary : undefined,
      this.style,
      this.model,
      undefined,
      this.translationMode,
    );
    bodyObj.stream = true;
    const body = JSON.stringify(bodyObj);

    const response = await fetch(this.endpoint, {
      method: 'POST',
      headers: buildHeaders(this.apiKey),
      body,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`DeepSeek API error: HTTP ${response.status} - ${text.substring(0, 200)}`);
    }

    if (!response.body) {
      throw new Error('DeepSeek API error: response body is null');
    }

    const reader = response.body.getReader();
    let fullContent = '';

    for await (const delta of parseSSEStream(reader)) {
      fullContent += delta;
      yield fullContent;
    }

    return logUnchangedBlocks(fullContent, blocks);
  }
}
