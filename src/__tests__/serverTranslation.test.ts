import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  translateViaServer,
  checkServerCache,
  applyServerTranslatedHtml,
} from '../entrypoints/content/serverTranslation';
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
  provider: 'deepseek',
  promptStyle: 'default',
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
    expect(options.headers['Content-Type']).toBe('application/json');
    // 单次翻译会话标识随请求发出，用于服务端关联 check→page→报错 日志
    expect(typeof options.headers['X-Session-Id']).toBe('string');
    expect(options.headers['X-Session-Id'].length).toBeGreaterThan(0);
    const body = JSON.parse(options.body);
    expect(body.sessionId).toBe(options.headers['X-Session-Id']);
    expect(body.html).toContain('data-fanyi-block-id="b1"');
    expect(body.url).toBe(window.location.href);
    expect(body.apiKey).toBe('sk-test-api-key');
    expect(body.source).toBe('en');
    expect(body.target).toBe('zh');
    expect(body.mode).toBe('bilingual');
    expect(body.provider).toBe('deepseek');
    // promptStyle 端到端传递：config.promptStyle 应原样写入请求 body
    expect(body.promptStyle).toBe('default');
    // 结构指纹随 POST 发出：服务端把它存进 content_hash，下次 check 时用它判断
    // 缓存里的 block id 映射是否仍与当前页面一致（不一致就 410 重译，避免译文错位）。
    expect(body.contentHash).toContain('b1:h1');
    expect(body.contentHash).toContain('b2:p');

    expect(result.translatedIds.size).toBe(2);
    expect(result.translatedIds.has('b1')).toBe(true);
    expect(result.translatedIds.has('b2')).toBe(true);
    expect(result.mismatched).toBe(0);
    expect(applyBlockTranslation).toHaveBeenCalledWith(nodeMap.get('b1'), '你好世界');
    expect(applyBlockTranslation).toHaveBeenCalledWith(nodeMap.get('b2'), '这是一个测试段落。');
  });



  // 站点（如 sigarch.org 的 FeedBlitz 订阅表单）可能在运行时被 JS 把
  // form action 改成 http://，这会触发 Mixed Content 警告并污染发往服务端
  // 的 HTML。prepareHtmlForServer 应把 http:// 升级为 https://。


  it('removes oversized scripts before sending HTML while preserving the stylesheet head', async () => {
    const translatedHtml = '<html><body><p data-fanyi-block-id="b1">' +
      '<span class="fanyi-original">Hello World</span>' +
      '<span class="fanyi-translation">你好世界</span></p></body></html>';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => translatedHtml,
    });

    document.head.innerHTML = '<style id="source-css">body{color:red}</style>';
    document.body.innerHTML = '<article><p data-fanyi-block-id="b1">Hello World</p></article>';
    const oversizedScript = document.createElement('script');
    oversizedScript.type = 'application/json';
    oversizedScript.id = 'oversized-test-script';
    oversizedScript.textContent = 'oversized-payload-'.repeat(240_000);
    document.body.appendChild(oversizedScript);

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/article/p', tag: 'p', text: 'Hello World' },
    ];
    const nodeMap = new Map<string, Node>([['b1', document.querySelector('p')!]]);
    const result = await translateViaServer(baseConfig, blocks, nodeMap);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.html).toContain('<style id="source-css">body{color:red}</style>');
    expect(body.html).toContain('data-fanyi-block-id="b1"');
    expect(body.html).not.toContain('oversized-test-script');
    expect(document.querySelector('#oversized-test-script')).not.toBeNull();
    expect(result.translatedIds.has('b1')).toBe(true);
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

    expect(result.translatedIds.size).toBe(1);
    expect(result.translatedIds.has('b1')).toBe(true);
    expect(applyBlockTranslation).toHaveBeenCalledTimes(1);
  });



  it('does not require apiKey when provider is not deepseek', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '<html><body></body></html>',
    });

    const config: Config = { ...baseConfig, deepseekApiKey: '', provider: 'openrouter' };
    const blocks: TextBlock[] = [];
    const nodeMap = new Map<string, Node>();

    await translateViaServer(config, blocks, nodeMap);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    // provider 直接复用本地 provider 配置，服务端据此选择 LLM
    expect(body.provider).toBe('openrouter');
    expect(body.apiKey).toBeUndefined();
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

});

