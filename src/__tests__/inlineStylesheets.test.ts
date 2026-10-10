import { describe, it, expect, vi } from 'vitest';
import { inlineStylesheetsInClone } from '../entrypoints/content/inlineStylesheets';

/**
 * 回归背景（snowflake.com /article/864）：
 * 缓存页的 <link rel=stylesheet> 热链到原站，防爬站点对无第一方 cookie 的
 * 请求返回 204 空内容 → 整页 CSS 为空 → SVG 无约束撑满全屏。
 * 修复：扩展端在发送 HTML 前于浏览器上下文抓取 CSS 内联进 <style>。
 */

function makeRoot(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function cssResponse(css: string, ok = true, status = ok ? 200 : 500) {
  return { ok, status, text: async () => css };
}

const BASE = 'https://www.example.com/blog/post/';

describe('inlineStylesheetsInClone', () => {
  it('把同源样式表替换为内联 <style>，并记录来源 URL', async () => {
    const root = makeRoot('<link rel="stylesheet" href="/assets/app.css"><p>x</p>');
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('body{color:red}'));

    const { inlined, bytes } = await inlineStylesheetsInClone(root, {
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUri: BASE,
      onError: vi.fn(),
    });

    expect(inlined).toBe(1);
    expect(bytes).toBe('body{color:red}'.length);
    expect(fetchFn).toHaveBeenCalledWith('https://www.example.com/assets/app.css', expect.anything());
    const style = root.querySelector('style');
    expect(style?.textContent).toBe('body{color:red}');
    expect(style?.getAttribute('data-fanyi-inlined-css')).toBe('https://www.example.com/assets/app.css');
    expect(root.querySelector('link')).toBeNull();
    root.remove();
  });

  it('相对 href 按给定 baseUri 解析', async () => {
    const root = makeRoot('<link rel="stylesheet" href="../css/a.css">');
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('a{}'));
    await inlineStylesheetsInClone(root, { fetchFn: fetchFn as unknown as typeof fetch, baseUri: BASE, onError: vi.fn() });
    expect(fetchFn).toHaveBeenCalledWith('https://www.example.com/blog/css/a.css', expect.anything());
    root.remove();
  });

  it('转义 CSS 里的 </style，防止提前闭合标签', async () => {
    const root = makeRoot('<link rel="stylesheet" href="/x.css">');
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('a::after{content:"</style><script>alert(1)</script>"}'));
    await inlineStylesheetsInClone(root, { fetchFn: fetchFn as unknown as typeof fetch, baseUri: BASE, onError: vi.fn() });
    const css = root.querySelector('style')?.textContent ?? '';
    expect(css).not.toContain('</style');
    expect(css).toContain('<\\/style');
    root.remove();
  });

  it('media="print" 的条件样式表内联后包 @media 保留语义', async () => {
    const root = makeRoot('<link rel="stylesheet" href="/print.css" media="print">');
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('.p{}'));
    await inlineStylesheetsInClone(root, { fetchFn: fetchFn as unknown as typeof fetch, baseUri: BASE, onError: vi.fn() });
    expect(root.querySelector('style')?.textContent).toBe('@media print{.p{}}');
    root.remove();
  });

  it('HTTP 403 / 204 空响应 / HTML 错误页都跳过并保留原 <link>', async () => {
    const root = makeRoot(
      '<link rel="stylesheet" href="/a.css">' +
        '<link rel="stylesheet" href="/b.css">' +
        '<link rel="stylesheet" href="/c.css">',
    );
    const fetchFn = vi
      .fn()
      .mockResolvedValueOnce(cssResponse('denied', false, 403)) // 403 → 不 ok
      .mockResolvedValueOnce(cssResponse('')) // 空响应（防爬站点 204 的等价形态）
      .mockResolvedValueOnce(cssResponse('<html>challenge page</html>')); // HTML 错误页
    const onError = vi.fn();

    const { inlined } = await inlineStylesheetsInClone(root, {
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUri: BASE,
      onError,
    });

    expect(inlined).toBe(0);
    expect(root.querySelectorAll('link[rel=stylesheet]')).toHaveLength(3);
    expect(onError).toHaveBeenCalledTimes(3);
    root.remove();
  });

  it('单个样式表超大小上限时跳过', async () => {
    const root = makeRoot('<link rel="stylesheet" href="/big.css">');
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('x'.repeat(100)));
    const onError = vi.fn();
    const { inlined } = await inlineStylesheetsInClone(root, {
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUri: BASE,
      maxBytesPerSheet: 50,
      onError,
    });
    expect(inlined).toBe(0);
    expect(onError).toHaveBeenCalledWith('https://www.example.com/big.css', expect.stringContaining('too large'));
    root.remove();
  });

  it('总字节预算耗尽后停止内联后续样式表', async () => {
    const root = makeRoot('<link rel="stylesheet" href="/a.css"><link rel="stylesheet" href="/b.css">');
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('x'.repeat(60)));
    const onError = vi.fn();
    const { inlined, bytes } = await inlineStylesheetsInClone(root, {
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUri: BASE,
      maxBytesTotal: 100,
      onError,
    });
    expect(inlined).toBe(1);
    expect(bytes).toBe(60);
    expect(root.querySelector('style')).not.toBeNull();
    expect(root.querySelector('link')).not.toBeNull(); // b.css 预算不足，保留外链
    expect(onError).toHaveBeenCalledWith('https://www.example.com/b.css', expect.stringContaining('budget'));
    root.remove();
  });

  it('maxSheets 限制内联数量，超出的保留外链', async () => {
    const root = makeRoot(
      '<link rel="stylesheet" href="/1.css"><link rel="stylesheet" href="/2.css"><link rel="stylesheet" href="/3.css">',
    );
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('a{}'));
    const { inlined } = await inlineStylesheetsInClone(root, {
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUri: BASE,
      maxSheets: 2,
      onError: vi.fn(),
    });
    expect(inlined).toBe(2);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    root.remove();
  });

  it('跳过 noscript 内、data:/blob: 协议的样式表', async () => {
    const root = makeRoot(
      '<noscript><link rel="stylesheet" href="/nojs.css"></noscript>' +
        '<link rel="stylesheet" href="data:text/css,body{}">' +
        '<link rel="stylesheet" href="/real.css">',
    );
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('a{}'));
    await inlineStylesheetsInClone(root, { fetchFn: fetchFn as unknown as typeof fetch, baseUri: BASE, onError: vi.fn() });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(fetchFn).toHaveBeenCalledWith('https://www.example.com/real.css', expect.anything());
    root.remove();
  });

  it('网络错误（fetch reject / abort）跳过且不让整体失败', async () => {
    const root = makeRoot('<link rel="stylesheet" href="/down.css"><link rel="stylesheet" href="/ok.css">');
    const fetchFn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(cssResponse('a{}'));
    const onError = vi.fn();
    const { inlined } = await inlineStylesheetsInClone(root, {
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUri: BASE,
      onError,
    });
    expect(inlined).toBe(1);
    expect(onError).toHaveBeenCalledWith('https://www.example.com/down.css', 'Failed to fetch');
    root.remove();
  });

  it('递归内联常规 @import，并按原 stylesheet 路径改写字体与背景图 URL', async () => {
    const root = makeRoot('<link rel="stylesheet" href="/styles/main.css"><p>x</p>');
    const fetchFn = vi.fn(async (url: RequestInfo | URL) => {
      const value = String(url);
      if (value === 'https://www.example.com/styles/main.css') {
        return {
          ok: true,
          status: 200,
          url: value,
          text: async () => '@import "./theme.css" screen; .hero{background-image:url("../images/hero.png")}',
        };
      }
      if (value === 'https://www.example.com/styles/theme.css') {
        return {
          ok: true,
          status: 200,
          url: value,
          text: async () => '@font-face{src:url("../fonts/site.woff2")}',
        };
      }
      throw new Error('unexpected CSS URL: ' + value);
    });

    const result = await inlineStylesheetsInClone(root, {
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUri: BASE,
      onError: vi.fn(),
    });
    const css = root.querySelector('style')?.textContent ?? '';
    expect(result.complete).toBe(true);
    expect(result.inlined).toBe(1);
    expect(css).not.toContain('@import');
    expect(css).toContain('https://www.example.com/images/hero.png');
    expect(css).toContain('https://www.example.com/fonts/site.woff2');
    expect(root.getAttribute('data-fanyi-css-snapshot')).toBe('v2-complete');
    root.remove();
  });

  it('stylesheet 超过 maxSheets 时明确标记 partial，而不是静默视为完整', async () => {
    const root = makeRoot(
      '<link rel="stylesheet" href="/1.css"><link rel="stylesheet" href="/2.css"><link rel="stylesheet" href="/3.css">',
    );
    const fetchFn = vi.fn().mockResolvedValue(cssResponse('a{}'));
    const result = await inlineStylesheetsInClone(root, {
      fetchFn: fetchFn as unknown as typeof fetch,
      baseUri: BASE,
      maxSheets: 2,
      onError: vi.fn(),
    });
    expect(result.inlined).toBe(2);
    expect(result.complete).toBe(false);
    expect(root.querySelectorAll('link[rel=stylesheet]')).toHaveLength(1);
    expect(root.getAttribute('data-fanyi-css-snapshot')).toBe('v2-partial');
    root.remove();
  });

  it('没有样式表时直接返回，不发起任何请求', async () => {
    const root = makeRoot('<p>plain</p>');
    const fetchFn = vi.fn();
    const { inlined } = await inlineStylesheetsInClone(root, { fetchFn: fetchFn as unknown as typeof fetch, onError: vi.fn() });
    expect(inlined).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
    root.remove();
  });
});
