import { logger } from '../../utils/logger';

/**
 * 在浏览器页面上下文中构建可持久化的 CSS 快照。
 *
 * 不只是把 <link> 换成 <style>：
 * - 递归处理常见 @import，并保留 media 条件；
 * - CSS 中的相对 url() 按原 CSS 文件的最终响应 URL 改写，避免字体/背景图片路径漂移；
 * - 对请求数、递归深度、单文件/总字节做预算；
 * - 无法完整处理的 stylesheet 保留原 <link>，并标记快照 partial，让服务端能继续兜底；
 * - 超出数量上限不再静默假定快照完整。
 *
 * CSS 只是显示增强，不应让正文翻译本身失败；但也不应把“只内联了一部分”误报为完整快照。
 */

export interface InlineStylesheetsOptions {
  /** 单张样式表及其展开结果的字节上限。默认 512 KiB。 */
  maxBytesPerSheet?: number;
  /** 所有最终内联 CSS 的字节预算。默认 1.5 MiB。 */
  maxBytesTotal?: number;
  /** 单次请求超时，包含响应体读取。默认 8000ms。 */
  timeoutMs?: number;
  /** 最多处理的顶层 stylesheet 数。默认 24；超限会显式标记 partial。 */
  maxSheets?: number;
  /** @import 最大递归深度。默认 4。 */
  maxImportDepth?: number;
  /** 顶层 CSS 与 @import 的最大请求数。默认 48。 */
  maxRequests?: number;
  /** 可注入 fetch，供测试使用。 */
  fetchFn?: typeof fetch;
  /** 解析相对 stylesheet href 的基准。默认 document.baseURI。 */
  baseUri?: string;
  /** 记录单项失败的回调。 */
  onError?: (url: string, reason: string) => void;
}

const DEFAULT_MAX_BYTES_PER_SHEET = 512 * 1024;
const DEFAULT_MAX_BYTES_TOTAL = 1.5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_SHEETS = 24;
const DEFAULT_MAX_IMPORT_DEPTH = 4;
const DEFAULT_MAX_REQUESTS = 48;
const SNAPSHOT_ATTRIBUTE = 'data-fanyi-css-snapshot';

interface SheetLink {
  el: HTMLLinkElement;
  href: string;
  media: string;
}

interface CssResult {
  css: string;
  complete: boolean;
}

interface FetchState {
  requestCount: number;
  maxRequests: number;
  timeoutMs: number;
  maxBytesPerSheet: number;
  maxImportDepth: number;
  fetchFn: typeof fetch;
  onError: (url: string, reason: string) => void;
  cache: Map<string, CssResult>;
}

export interface InlineResult {
  /** 成功替换为内联 style 的顶层 stylesheet 数。 */
  inlined: number;
  /** 实际内联的 CSS 总字节数（UTF-8）。 */
  bytes: number;
  /** 所有顶层 stylesheet 是否都已完整快照。 */
  complete: boolean;
  /** 失败、超限或未能展开的顶层 stylesheet 数。 */
  failed: number;
}

/**
 * 对克隆出的 documentElement 执行样式快照；不修改用户正在浏览的真实 DOM。
 */
