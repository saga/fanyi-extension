import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TranslationState } from '../entrypoints/content/translationTypes';

/**
 * PDF.js viewer 翻译模块单元测试。
 *
 * 测试覆盖：
 *   - isPdfJsViewer       DOM 特征检测
 *   - isPdfJsTranslated   翻译状态检测
 *   - collectLines        textLayer span → 行聚合
 *   - groupLinesIntoParagraphs  行 → 段落聚合（间距/缩进/句末标点）
 *   - restorePdfJsViewer  清理覆盖层
 *   - togglePdfJsViewer   显示/隐藏切换
 *   - translatePdfJsViewer  端到端（mock browser.runtime.sendMessage）
 */

// Mock webextension-polyfill —— 必须在 import 被测模块之前
const mockSendMessage = vi.fn();
vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      sendMessage: mockSendMessage,
    },
  },
}));

// =============================================================================
// 工具：构建带布局信息的 PDF.js DOM
// =============================================================================

/**
 * jsdom 默认 getBoundingClientRect 返回全 0，无法测试布局逻辑。
 * 这里 stub Element.prototype.getBoundingClientRect，根据元素的
 * data-mock-* 属性返回预设的矩形。
 *
 * 用法：在 span 上设置 data-mock-left/top/right/bottom/width/height，
 * 调用 installGetBoundingClientRectMock() 后访问 getBoundingClientRect()
 * 会返回这些值。没设置属性的元素返回全 0。
 */
function installGetBoundingClientRectMock(): () => void {
  const original = Element.prototype.getBoundingClientRect;
  Element.prototype.getBoundingClientRect = function (): DOMRect {
    const el = this as Element;
    const num = (name: string) => {
      const v = el.getAttribute(name);
      return v ? parseFloat(v) : 0;
    };
    const left = num('data-mock-left');
    const top = num('data-mock-top');
    const right = num('data-mock-right');
    const bottom = num('data-mock-bottom');
    const width = num('data-mock-width') || (right - left);
    const height = num('data-mock-height') || (bottom - top);
    return {
      left, top, right, bottom, width, height,
      x: left, y: top,
      toJSON: () => ({}),
    } as DOMRect;
  };
  return () => {
    Element.prototype.getBoundingClientRect = original;
  };
}

/**
 * 构建一个 textLayer span。
 * @param text     span 文本
 * @param layout   布局信息 { left, top, right, bottom, width?, height? }
 * @param extra    额外属性（如 fontSize）
 */
function makeSpan(
  text: string,
  layout: { left: number; top: number; right: number; bottom: number; width?: number; height?: number },
  extra?: { fontSize?: string },
): HTMLElement {
  const span = document.createElement('span');
  span.textContent = text;
  span.setAttribute('data-mock-left', String(layout.left));
  span.setAttribute('data-mock-top', String(layout.top));
  span.setAttribute('data-mock-right', String(layout.right));
  span.setAttribute('data-mock-bottom', String(layout.bottom));
  if (layout.width !== undefined) span.setAttribute('data-mock-width', String(layout.width));
  if (layout.height !== undefined) span.setAttribute('data-mock-height', String(layout.height));
  if (extra?.fontSize) span.style.fontSize = extra.fontSize;
  return span;
}

/**
 * 构建一个完整的 PDF.js page 结构：
 *   <div class="page" data-page-number="N">
 *     <div class="textLayer">
 *       ...spans
 *     </div>
 *   </div>
 */
function makePage(pageNumber: number, spans: HTMLElement[]): HTMLElement {
  const page = document.createElement('div');
  page.className = 'page';
  page.setAttribute('data-page-number', String(pageNumber));
  // 给 page 一个非零 rect，让 getBoundingClientRect 在 renderOverlay 中算出合理的 maxWidth
  page.setAttribute('data-mock-left', '0');
  page.setAttribute('data-mock-top', '0');
  page.setAttribute('data-mock-right', '800');
  page.setAttribute('data-mock-bottom', '1000');
  page.setAttribute('data-mock-width', '800');
  page.setAttribute('data-mock-height', '1000');

  const textLayer = document.createElement('div');
  textLayer.className = 'textLayer';
  textLayer.setAttribute('data-mock-left', '0');
  textLayer.setAttribute('data-mock-top', '0');
  textLayer.setAttribute('data-mock-right', '800');
  textLayer.setAttribute('data-mock-bottom', '1000');
  textLayer.setAttribute('data-mock-width', '800');
  textLayer.setAttribute('data-mock-height', '1000');

  for (const span of spans) textLayer.appendChild(span);
  page.appendChild(textLayer);
  return page;
}

