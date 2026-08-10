import { applyBlockTranslation } from '../utils/translationDisplay';
import type { TextBlock } from '../utils/blockExtractor';
import type { Config } from '../utils/config';

import { logger } from '../../utils/logger';
import { getSessionId } from '../utils/session';

/**
 * 服务端翻译失败时抛出的错误。
 * - statusCode: HTTP 状态码；0 表示网络错误（未拿到响应）。
 * 调用方（content script）收到后直接展示错误给用户，不再降级到本地翻译。
 */
export class ServerTranslationError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'ServerTranslationError';
  }
}

// 大多数平台（Cloudflare Workers / Netlify Functions）请求体限制约 1MB。
// 保守阈值：超过 900KB 时只发送 body，避免被网关截断导致服务端收到空 body 报 400。
const MAX_FULL_HTML_CHARS = 900_000;

/** 扩展端注入到 DOM 的 UI 选择器，发送 HTML 前需要移除。 */
const EXTENSION_UI_SELECTORS = [
  '.fanyi-status-overlay',
  '.fanyi-floating-btn',
  '.fanyi-config-panel',
  '.selection-translator',
] as const;

/**
 * 准备发送给服务端的 HTML：
 * 1. clone 当前 DOM，不影响用户正在看到的页面。
 * 2. 清理已有的双语译文结构（.fanyi-original / .fanyi-translation）。
 * 3. 清理扩展端 UI（状态提示、浮动按钮、配置面板等）。
 * 4. 保留 data-fanyi-block-id，让服务端能直接定位 block。
 */
