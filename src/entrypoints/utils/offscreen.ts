/**
 * utils/offscreen.ts — 创建并驱动离屏文档（offscreen document）。
 *
 * 背景 service worker 没有 DOM，无法用 DOMParser 解析 HTML。
 * 当目标页没有 content script（CSP 拦截 / 特殊页）导致 extractChatContext
 * 取不到正文时，background 用 scripting.executeScript 拿到页面 HTML 源码，
 * 再交给 offscreen 文档里的 DOMParser 抽取正文回传。
 *
 * chrome://、about: 等页面 fetch / executeScript 都被浏览器拦截，
 * 那种情况仍走"手动粘贴"兜底（见 side panel UI）。
 */
import browser from 'webextension-polyfill';

const OFFSCREEN_URL = '/offscreen.html';

let offscreenReady = false;

/**
 * 确保离屏文档已创建。
 * 同名文档已存在时 createDocument 会 reject，忽略即可（幂等）。
 */
async function ensureOffscreenDocument(): Promise<void> {
  if (offscreenReady) return;
  const offscreen = (browser as any).offscreen;
  if (!offscreen?.createDocument) {
    throw new Error('offscreen API 不可用（仅 MV3 Chrome 支持）');
  }
  try {
    await offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['DOM_PARSER'],
      justification: '解析没有 content script 的页面正文，作为对话上下文',
    });
    offscreenReady = true;
  } catch (err) {
    // 已存在同名 offscreen 文档时视为就绪；其他错误上抛给调用方。
    const msg = err instanceof Error ? err.message : String(err);
    if (/already exists|duplicate/i.test(msg)) {
      offscreenReady = true;
    } else {
      throw err;
    }
  }
}

/**
 * 把 HTML 源码发给 offscreen 文档，用 DOMParser 抽正文后回传。
 * 失败返回空串（不抛），让上层决定走其它兜底。
 */
export async function parseHtmlViaOffscreen(html: string): Promise<string> {
  await ensureOffscreenDocument();
  const res = (await browser.runtime.sendMessage({ type: 'parseHtml', html })) as
    | { text?: string }
    | undefined;
  return res?.text ?? '';
}

/**
 * 用 scripting API 注入一段函数，取回整页 HTML 源码。
 * 能在"没有 content script 监听"的普通网页上运行（与 content script
 * matches 无关），但 chrome:// 等页面仍会被拦截。
 */
export async function getPageHtmlViaScripting(tabId: number): Promise<string | null> {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => document.documentElement.outerHTML,
    });
    const first = (results as Array<{ result?: unknown }> | undefined)?.[0];
    return typeof first?.result === 'string' ? first.result : null;
  } catch {
    return null;
  }
}