/** 构建完整的 PDF.js viewer 骨架（#viewer.pdfViewer + #viewerContainer）。 */
function makePdfJsViewer(pages: HTMLElement[]): void {
  const viewerContainer = document.createElement('div');
  viewerContainer.id = 'viewerContainer';
  const viewer = document.createElement('div');
  viewer.id = 'viewer';
  viewer.classList.add('pdfViewer');
  for (const page of pages) viewer.appendChild(page);
  viewerContainer.appendChild(viewer);
  document.body.appendChild(viewerContainer);
}

// =============================================================================
// isPdfJsViewer
// =============================================================================

describe('isPdfJsViewer', () => {
  let mod: typeof import('../entrypoints/content/pdfjs');

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mod = await import('../entrypoints/content/pdfjs');
  });


  it('returns true when #viewer.pdfViewer exists', () => {
    const viewer = document.createElement('div');
    viewer.id = 'viewer';
    viewer.classList.add('pdfViewer');
    document.body.appendChild(viewer);
    expect(mod.isPdfJsViewer(document)).toBe(true);
  });


  it('returns true when #viewerContainer + .textLayer exist (fallback signal)', () => {
    const container = document.createElement('div');
    container.id = 'viewerContainer';
    const textLayer = document.createElement('div');
    textLayer.className = 'textLayer';
    container.appendChild(textLayer);
    document.body.appendChild(container);
    expect(mod.isPdfJsViewer(document)).toBe(true);
  });


  it('returns false when only #viewerContainer exists (no .textLayer)', () => {
    const container = document.createElement('div');
    container.id = 'viewerContainer';
    document.body.appendChild(container);
    expect(mod.isPdfJsViewer(document)).toBe(false);
  });
});

// =============================================================================
// isPdfJsTranslated
// =============================================================================

describe('isPdfJsTranslated', () => {
  let mod: typeof import('../entrypoints/content/pdfjs');

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mod = await import('../entrypoints/content/pdfjs');
  });

  it('returns false when no overlay divs exist', () => {
    expect(mod.isPdfJsTranslated(document)).toBe(false);
  });

  it('returns true when .fanyi-pdfjs-translation overlay exists', () => {
    const overlay = document.createElement('div');
    overlay.className = 'fanyi-pdfjs-translation';
    document.body.appendChild(overlay);
    expect(mod.isPdfJsTranslated(document)).toBe(true);
  });
});

// =============================================================================
// collectLines
// =============================================================================

describe('collectLines', () => {
  let mod: typeof import('../entrypoints/content/pdfjs');
  let restoreRect: (() => void) | null = null;

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    restoreRect = installGetBoundingClientRectMock();
    mod = await import('../entrypoints/content/pdfjs');
  });

  afterEach(() => {
    if (restoreRect) restoreRect();
  });


  it('skips spans with empty text content', () => {
    const page = makePage(1, [
      makeSpan('', { left: 0, top: 0, right: 50, bottom: 20 }),
      makeSpan('Hello', { left: 0, top: 30, right: 80, bottom: 50 }),
    ]);
    makePdfJsViewer([page]);
    const lines = mod.collectLines(document);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello');
  });



  it('groups spans with top within tolerance (3px) into one line', () => {
    // top=10 和 top=12 应该聚合（差 2px < 3px）
    const page = makePage(1, [
      makeSpan('Hello', { left: 10, top: 10, right: 55, bottom: 25 }),
      makeSpan('World', { left: 60, top: 12, right: 110, bottom: 27 }),
    ]);
    makePdfJsViewer([page]);
    const lines = mod.collectLines(document);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('Hello World');
  });

  it('separates spans with top difference exceeding tolerance', () => {
    // top=10 和 top=20 应该分为两行（差 10px > 3px）
    const page = makePage(1, [
      makeSpan('Line1', { left: 10, top: 10, right: 80, bottom: 25 }),
      makeSpan('Line2', { left: 10, top: 20, right: 80, bottom: 35 }),
    ]);
    makePdfJsViewer([page]);
    const lines = mod.collectLines(document);
    expect(lines).toHaveLength(2);
  });

  it('skips lines shorter than MIN_LINE_CHARS (2 chars)', () => {
    const page = makePage(1, [
      makeSpan('A', { left: 10, top: 10, right: 20, bottom: 25 }), // 1 字符，跳过
      makeSpan('AB', { left: 10, top: 40, right: 30, bottom: 55 }), // 2 字符，保留
    ]);
    makePdfJsViewer([page]);
    const lines = mod.collectLines(document);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe('AB');
  });


});

