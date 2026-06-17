import { applyBlockTranslation } from '../utils/translationDisplay';
import type { TextBlock } from '../utils/blockExtractor';
import type { Config } from '../utils/config';

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
  const html = document.documentElement.outerHTML;
  const url = window.location.href;

  const response = await fetch(serverUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html,
      url,
      source: config.sourceLang,
      target: config.targetLang,
      // 扩展端只支持双语对照显示模式
      mode: 'bilingual' as const,
    }),
  });

  if (!response.ok) {
    throw new Error(`服务端翻译失败: ${response.status} ${response.statusText}`);
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
