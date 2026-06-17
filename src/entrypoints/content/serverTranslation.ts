import { applyBlockTranslation, cleanupTranslationMarks } from '../utils/translationDisplay';
import type { TextBlock } from '../utils/blockExtractor';
import type { Config } from '../utils/config';

// 大多数平台（Cloudflare Workers / Netlify Functions）请求体限制约 1MB。
// 保守阈值：超过 900KB 时只发送 body，避免被网关截断导致服务端收到空 body 报 400。
const MAX_FULL_HTML_CHARS = 900_000;

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
  const apiKey = config.deepseekApiKey?.trim();
  if (!apiKey) {
    throw new Error('DeepSeek API Key 未配置，服务端翻译需要 API Key');
  }

  // 先清理当前 DOM 中已有的翻译标记，避免把原文+译文双语文本一起发给服务端。
  // 注意：这里不清理 data-fanyi-block-id，服务端仍然可以直接定位 block。
  cleanupTranslationMarks();

  const fullHtml = document.documentElement.outerHTML;
  const bodyHtml = document.body?.outerHTML ?? fullHtml;
  const html = fullHtml.length > MAX_FULL_HTML_CHARS ? bodyHtml : fullHtml;

  console.log(
    `[ServerTranslation] url=${url} fullHtml=${fullHtml.length} bytes ` +
      `sentHtml=${html.length} bytes (bodyFallback=${html === bodyHtml})`,
  );

  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html,
      url,
      apiKey,
      source: config.sourceLang,
      target: config.targetLang,
      // 扩展端只支持双语对照模式，服务端也已强制此模式
      mode: 'bilingual' as const,
      // /fanyi/page 固定使用 DeepSeek，服务端不接受其他 service
      service: 'deepseek' as const,
    }),
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
