import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkServerCache,
  applyServerTranslatedHtml,
  computeBlocksFingerprint,
} from '../entrypoints/content/serverTranslation';
import { extractBlocks, buildNodeMap } from '../entrypoints/utils/blockExtractor';
import type { Config } from '../entrypoints/utils/config';
import type { TextBlock } from '../entrypoints/utils/blockExtractor';

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

/** 用 blocks 构造服务端返回的双语 HTML（译文用 «原文» 标记，便于断言配对）。 */
function buildBilingualHtml(blocks: TextBlock[]): string {
  const body = blocks
    .map(
      (b) =>
        `<${b.tag} data-fanyi-block-id="${b.id}" class="fanyi-translated">` +
        `<span class="fanyi-original">${b.text}</span>` +
        `<span class="fanyi-translation">«${b.text}»</span>` +
        `</${b.tag}>`,
    )
    .join('');
  return `<html><body><article>${body}</article></body></html>`;
}

function loadPage(html: string) {
  document.documentElement.innerHTML = html;
  const blocks = extractBlocks(document);
  const nodeMap = buildNodeMap(blocks, document);
  return { blocks, nodeMap };
}

// ─────────────────────────────────────────────────────────────────────────────
// 复现：缓存/响应里的 id→元素映射与当前抽取不一致时，译文会被贴到错误的块上
// （a16z.news 故障：b14 标题拿到了 b24 段落的译文）
// ─────────────────────────────────────────────────────────────────────────────
describe('applyServerTranslatedHtml - stale block-id mapping must not be applied', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips blocks whose server-side original text does not match the block text', () => {
    // 页面 A：生成缓存时的状态
    document.documentElement.innerHTML = `
      <html><body><article>
        <h1>Alpha title</h1>
        <p>Alpha paragraph one.</p>
        <p>Alpha paragraph two.</p>
      </article></body></html>`;
    const blocksA = extractBlocks(document);
    expect(blocksA.map((b) => b.id)).toEqual(['b1', 'b2', 'b3']);
    const cachedHtml = buildBilingualHtml(blocksA);

    // 页面 B：现在多了一个块 → 后续 id 整体位移（id→元素映射已变）
    const { blocks, nodeMap } = loadPage(`
      <html><body><article>
        <p>Beta intro paragraph.</p>
        <h1>Alpha title</h1>
        <p>Alpha paragraph one.</p>
        <p>Alpha paragraph two.</p>
      </article></body></html>`);
    expect(blocks.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'b4']);

    const result = applyServerTranslatedHtml(cachedHtml, blocks, nodeMap);

    // 三个块的 id 都位移了 → 一个都不该被应用（宁可不翻译，也不能贴错）
    expect(result.mismatched).toBe(3);
    expect(result.translatedIds.size).toBe(0);
    expect(applyBlockTranslation).not.toHaveBeenCalled();
  });

  it('still applies when the server original merely has extra chrome around the block text', () => {
    // HN .titleline 场景：客户端 block 文本剔除了 .comhead，服务端原文包含它
    document.documentElement.innerHTML = `
      <html><body><article><h1>Alpha title</h1></article></body></html>`;
    const blocks = extractBlocks(document);
    const nodeMap = buildNodeMap(blocks, document);

    const cachedHtml = `
      <html><body><article>
        <h1 data-fanyi-block-id="b1" class="fanyi-translated">
          <span class="fanyi-original">Alpha title (example.com)</span>
          <span class="fanyi-translation">«Alpha title»</span>
        </h1>
      </article></body></html>`;

    const result = applyServerTranslatedHtml(cachedHtml, blocks, nodeMap);

    expect(result.mismatched).toBe(0);
    expect(result.translatedIds.size).toBe(1);
    expect(applyBlockTranslation).toHaveBeenCalledWith(nodeMap.get('b1'), '«Alpha title»');
  });

  it('still applies when the client text carries a leading zero-width char (Mintlify anchors)', () => {
    document.documentElement.innerHTML = `
      <html><body><article><h2>Interrupt decision types</h2></article></body></html>`;
    const blocks = extractBlocks(document);
    const nodeMap = buildNodeMap(blocks, document);

    const cachedHtml = `
      <html><body><article>
        <h2 data-fanyi-block-id="b1" class="fanyi-translated">
          <span class="fanyi-original">\u200bInterrupt decision types</span>
          <span class="fanyi-translation">«中断决策类型»</span>
        </h2>
      </article></body></html>`;

    const result = applyServerTranslatedHtml(cachedHtml, blocks, nodeMap);

    expect(result.mismatched).toBe(0);
    expect(result.translatedIds.size).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 指纹：块集合的 id→tag 序列变化必须让缓存失效（否则会错位）
// ─────────────────────────────────────────────────────────────────────────────
describe('computeBlocksFingerprint', () => {
  it('changes when a block is inserted (id mapping shifts)', () => {
    document.documentElement.innerHTML = `
      <html><body><article>
        <h1>Alpha title</h1><p>Alpha paragraph one.</p>
      </article></body></html>`;
    const before = computeBlocksFingerprint(extractBlocks(document));

    document.documentElement.innerHTML = `
      <html><body><article>
        <p>Beta intro.</p><h1>Alpha title</h1><p>Alpha paragraph one.</p>
      </article></body></html>`;
    const after = computeBlocksFingerprint(extractBlocks(document));

    expect(after).not.toBe(before);
  });

  it('is stable when only a block text changes in place (mapping still valid)', () => {
    document.documentElement.innerHTML = `
      <html><body><article>
        <h1>Alpha title</h1><p>142 likes</p>
      </article></body></html>`;
    const before = computeBlocksFingerprint(extractBlocks(document));

    document.documentElement.innerHTML = `
      <html><body><article>
        <h1>Alpha title</h1><p>184 likes</p>
      </article></body></html>`;
    const after = computeBlocksFingerprint(extractBlocks(document));

    expect(after).toBe(before);
  });

  it('is deterministic for the same input', () => {
    document.documentElement.innerHTML = `
      <html><body><article><h1>Alpha title</h1></article></body></html>`;
    const blocks = extractBlocks(document);
    expect(computeBlocksFingerprint(blocks)).toBe(computeBlocksFingerprint(blocks));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// checkServerCache：必须带上 contentHash，并把 410（内容已变）当成未命中
// ─────────────────────────────────────────────────────────────────────────────
describe('checkServerCache - contentHash plumbing', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends the blocks fingerprint as contentHash', async () => {
    document.documentElement.innerHTML = `
      <html><body><article><h1>Alpha title</h1></article></body></html>`;
    const blocks = extractBlocks(document);
    const fingerprint = computeBlocksFingerprint(blocks);

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 204,
      text: async () => '',
    });

    await checkServerCache(baseConfig, blocks);

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain(`contentHash=${encodeURIComponent(fingerprint)}`);
  });

  it('treats HTTP 410 (content changed) as a cache miss instead of throwing', async () => {
    document.documentElement.innerHTML = `
      <html><body><article><h1>Alpha title</h1></article></body></html>`;
    const blocks = extractBlocks(document);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 410,
      statusText: 'Gone',
    });

    await expect(checkServerCache(baseConfig, blocks)).resolves.toBeNull();
  });

  it('still returns cached HTML on 200', async () => {
    document.documentElement.innerHTML = `
      <html><body><article><h1>Alpha title</h1></article></body></html>`;
    const blocks = extractBlocks(document);
    const cachedHtml = '<html><body>cached</body></html>';

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => cachedHtml,
    });

    await expect(checkServerCache(baseConfig, blocks)).resolves.toBe(cachedHtml);
  });
});
