import { logger } from '../../utils/logger';

/**
 * 发送前样式表内联化 —— 在浏览器上下文里把外联 CSS 抓下来嵌进 HTML。
 *
 * ## 为什么必须在扩展端做（服务端 cssInliner 不够）
 *
 * 服务端 /translate 路径已有 cssInliner（vocal-saga lib/translate/cssInliner.ts），
 * 但它从 Worker 机房 IP 抓取，两类站点会失败：
 *
 *   1. Akamai/Cloudflare 防爬站点（典型：snowflake.com）：Worker 抓页面直接 403，
 *      抓 CSS 返回 204 空内容 —— 没有第一方 cookie 一律拦下；
 *   2. 需要 cookie 的登录后页面：Worker 根本没有会话。
 *
 * 而扩展端跑在真实页面上下文里：同源 CSS 自带 cookie，跨源 CSS 走公开 CDN。
 * 结果缓存页自包含，不再依赖原站资源存活（哈希文件名 404 问题一并解决）。
 *
 * ## 失败语义
 *
 * 单个样式表抓取失败（网络错、CORS、超时、非 CSS、超大小）只跳过该表，
 * 保留原 <link>，绝不让整体翻译失败 —— CSS 内联是尽力而为的增强。
 */

export interface InlineStylesheetsOptions {
  /** 单个样式表字节上限，超出跳过。默认 512KB */
  maxBytesPerSheet?: number;
  /** 总字节预算，超出停止内联后续。默认 1.5MB */
  maxBytesTotal?: number;
  /** 单请求超时（毫秒）。默认 8000 */
  timeoutMs?: number;
  /** 最多内联几个样式表。默认 8 */
  maxSheets?: number;
  /** 可注入 fetch（测试用） */
  fetchFn?: typeof fetch;
  /** 解析相对 href 的基准（默认 live document 的 baseURI，测试可注入） */
  baseUri?: string;
  /** 内联失败回调（默认 console.warn，测试可静音） */
  onError?: (url: string, reason: string) => void;
}

const DEFAULT_MAX_BYTES_PER_SHEET = 512 * 1024;
const DEFAULT_MAX_BYTES_TOTAL = 1.5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_SHEETS = 8;

interface SheetLink {
  el: HTMLLinkElement;
  href: string;
  media: string;
}

export interface InlineResult {
  /** 成功内联的样式表数量 */
  inlined: number;
  /** 内联的 CSS 总字节数 */
  bytes: number;
}

/**
 * 在 clone 出的 DOM 上内联全部外联样式表。
 *
 * @param clone prepareHtmlForServer 克隆出的 documentElement，将被就地修改
 * @param opts  上限与依赖注入
 */
export async function inlineStylesheetsInClone(
  clone: HTMLElement,
  opts: InlineStylesheetsOptions = {},
): Promise<InlineResult> {
  const links = collectStylesheetLinks(clone, opts.maxSheets ?? DEFAULT_MAX_SHEETS);
  if (links.length === 0) return { inlined: 0, bytes: 0 };

  const maxBytesPerSheet = opts.maxBytesPerSheet ?? DEFAULT_MAX_BYTES_PER_SHEET;
  const maxBytesTotal = opts.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const doFetch = opts.fetchFn ?? fetch.bind(globalThis);
  const onError = opts.onError ?? ((url, reason) => logger.warn(`[InlineCss] skip ${url}: ${reason}`));
  const baseUri = opts.baseUri ?? document.baseURI;

  // 并发抓取：样式表之间无依赖
  const fetched = await Promise.all(
    links.map(async (link): Promise<{ link: SheetLink; abs: string; css: string } | null> => {
      let abs: string;
      let parsed: URL;
      try {
        parsed = new URL(link.href, baseUri);
        abs = parsed.href;
      } catch {
        return null;
      }
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await doFetch(abs, { signal: controller.signal });
        if (!response.ok) {
          onError(abs, `HTTP ${response.status}`);
          return null;
        }
        const css = await response.text();
        // 兜底：204 空响应 / 200 但内容是 HTML 错误页（防爬站点常见）都不内联
        if (!css.trim()) {
          onError(abs, 'empty body');
          return null;
        }
        if (css.trimStart().startsWith('<')) {
          onError(abs, 'looks like html, not css');
          return null;
        }
        if (css.length > maxBytesPerSheet) {
          onError(abs, `too large: ${css.length} bytes`);
          return null;
        }
        return { link, abs, css };
      } catch (e) {
        onError(abs, (e as Error)?.message ?? String(e));
        return null;
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  let total = 0;
  let inlined = 0;
  for (const item of fetched) {
    if (!item) continue;
    if (total + item.css.length > maxBytesTotal) {
      onError(item.abs, 'total budget exceeded');
      continue;
    }
    total += item.css.length;
    replaceLinkWithStyle(clone, item.link, item.abs, item.css);
    inlined += 1;
  }
  return { inlined, bytes: total };
}

/** 收集 clone 内需要内联的样式表链接（跳过 data:/blob:/javascript: 与 noscript 内的） */
function collectStylesheetLinks(root: HTMLElement, maxSheets: number): SheetLink[] {
  const out: SheetLink[] = [];
  for (const el of Array.from(root.querySelectorAll('link'))) {
    if (el.closest('noscript')) continue;
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) continue;
    const href = (el.getAttribute('href') || '').trim();
    if (!href || /^(?:data|blob|javascript):/i.test(href)) continue;
    if (out.length >= maxSheets) break;
    out.push({ el: el as HTMLLinkElement, href, media: (el.getAttribute('media') || '').trim() });
  }
  return out;
}

/**
 * 用 <style> 替换 <link>。
 * `</style` 须转义（`\/` 在 CSS 里是合法转义），否则 CSS 会提前终止标签。
 * media="print" 之类的条件样式表用 @media 包一层保留语义。
 */
function replaceLinkWithStyle(root: HTMLElement, link: SheetLink, abs: string, css: string): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const style = doc.createElement('style');
  style.setAttribute('data-fanyi-inlined-css', abs);
  const body = css.replace(/<\/style/gi, '<\\/style');
  style.textContent = needsMediaWrap(link.media) ? `@media ${link.media}{${body}}` : body;
  link.el.replaceWith(style);
}

function needsMediaWrap(media: string): boolean {
  const normalized = media.trim().toLowerCase();
  return normalized !== '' && normalized !== 'all' && normalized !== 'screen';
}