// =============================================================================
// groupLinesIntoParagraphs
// =============================================================================

describe('groupLinesIntoParagraphs', () => {
  let mod: typeof import('../entrypoints/content/pdfjs');
  let restoreRect: (() => void) | null = null;

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    restoreRect = installGetBoundingClientRectMock();
    mod = await import('../entrypoints/content/pdfjs');
  });

  afterEach(() => {
    if (restoreRect) restoreRect();
  });

  /**
   * 辅助：通过 collectLines 构建 lines，再调用 groupLinesIntoParagraphs。
   * 因为 PdfLine 类型不导出，测试只能通过这条路径进入。
   */
  function buildAndGroup(pages: HTMLElement[]): ReturnType<typeof mod.groupLinesIntoParagraphs> {
    makePdfJsViewer(pages);
    const lines = mod.collectLines(document);
    return mod.groupLinesIntoParagraphs(lines);
  }


  it('groups consecutive lines with small gaps into one paragraph', () => {
    // 三行，间距 = 行高（行高 15，间距 15，ratio = 1.0 < 1.5）→ 同段
    const page = makePage(1, [
      makeSpan('Line one with enough text', { left: 10, top: 10, right: 200, bottom: 25 }),
      makeSpan('Line two with enough text', { left: 10, top: 25, right: 200, bottom: 40 }),
      makeSpan('Line three with enough text', { left: 10, top: 40, right: 200, bottom: 55 }),
    ]);
    const paragraphs = buildAndGroup([page]);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].text).toContain('Line one');
    expect(paragraphs[0].text).toContain('Line two');
    expect(paragraphs[0].text).toContain('Line three');
  });

  it('splits paragraphs on large vertical gap (> 1.5x line height)', () => {
    // 行高 15，间距 40（25→65），ratio = 40/15 ≈ 2.67 > 1.5 → 新段
    const page = makePage(1, [
      makeSpan('First paragraph line one', { left: 10, top: 10, right: 200, bottom: 25 }),
      makeSpan('Second paragraph after gap', { left: 10, top: 65, right: 200, bottom: 80 }),
    ]);
    const paragraphs = buildAndGroup([page]);
    expect(paragraphs).toHaveLength(2);
  });

  it('splits paragraphs on large left indent change (> 30px)', () => {
    // 同行高、无大间距，但 left 从 10 跳到 80（变化 70px > 30px）→ 新段
    const page = makePage(1, [
      makeSpan('Left aligned text line', { left: 10, top: 10, right: 200, bottom: 25 }),
      makeSpan('Indented text line here', { left: 80, top: 25, right: 250, bottom: 40 }),
    ]);
    const paragraphs = buildAndGroup([page]);
    expect(paragraphs).toHaveLength(2);
  });

  it('splits paragraphs when previous line ends with sentence punctuation', () => {
    // 行尾是句号，下一行视为新段落
    const page = makePage(1, [
      makeSpan('This is a sentence.', { left: 10, top: 10, right: 200, bottom: 25 }),
      makeSpan('New sentence begins here', { left: 10, top: 25, right: 200, bottom: 40 }),
    ]);
    const paragraphs = buildAndGroup([page]);
    expect(paragraphs).toHaveLength(2);
  });

  it('splits paragraphs on Chinese sentence punctuation', () => {
    const page = makePage(1, [
      makeSpan('这是一句话。', { left: 10, top: 10, right: 200, bottom: 25 }),
      makeSpan('新句子从这里开始', { left: 10, top: 25, right: 200, bottom: 40 }),
    ]);
    const paragraphs = buildAndGroup([page]);
    expect(paragraphs).toHaveLength(2);
  });


  it('preserves font-size from first line of paragraph', () => {
    const page = makePage(1, [
      makeSpan('Line one', { left: 10, top: 10, right: 200, bottom: 25 }, { fontSize: '18px' }),
      makeSpan('Line two', { left: 10, top: 25, right: 200, bottom: 40 }),
    ]);
    const paragraphs = buildAndGroup([page]);
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].fontSize).toBe('18px');
  });
});