describe('checkServerCache', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns cached HTML when server responds 200', async () => {
    const cachedHtml = '<html><body>cached</body></html>';
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => cachedHtml,
    });

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/h1', tag: 'h1', text: 'Hello World' },
    ];
    const result = await checkServerCache(baseConfig, blocks);

    expect(result).toBe(cachedHtml);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/fanyi/page/check');
    expect(url).toContain(`url=${encodeURIComponent(window.location.href)}`);
    expect(url).toContain('source=en');
    expect(url).toContain('target=zh');
  });



  it('throws when server responds non-OK', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/h1', tag: 'h1', text: 'Hello World' },
    ];
    await expect(checkServerCache(baseConfig, blocks)).rejects.toThrow(
      '服务端缓存检查失败: 500 Internal Server Error',
    );
  });
});

describe('applyServerTranslatedHtml', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    document.documentElement.innerHTML = `
      <html><body>
        <article>
          <h1 data-fanyi-block-id="b1">Hello World</h1>
          <p data-fanyi-block-id="b2">This is a test paragraph.</p>
        </article>
      </body></html>
    `;
  });

  it('applies translations from server HTML to current DOM', () => {
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

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/article/h1', tag: 'h1', text: 'Hello World' },
      { id: 'b2', xpath: '/html/body/article/p', tag: 'p', text: 'This is a test paragraph.' },
    ];

    const nodeMap = new Map<string, Node>([
      ['b1', document.querySelector('h1')!],
      ['b2', document.querySelector('p')!],
    ]);

    const result = applyServerTranslatedHtml(translatedHtml, blocks, nodeMap);

    expect(result.translatedIds.size).toBe(2);
    expect(result.translatedIds.has('b1')).toBe(true);
    expect(result.translatedIds.has('b2')).toBe(true);
    expect(applyBlockTranslation).toHaveBeenCalledWith(nodeMap.get('b1'), '你好世界');
    expect(applyBlockTranslation).toHaveBeenCalledWith(nodeMap.get('b2'), '这是一个测试段落。');
  });


  it('strips <base> tag from server HTML to avoid CSP base-uri violation (regression: aws.amazon.com)', () => {
    // 服务端返回的 HTML 可能包含 <base href="...">，但某些站点 CSP 设置
    // base-uri 'none'，DOMParser 解析 <base> 会触发违例。应移除后再解析。
    const translatedHtml = `
      <html><head>
        <base href="https://aws.amazon.com/blogs/machine-learning/multi-agent-social-intelligence-with-strands-agents-and-amazon-bedrock/">
      </head><body>
        <h1 data-fanyi-block-id="b1" class="fanyi-translated">
          <span class="fanyi-original">Hello World</span>
          <span class="fanyi-translation">你好世界</span>
        </h1>
      </body></html>
    `;

    const blocks: TextBlock[] = [
      { id: 'b1', xpath: '/html/body/h1', tag: 'h1', text: 'Hello World' },
    ];

    const nodeMap = new Map<string, Node>([['b1', document.querySelector('h1')!]]);

    // jsdom 不会触发 CSP 违例，这里验证 <base> 被移除后仍能正常提取译文
    const result = applyServerTranslatedHtml(translatedHtml, blocks, nodeMap);

    expect(result.translatedIds.size).toBe(1);
    expect(result.translatedIds.has('b1')).toBe(true);
    expect(applyBlockTranslation).toHaveBeenCalledWith(nodeMap.get('b1'), '你好世界');
  });

});
