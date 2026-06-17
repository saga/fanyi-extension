import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { translateViaServer } from '../entrypoints/content/serverTranslation';
import type { Config } from '../entrypoints/utils/config';
import type { TextBlock } from '../entrypoints/utils/blockExtractor';

// Mock translationDisplay to avoid actual DOM manipulation side effects
vi.mock('../entrypoints/utils/translationDisplay', () => ({
  applyBlockTranslation: vi.fn(),
}));

import { applyBlockTranslation } from '../entrypoints/utils/translationDisplay';

const baseConfig: Config = {
  sourceLang: 'en',
  targetLang: 'zh',
  deepseekApiKey: 'sk-test-api-key',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  useServerTranslation: true,
  serverUrl: 'https://s.sunxiunan.com/fanyi/page',
};

describe('translateViaServer', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();

    // Provide a minimal document so document.documentElement.outerHTML works
    document.documentElement.innerHTML = `
      <html><body>
        <article>
          <h1 data-fanyi-block-id="b1">Hello World</h1>
          <p data-fanyi-block-id="b2">This is a test paragraph.</p>
        </article>
      </body></html>
    `;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends HTML to /fanyi/page and applies bilingual translations', async () => {
    const translatedHtml = `
      <html><body>
        <article>
          <h1 data-fanyi-block-id="b1" class="fanyi-translated">
            <span class="fanyi-original">Hello World</span>
            <span class="fanyi-translation">你好世界</span>
          </h1>
          <p data-fanyi-block-id="b2" class="fanyi-translated">
            <span class="fanyi-original">This is a test paragraph.</span>
            <span class="fanyi-translation">这是一个测试段落。</span>
          </p>
        </article>
      </body></html>
    `;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => translatedHtml,
    });

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/article/h1', tag: 'h1', text: 'Hello World' },
      { id: 'b2', xpath: '/html/body/article/p', tag: 'p', text: 'This is a test paragraph.' },
    ];

    const nodeMap = new Map<string, Node>([
      ['b1', document.querySelector('h1')!],
      ['b2', document.querySelector('p')!],
    ]);

    const result = await translateViaServer(baseConfig, blocks, nodeMap);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(baseConfig.serverUrl);
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' });
    const body = JSON.parse(options.body);
    expect(body.html).toContain('data-fanyi-block-id="b1"');
    expect(body.url).toBe(window.location.href);
    expect(body.apiKey).toBe('sk-test-api-key');
    expect(body.source).toBe('en');
    expect(body.target).toBe('zh');
    expect(body.mode).toBe('bilingual');
    expect(body.service).toBe('deepseek');

    expect(result.size).toBe(2);
    expect(result.has('b1')).toBe(true);
    expect(result.has('b2')).toBe(true);
    expect(applyBlockTranslation).toHaveBeenCalledWith(nodeMap.get('b1'), '你好世界');
    expect(applyBlockTranslation).toHaveBeenCalledWith(nodeMap.get('b2'), '这是一个测试段落。');
  });

  it('cleans up extension UI before sending HTML', async () => {
    document.body.innerHTML += `
      <div class="fanyi-status-overlay fanyi-loading">正在发送到服务端翻译...</div>
      <div class="fanyi-floating-btn">译</div>
      <div class="fanyi-config-panel">config panel</div>
      <div class="selection-translator">selection translator</div>
    `;

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html><body></body></html>',
    });

    const blocks: TextBlock[] = [];
    const nodeMap = new Map<string, Node>();

    await translateViaServer(baseConfig, blocks, nodeMap);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.html).not.toContain('fanyi-status-overlay');
    expect(body.html).not.toContain('fanyi-floating-btn');
    expect(body.html).not.toContain('fanyi-config-panel');
    expect(body.html).not.toContain('selection-translator');
  });

  it('strips existing bilingual translation markup before sending HTML', async () => {
    document.documentElement.innerHTML = `
      <html><body>
        <article>
          <h1 data-fanyi-block-id="b1" class="fanyi-translated" data-original-text="Hello World">
            <span class="fanyi-original">Hello World</span>
            <span class="fanyi-translation">你好世界</span>
          </h1>
        </article>
      </body></html>
    `;

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html><body></body></html>',
    });

    const blocks: TextBlock[] = [];
    const nodeMap = new Map<string, Node>();

    await translateViaServer(baseConfig, blocks, nodeMap);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.html).toContain('data-fanyi-block-id="b1"');
    expect(body.html).toContain('Hello World');
    expect(body.html).not.toContain('fanyi-translation');
    expect(body.html).not.toContain('fanyi-original');
    expect(body.html).not.toContain('fanyi-translated');
    expect(body.html).not.toContain('data-original-text');
  });

  it('skips blocks whose translation span is missing', async () => {
    const translatedHtml = `
      <html><body>
        <article>
          <h1 data-fanyi-block-id="b1" class="fanyi-translated">
            <span class="fanyi-original">Hello World</span>
            <span class="fanyi-translation">你好世界</span>
          </h1>
          <p data-fanyi-block-id="b2">
            <span class="fanyi-original">This is a test paragraph.</span>
          </p>
        </article>
      </body></html>
    `;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => translatedHtml,
    });

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/article/h1', tag: 'h1', text: 'Hello World' },
      { id: 'b2', xpath: '/html/body/article/p', tag: 'p', text: 'This is a test paragraph.' },
    ];

    const nodeMap = new Map<string, Node>([
      ['b1', document.querySelector('h1')!],
      ['b2', document.querySelector('p')!],
    ]);

    const result = await translateViaServer(baseConfig, blocks, nodeMap);

    expect(result.size).toBe(1);
    expect(result.has('b1')).toBe(true);
    expect(applyBlockTranslation).toHaveBeenCalledTimes(1);
  });

  it('skips blocks whose translation equals original text', async () => {
    const translatedHtml = `
      <html><body>
        <article>
          <h1 data-fanyi-block-id="b1" class="fanyi-translated">
            <span class="fanyi-original">Hello World</span>
            <span class="fanyi-translation">Hello World</span>
          </h1>
        </article>
      </body></html>
    `;
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => translatedHtml,
    });

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/article/h1', tag: 'h1', text: 'Hello World' },
    ];

    const nodeMap = new Map<string, Node>([
      ['b1', document.querySelector('h1')!],
    ]);

    const result = await translateViaServer(baseConfig, blocks, nodeMap);

    expect(result.size).toBe(0);
    expect(applyBlockTranslation).not.toHaveBeenCalled();
  });

  it('throws when apiKey is missing', async () => {
    const config = { ...baseConfig, deepseekApiKey: '' };
    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/article/h1', tag: 'h1', text: 'Hello World' },
    ];
    const nodeMap = new Map<string, Node>([['b1', document.querySelector('h1')!]]);

    await expect(translateViaServer(config, blocks, nodeMap)).rejects.toThrow(
      'DeepSeek API Key 未配置',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws when server responds with non-OK status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'error',
    });

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/article/h1', tag: 'h1', text: 'Hello World' },
    ];

    const nodeMap = new Map<string, Node>([['b1', document.querySelector('h1')!]]);

    await expect(translateViaServer(baseConfig, blocks, nodeMap)).rejects.toThrow(
      '服务端翻译失败: 500 Internal Server Error',
    );
  });

  it('falls back to default server URL when config.serverUrl is empty', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => `
        <html><body>
          <h1 data-fanyi-block-id="b1" class="fanyi-translated">
            <span class="fanyi-original">Hello World</span>
            <span class="fanyi-translation">你好世界</span>
          </h1>
        </body></html>
      `,
    });

    const config = { ...baseConfig, serverUrl: '' };
    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/article/h1', tag: 'h1', text: 'Hello World' },
    ];
    const nodeMap = new Map<string, Node>([['b1', document.querySelector('h1')!]]);

    await translateViaServer(config, blocks, nodeMap);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('https://s.sunxiunan.com/fanyi/page');
  });
});