export async function inlineStylesheetsInClone(
  clone: HTMLElement,
  opts: InlineStylesheetsOptions = {},
): Promise<InlineResult> {
  const maxSheets = Math.max(1, Math.floor(opts.maxSheets ?? DEFAULT_MAX_SHEETS));
  // 多读一项，才能区分“正好达到上限”和“还有 stylesheet 没处理”。
  const discoveredLinks = collectStylesheetLinks(clone, maxSheets + 1);
  if (discoveredLinks.length === 0) {
    return { inlined: 0, bytes: 0, complete: true, failed: 0 };
  }

  const hasTooManySheets = discoveredLinks.length > maxSheets;
  const links = discoveredLinks.slice(0, maxSheets);
  const maxBytesPerSheet = opts.maxBytesPerSheet ?? DEFAULT_MAX_BYTES_PER_SHEET;
  const maxBytesTotal = opts.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
  const onError = opts.onError ?? ((url, reason) => logger.warn('[InlineCss] ' + url + ': ' + reason));
  const state: FetchState = {
    requestCount: 0,
    maxRequests: opts.maxRequests ?? DEFAULT_MAX_REQUESTS,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxBytesPerSheet,
    maxImportDepth: opts.maxImportDepth ?? DEFAULT_MAX_IMPORT_DEPTH,
    fetchFn: opts.fetchFn ?? fetch.bind(globalThis),
    onError,
    cache: new Map<string, CssResult>(),
  };

  if (hasTooManySheets) {
    onError(clone.baseURI || opts.baseUri || '', 'stylesheet count exceeds configured limit (' + maxSheets + ')');
  }

  const baseUri = opts.baseUri ?? clone.ownerDocument?.baseURI ?? document.baseURI;

  // 请求可以并行；替换操作仍按 DOM 原顺序执行，以保留 CSS cascade 顺序。
  const fetched = await Promise.all(
    links.map(async (link) => {
      const absoluteUrl = resolveHttpUrl(link.href, baseUri);
      if (!absoluteUrl) {
        onError(link.href, 'invalid stylesheet URL');
        return { link, url: link.href, css: '', complete: false };
      }
      const result = await fetchCssBundle(absoluteUrl, state, 0, new Set<string>());
      return { link, url: absoluteUrl, css: result.css, complete: result.complete && result.css.length > 0 };
    }),
  );

  let totalBytes = 0;
  let inlined = 0;
  let failed = hasTooManySheets ? discoveredLinks.length - maxSheets : 0;

  for (const item of fetched) {
    if (!item.complete) {
      failed++;
      continue;
    }

    const bytes = utf8ByteLength(item.css);
    if (totalBytes + bytes > maxBytesTotal) {
      onError(item.url, 'total CSS budget exceeded (' + maxBytesTotal + ' bytes)');
      failed++;
      continue;
    }

    totalBytes += bytes;
    replaceLinkWithStyle(clone, item.link, item.url, item.css);
    inlined++;
  }

  const complete = failed === 0 && inlined === links.length;
  clone.setAttribute(SNAPSHOT_ATTRIBUTE, complete ? 'v2-complete' : 'v2-partial');

  if (!complete) {
    logger.warn(
      '[InlineCss] CSS snapshot is partial: inlined=' + inlined +
      ', failed=' + failed + ', links=' + discoveredLinks.length +
      '. Remaining links are preserved for the server-side Reader fallback.',
    );
  }

  return { inlined, bytes: totalBytes, complete, failed };
}

