/**
 * offscreen/main.ts — 后台离屏文档，用来在"没有 content script"的页面上
 * 解析 HTML 取正文（background 的 service worker 没有 DOM，必须借 offscreen 文档）。
 *
 * 触发场景（见 background.handleGetPageContext 的兜底分支）：
 *   目标页是普通 http(s) / file://，但 content script 没注入成功
 *   （CSP 拦截、特殊页面等），background 用 fetch 拿到 HTML 源码后发到这里，
 *   由 DOMParser 抽正文再回传。chrome:// 等 fetch 被拦的页仍走手动粘贴兜底。
 */
import browser from 'webextension-polyfill';

browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as { type?: string; html?: string };
  if (m?.type === 'parseHtml' && typeof m.html === 'string') {
    try {
      const doc = new DOMParser().parseFromString(m.html, 'text/html');
      // 去掉不会贡献正文的节点
      doc.querySelectorAll('script, style, noscript, template').forEach((el) => el.remove());
      const text = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
      sendResponse({ text });
    } catch {
      sendResponse({ text: '' });
    }
    // 异步 sendResponse，需返回 true 保持消息通道打开
    return true;
  }
  return undefined;
});
