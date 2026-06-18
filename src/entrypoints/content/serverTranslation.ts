import { applyBlockTranslation } from '../utils/translationDisplay';
import type { TextBlock } from '../utils/blockExtractor';
import type { Config } from '../utils/config';

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

  const fullHtml = clone.outerHTML;
  const bodyHtml = clone.querySelector('body')?.outerHTML ?? fullHtml;
  return fullHtml.length > MAX_FULL_HTML_CHARS ? bodyHtml : fullHtml;
}

/**
 * 通过服务端翻译页面。
 * 发送包含 data-fanyi-block-id 的 HTML 到 /fanyi/page，
 * 解析返回的双语对照 HTML，提取 .fanyi-translation 文本并回填到当前 DOM。
 */
export async function translateViaServer(
  config: Config,
  blocks: TextBlock[],
  nodeMap: Map<string, Node>,
): Promise<Set<string>> {
  const serverUrl = config.serverUrl?.trim() || 'https://s.sunxiunan.com/fanyi/page';
  const url = window.location.href;
  // 服务端翻译使用的 LLM 提供方，直接复用本地 provider 配置
  // （deepseek/openrouter/nvidia/cloudflare）。
  // 服务端 /fanyi/page 根据 provider 字段选择对应的 LLM。
  const provider = config.provider || 'deepseek';

  const apiKey = config.deepseekApiKey?.trim();
  // provider=deepseek 时，服务端会用客户端提供的 API Key 调用 DeepSeek，所以必须校验；
  // 其他 provider 由服务端自行管理凭据，客户端不需要 API Key。
  if (provider === 'deepseek' && !apiKey) {
    throw new Error('DeepSeek API Key 未配置，服务端翻译（DeepSeek）需要 API Key');
  }

  const html = prepareHtmlForServer();
  console.log(
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
  };
  // 仅当 provider=deepseek 时才把客户端的 API Key 发给服务端；
  // 其他 provider 的凭据由服务端自行管理。
  if (provider === 'deepseek' && apiKey) {
    body.apiKey = apiKey;
  }

  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    console.error('[ServerTranslation] server error body:', errorBody);
    throw new Error(
      `服务端翻译失败: ${response.status} ${response.statusText}` +
        (errorBody ? ` — ${errorBody.substring(0, 500)}` : ''),
    );
  }

  const translatedHtml = await response.text();

  // 解析返回的 HTML，提取翻译后的文本
  const parser = new DOMParser();
  const translatedDoc = parser.parseFromString(translatedHtml, 'text/html');

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