// =============================================================================
// restorePdfJsViewer
// =============================================================================

describe('restorePdfJsViewer', () => {
  let mod: typeof import('../entrypoints/content/pdfjs');

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mod = await import('../entrypoints/content/pdfjs');
  });


  it('removes data-fanyi-pdfjs-line attributes from spans', () => {
    const span = document.createElement('span');
    span.textContent = 'hello';
    span.setAttribute('data-fanyi-pdfjs-line', 'pdfjs-p0');
    document.body.appendChild(span);

    mod.restorePdfJsViewer(document);
    expect(span.hasAttribute('data-fanyi-pdfjs-line')).toBe(false);
  });

  it('clears body.dataset.fanyiTranslated', () => {
    document.body.dataset.fanyiTranslated = 'true';
    mod.restorePdfJsViewer(document);
    expect(document.body.dataset.fanyiTranslated).toBeUndefined();
  });

  it('does not throw when no overlays exist (idempotent)', () => {
    expect(() => mod.restorePdfJsViewer(document)).not.toThrow();
  });

  it('leaves other DOM nodes untouched', () => {
    const overlay = document.createElement('div');
    overlay.className = 'fanyi-pdfjs-translation';
    const other = document.createElement('div');
    other.className = 'some-other-class';
    document.body.append(overlay, other);

    mod.restorePdfJsViewer(document);
    expect(document.querySelector('.some-other-class')).not.toBeNull();
  });
});

// =============================================================================
// togglePdfJsViewer
// =============================================================================

describe('togglePdfJsViewer', () => {
  let mod: typeof import('../entrypoints/content/pdfjs');

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mod = await import('../entrypoints/content/pdfjs');
  });

  it('hides overlays on first toggle (sets display: none)', () => {
    const overlay = document.createElement('div');
    overlay.className = 'fanyi-pdfjs-translation';
    document.body.appendChild(overlay);
    // 初始 display 为空字符串（继承默认）
    expect(overlay.style.display).toBe('');

    mod.togglePdfJsViewer(document);
    expect(overlay.style.display).toBe('none');
  });


  it('toggles multiple overlays independently but consistently', () => {
    const o1 = document.createElement('div');
    o1.className = 'fanyi-pdfjs-translation';
    const o2 = document.createElement('div');
    o2.className = 'fanyi-pdfjs-translation';
    document.body.append(o1, o2);

    mod.togglePdfJsViewer(document);
    expect(o1.style.display).toBe('none');
    expect(o2.style.display).toBe('none');
  });

  it('does not throw when no overlays exist', () => {
    expect(() => mod.togglePdfJsViewer(document)).not.toThrow();
  });
});

// =============================================================================
// translatePdfJsViewer (端到端集成测试)
// =============================================================================