function prepareHtmlForServer(): string {
  const clone = document.documentElement.cloneNode(true) as HTMLElement;

  // 清理 clone 上的翻译标记，恢复成"已标记 block id 但未翻译"的状态。
  for (const node of Array.from(clone.querySelectorAll('.fanyi-translated'))) {
    const el = node as HTMLElement;
    const originalSpan = el.querySelector('.fanyi-original');
    if (originalSpan) {
      while (originalSpan.firstChild) {
        el.insertBefore(originalSpan.firstChild, originalSpan);
      }
      originalSpan.remove();
    }
    el.querySelector('.fanyi-translation')?.remove();
    el.classList.remove('fanyi-translated');
    delete el.dataset.originalText;
  }
  for (const node of Array.from(clone.querySelectorAll('.fanyi-missing'))) {
    const el = node as HTMLElement;
    el.classList.remove('fanyi-missing');
    el.removeAttribute('title');
  }

  // 移除扩展端 UI，避免服务端把它们当成页面正文翻译或保存。
  for (const selector of EXTENSION_UI_SELECTORS) {
    for (const node of Array.from(clone.querySelectorAll(selector))) {
      node.remove();
    }
  }

  // 中和不安全的 form action：把 http:// 升级为 https://。
  // 站点（如 sigarch.org 的 FeedBlitz 订阅表单）可能在运行时被 JS 把
  // form action 改成 http://，这会触发 Mixed Content 警告并污染发送给
  // 服务端的 HTML。升级到 https 既消除警告又不破坏表单语义。
  for (const form of Array.from(clone.querySelectorAll('form[action^="http://"]'))) {
    const action = form.getAttribute('action');
    if (action) {
      form.setAttribute('action', action.replace(/^http:\/\//i, 'https://'));
    }
  }

  const fullHtml = clone.outerHTML;
  const bodyHtml = clone.querySelector('body')?.outerHTML ?? fullHtml;
  return fullHtml.length > MAX_FULL_HTML_CHARS ? bodyHtml : fullHtml;
}

function getDefaultServerUrl(config: Config): string {
  return config.serverUrl?.trim() || 'https://s.sunxiunan.com/fanyi/page';
}

/**
 * 采集当前浏览器/设备的精确信息，随请求发给服务端。
 * 服务端据此在错误日志里标注「哪个浏览器、是否移动端、屏幕多大」，
 * 用于定位「Firefox Android 失败、Chrome 成功」这类客户端差异问题。
 * 只带运行时可测量的精确值（UA / 平台 / 触屏 / 真实屏幕与视口尺寸），
 * browser / os / deviceType 由服务端统一从 UA 解析，避免两端解析逻辑不一致。
 */
function buildClientInfo() {
  const ua = navigator.userAgent || '';
  const isMobile =
    /Android/i.test(ua) ||
    /iPhone|iPad|iPod|Mobile/i.test(ua) ||
    (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 767px)').matches);
  const touch =
    'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;
  const screenW = window.screen?.width;
  const screenH = window.screen?.height;
  return {
    ua,
    platform: navigator.platform ?? '',
    isMobile,
    touch,
    ...(typeof screenW === 'number' ? { screenWidth: screenW } : {}),
    ...(typeof screenH === 'number' ? { screenHeight: screenH } : {}),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  };
}

/**
 * 查询服务端是否已有当前 URL 的翻译缓存。
 * @returns 命中的翻译后 HTML；未命中返回 null。
 */
export async function checkServerCache(config: Config): Promise<string | null> {
  const serverUrl = getDefaultServerUrl(config);
  const checkUrl = new URL(serverUrl);
  checkUrl.pathname = checkUrl.pathname.replace(/\/$/, '') + '/check';
  checkUrl.searchParams.set('url', window.location.href);
  checkUrl.searchParams.set('source', config.sourceLang || 'en');
  checkUrl.searchParams.set('target', config.targetLang || 'zh');

  const response = await fetch(checkUrl.toString(), {
    method: 'GET',
    headers: { 'X-Session-Id': getSessionId() },
  });
  if (!response.ok) {
    throw new Error(`服务端缓存检查失败: ${response.status} ${response.statusText}`);
  }
  // 204 表示未缓存
  if (response.status === 204) {
    return null;
  }
  return response.text();
}

/**
 * 解析服务端返回的双语对照 HTML，按 block id 回填到当前 DOM。
 */
export function applyServerTranslatedHtml(
  translatedHtml: string,
  blocks: TextBlock[],
  nodeMap: Map<string, Node>,
): Set<string> {
  const parser = new DOMParser();
  // 服务端返回的 HTML 可能包含 <base href="...">，用于相对路径解析。
  // 但某些站点 CSP 设置 base-uri 'none'，DOMParser 解析 <base> 时会触发违例。
  // 扩展端只提取 .fanyi-translation 文本回填，不需要 base URI，直接移除。
  const sanitizedHtml = translatedHtml
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<\/base\b[^>]*>/gi, '');
  const translatedDoc = parser.parseFromString(sanitizedHtml, 'text/html');

  const translatedIds = new Set<string>();
  for (const block of blocks) {
    const el = translatedDoc.querySelector(`[data-fanyi-block-id="${block.id}"]`);
    if (!el) continue;

    // 服务端返回的是双语对照 HTML：元素内部有 .fanyi-original 和 .fanyi-translation
    // 扩展端只取 .fanyi-translation 的文本回填，保持与本地翻译一致的双语显示。
    const translationSpan = el.querySelector('.fanyi-translation');
    const translatedText = translationSpan?.textContent?.trim();
    if (!translatedText || translatedText === block.text) continue;

    const node = nodeMap.get(block.id);
    if (node instanceof HTMLElement) {
      applyBlockTranslation(node, translatedText);
      translatedIds.add(block.id);
    }
  }

  return translatedIds;
}

/**
 * 通过服务端翻译页面。
 * 发送包含 data-fanyi-block-id 的 HTML 到 /fanyi/page，
 * 解析返回的双语对照 HTML，提取 .fanyi-translation 文本并回填到当前 DOM。
 *
 * 失败语义：任何错误（4xx / 5xx / 网络错误）都抛 ServerTranslationError，
 * 由调用方直接展示给用户，不再静默降级到本地翻译。
 */
export async function translateViaServer(
  config: Config,
  blocks: TextBlock[],
  nodeMap: Map<string, Node>,
): Promise<Set<string>> {
  const serverUrl = getDefaultServerUrl(config);
  const url = window.location.href;
  // 服务端翻译使用的 LLM 提供方，直接复用本地 provider 配置
  // （deepseek/openrouter/nvidia/cloudflare/gemini/opencode）。
  // 服务端 /fanyi/page 根据 provider 字段选择对应的 LLM。
  const provider = config.provider || 'deepseek';

  const apiKey = config.deepseekApiKey?.trim();
  // provider=deepseek 时，服务端会用客户端提供的 API Key 调用 DeepSeek，所以必须校验；
  // 其他 provider 由服务端自行管理凭据，客户端不需要 API Key。
  if (provider === 'deepseek' && !apiKey) {
    throw new Error('DeepSeek API Key 未配置，服务端翻译（DeepSeek）需要 API Key');
  }

  const html = prepareHtmlForServer();
  logger.debug(
    `[ServerTranslation] url=${url} provider=${provider} sentHtml=${html.length} bytes ` +
      `(bodyFallback=${html.startsWith('<body')})`,
  );

  const body: Record<string, any> = {
    html,
    url,
    source: config.sourceLang,
    target: config.targetLang,
    // 扩展端只支持双语对照模式，服务端也已强制此模式
    mode: 'bilingual' as const,
    provider,
    // 翻译文风：default=通用直译, jinyong=金庸武侠, acheng=阿城白描, wangxiaobo=王小波大白话
    promptStyle: config.promptStyle,
    // 客户端浏览器/设备信息，供服务端错误日志标注（见 vocal-saga lib/clientInfo）
    client: buildClientInfo(),
    // 单次翻译会话标识，供服务端把 check→page→报错 整条链路关联到同一 sid
    sessionId: getSessionId(),
  };
  // 仅当 provider=deepseek 时才把客户端的 API Key 发给服务端；
  // 其他 provider 的凭据由服务端自行管理。
  if (provider === 'deepseek' && apiKey) {
    body.apiKey = apiKey;
  }

  // 网络错误（DNS 失败、连接超时、CORS 拦截等）拿不到 HTTP 响应，
  // 直接抛错由调用方展示给用户。
  let response: Response;
  try {
    response = await fetch(serverUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Id': getSessionId() },
      body: JSON.stringify(body),
    });
  } catch (networkErr) {
    const msg = networkErr instanceof Error ? networkErr.message : String(networkErr);
    logger.error('[ServerTranslation] network error:', msg);
    throw new ServerTranslationError(
      `服务端翻译网络请求失败: ${msg}`,
      0, // 0 表示未拿到 HTTP 响应
    );
  }

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    logger.error('[ServerTranslation] server error body:', errorBody);
    throw new ServerTranslationError(
      `服务端翻译失败: ${response.status} ${response.statusText}` +
        (errorBody ? ` — ${errorBody.substring(0, 500)}` : ''),
      response.status,
    );
  }

  const translatedHtml = await response.text();
  return applyServerTranslatedHtml(translatedHtml, blocks, nodeMap);
}