/** 收集顶层 stylesheet；跳过 noscript、空 href 和非网络协议。 */
function collectStylesheetLinks(root: HTMLElement, maxLinks: number): SheetLink[] {
  const out: SheetLink[] = [];
  for (const el of Array.from(root.querySelectorAll('link'))) {
    if (el.closest('noscript')) continue;
    const rel = (el.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    if (!rel.includes('stylesheet')) continue;
    const href = (el.getAttribute('href') || '').trim();
    if (!href || /^(?:data|blob|javascript):/i.test(href)) continue;
    if (out.length >= maxLinks) break;
    out.push({
      el: el as HTMLLinkElement,
      href,
      media: (el.getAttribute('media') || '').trim(),
    });
  }
  return out;
}

function resolveHttpUrl(value: string, baseUrl: string): string | null {
  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * 获取 CSS 并展开其 @import。ancestors 用来识别递归环；完整 URL 缓存用于复用
 * 已完成的 imports，避免多个顶层 stylesheet 重复下载同一依赖。
 */
async function fetchCssBundle(
  url: string,
  state: FetchState,
  depth: number,
  ancestors: Set<string>,
): Promise<CssResult> {
  const absoluteUrl = resolveHttpUrl(url, url);
  if (!absoluteUrl) return { css: '', complete: false };
  if (ancestors.has(absoluteUrl)) return { css: '', complete: true };

  const cached = state.cache.get(absoluteUrl);
  if (cached) return cached;

  if (depth > state.maxImportDepth) {
    state.onError(absoluteUrl, '@import depth exceeds ' + state.maxImportDepth);
    return { css: '', complete: false };
  }
  if (state.requestCount >= state.maxRequests) {
    state.onError(absoluteUrl, 'CSS request count exceeds request limit (' + state.maxRequests + ')');
    return { css: '', complete: false };
  }
  state.requestCount++;

  const nextAncestors = new Set(ancestors);
  nextAncestors.add(absoluteUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), state.timeoutMs);

  try {
    // 浏览器 Fetch 自动跟随重定向；response.url 是重定向后的最终地址，
    // 必须用它解析 CSS 内部相对资源和 @import。
    const response = await state.fetchFn(absoluteUrl, { signal: controller.signal });
    if (!response.ok) {
      state.onError(absoluteUrl, 'HTTP ' + response.status);
      return { css: '', complete: false };
    }
    const sourceCss = await response.text();
    if (!sourceCss.trim()) {
      state.onError(absoluteUrl, 'empty body (for example HTTP 204)');
      return { css: '', complete: false };
    }
    if (sourceCss.trimStart().startsWith('<')) {
      state.onError(absoluteUrl, 'response looks like HTML, not CSS');
      return { css: '', complete: false };
    }
    if (utf8ByteLength(sourceCss) > state.maxBytesPerSheet) {
      state.onError(absoluteUrl, 'stylesheet exceeds per-file byte limit (' + state.maxBytesPerSheet + ')');
      return { css: '', complete: false };
    }

    const finalUrl = response.url || absoluteUrl;
    const expanded = await expandCssImports(
      sourceCss,
      finalUrl,
      state,
      depth,
      nextAncestors,
    );
    const cleaned = expanded.css.replace(/^\s*@charset\s+(['"]).*?\1\s*;\s*/i, '');
    const result = {
      css: rewriteCssUrls(cleaned, finalUrl),
      complete: expanded.complete,
    };
    if (utf8ByteLength(result.css) > state.maxBytesPerSheet) {
      state.onError(
        absoluteUrl,
        'expanded stylesheet exceeds per-file byte limit (' + state.maxBytesPerSheet + ')',
      );
      return { css: '', complete: false };
    }

    if (result.complete) state.cache.set(absoluteUrl, result);
    return result;
  } catch (error) {
    state.onError(absoluteUrl, error instanceof Error ? error.message : String(error));
    return { css: '', complete: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 展开普通 @import 并保留 media 条件。对于 layer()/supports() 等复杂 import 条件，
 * 不猜测其级联语义；标记为不完整并保留原始 link，由服务端统一降级。
 */
async function expandCssImports(
  sourceCss: string,
  sourceUrl: string,
  state: FetchState,
  depth: number,
  ancestors: Set<string>,
): Promise<CssResult> {
  const importRe =
    /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')\s*([^;]*);/gi;
  let cursor = 0;
  let output = '';
  let complete = true;
  let match: RegExpExecArray | null;

  while ((match = importRe.exec(sourceCss)) !== null) {
    output += sourceCss.slice(cursor, match.index);
    cursor = importRe.lastIndex;

    const href = (match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5] ?? '').trim();
    const condition = (match[6] || '').trim();
    if (/\b(?:layer|supports)\s*\(/i.test(condition)) {
      state.onError(sourceUrl, 'unsupported @import condition: ' + condition);
      complete = false;
      continue;
    }

    const importUrl = resolveHttpUrl(href, sourceUrl);
    if (!importUrl) {
      state.onError(sourceUrl, 'could not resolve @import URL: ' + href);
      complete = false;
      continue;
    }

    const imported = await fetchCssBundle(importUrl, state, depth + 1, ancestors);
    if (!imported.complete) {
      complete = false;
      continue;
    }
    if (!imported.css) continue;

    if (condition && condition.toLowerCase() !== 'all') {
      output += '@media ' + condition + '{\n' + imported.css + '\n}\n';
    } else {
      output += imported.css + '\n';
    }
  }

  output += sourceCss.slice(cursor);
  return { css: output, complete };
}

/**
 * CSS 中相对 url() 的基准是 stylesheet 自己的 URL，而不是 HTML 的 <base>。
 * 保留 http(s)、协议相对、data/blob、片段和 CSS var()。
 */
function rewriteCssUrls(css: string, stylesheetUrl: string): string {
  return css.replace(
    /url\(\s*(?:(["'])(.*?)\1|([^)]*?))\s*\)/gi,
    (whole, quote: string | undefined, quoted: string | undefined, bare: string | undefined) => {
      const value = ((quote ? quoted : bare) ?? '').trim();
      if (!value || /^(?:data:|blob:|https?:|\/\/|#|var\()/i.test(value)) {
        return whole;
      }

      const absoluteUrl = resolveHttpUrl(value, stylesheetUrl);
      if (!absoluteUrl) return whole;
      const escapedUrl = absoluteUrl
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/[\r\n]/g, '');
      return 'url("' + escapedUrl + '")';
    },
  );
}

/**
 * 用 style 替换 link，保留 media 语义和原 CSS URL（后续快照升级还需要用它作基准）。
 */
function replaceLinkWithStyle(
  root: HTMLElement,
  link: SheetLink,
  absoluteUrl: string,
  css: string,
): void {
  const doc = root.ownerDocument;
  if (!doc) return;
  const style = doc.createElement('style');
  style.setAttribute('data-fanyi-inlined-css', absoluteUrl);
  const body = css.replace(/<\/style/gi, '<\\/style');
  style.textContent = needsMediaWrap(link.media) ? '@media ' + link.media + '{' + body + '}' : body;
  link.el.replaceWith(style);
}

function needsMediaWrap(media: string): boolean {
  const normalized = media.trim().toLowerCase();
  return normalized !== '' && normalized !== 'all' && normalized !== 'screen';
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