describe('translatePdfJsViewer', () => {
  let mod: typeof import('../entrypoints/content/pdfjs');
  let restoreRect: (() => void) | null = null;

  beforeEach(async () => {
    document.body.innerHTML = '';
    vi.clearAllMocks();
    mockSendMessage.mockReset();
    restoreRect = installGetBoundingClientRectMock();
    mod = await import('../entrypoints/content/pdfjs');
  });

  afterEach(() => {
    if (restoreRect) restoreRect();
  });

  /**
   * 让 mockSendMessage 把 jsonContent 里的 block 原样翻译成 "[译] 原文"。
   * 返回标准的 TranslateChunkSuccessResponse 形状。
   */
  function mockEchoTranslate(): void {
    mockSendMessage.mockImplementation(async (msg: { jsonContent: string }) => {
      const items = JSON.parse(msg.jsonContent) as Array<{ id: string; text: string }>;
      return {
        success: true,
        result: items.map((it) => [it.id, `[译] ${it.text}`] as [string, string]),
      };
    });
  }

  it('throws when no textLayer spans exist', async () => {
    makePdfJsViewer([]);
    const state: TranslationState = { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() };
    const onStatus = vi.fn();
    await expect(
      mod.translatePdfJsViewer(
        { sourceLang: 'en', targetLang: 'zh' },
        state,
        onStatus,
      ),
    ).rejects.toThrow(/没有已渲染/);
  });

  it('translates paragraphs and renders overlays', async () => {
    mockEchoTranslate();
    const page = makePage(1, [
      makeSpan('Hello world.', { left: 10, top: 10, right: 200, bottom: 25 }),
      makeSpan('Second paragraph.', { left: 10, top: 65, right: 200, bottom: 80 }),
    ]);
    makePdfJsViewer([page]);

    const state: TranslationState = { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() };
    const onStatus = vi.fn();
    const result = await mod.translatePdfJsViewer(
      { sourceLang: 'en', targetLang: 'zh' },
      state,
      onStatus,
    );

    expect(result.translated).toBe(true);
    expect(result.paragraphCount).toBe(2);
    // 覆盖层已渲染
    const overlays = document.querySelectorAll('.fanyi-pdfjs-translation');
    expect(overlays.length).toBe(2);
    expect(overlays[0].textContent).toBe('[译] Hello world.');
    expect(overlays[1].textContent).toBe('[译] Second paragraph.');
    // state 已填充
    expect(state.originalTexts.size).toBe(2);
    expect(state.translatedBlocks.size).toBe(2);
    expect(state.translatedTexts.size).toBe(2);
    // body 标记
    expect(document.body.dataset.fanyiTranslated).toBe('true');
  });

  it('skips paragraphs shorter than 3 characters', async () => {
    mockEchoTranslate();
    const page = makePage(1, [
      makeSpan('Hi', { left: 10, top: 10, right: 30, bottom: 25 }), // 2 字符，跳过
      makeSpan('Real paragraph content here.', { left: 10, top: 65, right: 200, bottom: 80 }),
    ]);
    makePdfJsViewer([page]);

    const state: TranslationState = { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() };
    const result = await mod.translatePdfJsViewer(
      { sourceLang: 'en', targetLang: 'zh' },
      state,
      vi.fn(),
    );

    expect(result.translated).toBe(true);
    expect(result.paragraphCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(document.querySelectorAll('.fanyi-pdfjs-translation')).toHaveLength(1);
  });

  it('returns translated:false when all paragraphs fail to translate', async () => {
    // mock 返回 success: false
    mockSendMessage.mockResolvedValue({ success: false, error: 'API error' });
    const page = makePage(1, [
      makeSpan('Hello world here.', { left: 10, top: 10, right: 200, bottom: 25 }),
    ]);
    makePdfJsViewer([page]);

    const state: TranslationState = { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() };
    const result = await mod.translatePdfJsViewer(
      { sourceLang: 'en', targetLang: 'zh' },
      state,
      vi.fn(),
    );

    expect(result.translated).toBe(false);
    expect(result.paragraphCount).toBe(0);
    expect(document.querySelectorAll('.fanyi-pdfjs-translation')).toHaveLength(0);
  });

  it('passes sourceLang / targetLang / pageUrl to sendMessage', async () => {
    mockEchoTranslate();
    const page = makePage(1, [
      makeSpan('Hello world.', { left: 10, top: 10, right: 200, bottom: 25 }),
    ]);
    makePdfJsViewer([page]);

    const state: TranslationState = { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() };
    await mod.translatePdfJsViewer(
      { sourceLang: 'en', targetLang: 'zh' },
      state,
      vi.fn(),
    );

    expect(mockSendMessage).toHaveBeenCalled();
    const call = mockSendMessage.mock.calls[0][0];
    expect(call.action).toBe('translateChunk');
    expect(call.sourceLang).toBe('en');
    expect(call.targetLang).toBe('zh');
    expect(call.pageUrl).toBe(window.location.href);
  });


  it('tags original spans with data-fanyi-pdfjs-line for restore', async () => {
    mockEchoTranslate();
    const page = makePage(1, [
      makeSpan('Hello world.', { left: 10, top: 10, right: 200, bottom: 25 }),
    ]);
    makePdfJsViewer([page]);

    const state: TranslationState = { originalTexts: new Map(), translatedBlocks: new Set(), translatedTexts: new Map() };
    await mod.translatePdfJsViewer(
      { sourceLang: 'en', targetLang: 'zh' },
      state,
      vi.fn(),
    );

    const taggedSpan = document.querySelector('[data-fanyi-pdfjs-line]');
    expect(taggedSpan).not.toBeNull();
    expect(taggedSpan?.getAttribute('data-fanyi-pdfjs-line')).toBe('pdfjs-p0');
  });
});
