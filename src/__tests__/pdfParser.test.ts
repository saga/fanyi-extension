// 回归：pdfjs-dist v6 下 PDFDocumentProxy 没有 destroy() 方法（只有 cleanup()），
// destroy() 实际定义在 PDFDocumentLoadingTask 上（getDocument() 的返回值，而非 .promise 的 proxy）。
// 旧代码 `await doc.destroy()` 会抛 `doc.destroy is not a function`。
//
// 说明：pdfjs 的 worker 在 jsdom 测试环境下无法加载（无 Worker + fake worker 找不到模块），
// 因此这里 mock pdfjs-dist 模块，直接断言修复点：destroy() 必须调用在 loadingTask 上、
// 解析主流程不受影响、且异常路径仍走 finally 释放 worker。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const destroySpy = vi.fn().mockResolvedValue(undefined);

const sampleItems = [
  { str: 'Hello World fanyi test', transform: [1, 0, 0, 12, 72, 720], height: 12 },
  { str: 'Second line of text', transform: [1, 0, 0, 12, 72, 690], height: 12 },
  { str: 'Third paragraph here', transform: [1, 0, 0, 12, 72, 660], height: 12 },
];
const baselineSampleItems = sampleItems.map((item) => ({ ...item, transform: [...item.transform] }));

const cfg = { getPageThrows: false };

vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(() => {
    const proxy = {
      numPages: 1,
      getPage: vi.fn(async () => {
        if (cfg.getPageThrows) throw new Error('boom');
        return {
          getTextContent: async () => ({ items: sampleItems }),
        };
      }),
    };
    // 关键：destroy() 在 loadingTask 上，proxy 故意不带 destroy（复刻 v6 真实行为）
    return { promise: Promise.resolve(proxy), destroy: destroySpy };
  }),
}));

import { parsePdfDocument } from '../entrypoints/utils/document/parsers/pdf';

describe('parsePdfDocument', () => {
  beforeEach(() => {
    destroySpy.mockClear();
    cfg.getPageThrows = false;
    sampleItems.splice(0, sampleItems.length, ...baselineSampleItems);
  });

  it('v6 API 回归：destroy() 调用在 loadingTask 上，而非 proxy（不抛 doc.destroy is not a function）', async () => {
    const ab = new ArrayBuffer(8);
    const result = await parsePdfDocument(ab, { fileName: 'minimal.pdf' });

    // 破坏点：旧代码调 doc.destroy() —— proxy 无此方法会抛错。
    // 修复后必须销毁 loadingTask。
    expect(destroySpy).toHaveBeenCalledTimes(1);

    // 解析主流程不受影响
    expect(result.format).toBe('pdf');
    expect(result.segments.length).toBeGreaterThan(0);
    const all = result.segments.map((s) => s.text).join(' ');
    expect(all).toContain('Hello World');
    expect(all).toContain('Second line');
    expect(all).toContain('Third paragraph');
  });

  it('同段跨行文本以空格拼接，并修复英文行尾断词', async () => {
    const multiLineItems = [
      { str: 'The document contains a reli-', transform: [1, 0, 0, 12, 72, 720], height: 12, width: 160 },
      { str: 'able translation pipeline.', transform: [1, 0, 0, 12, 72, 705], height: 12, width: 140 },
      { str: 'Chinese text remains natural.', transform: [1, 0, 0, 12, 72, 690], height: 12, width: 150 },
    ];
    sampleItems.splice(0, sampleItems.length, ...multiLineItems);
    const result = await parsePdfDocument(new ArrayBuffer(8), { fileName: 'article.pdf' });
    const text = result.segments.map((segment) => segment.text).join(' ');
    expect(text).toContain('reliable translation pipeline.');
    expect(text).not.toContain('reli- able');
    expect(text).toContain('pipeline. Chinese');
  });

  it('为 PDF 片段附上源页和章节上下文，方便追踪与一致翻译', async () => {
    sampleItems.splice(0, sampleItems.length,
      { str: '1 Introduction', transform: [1, 0, 0, 20, 72, 720], height: 20, width: 140 },
      { str: 'This section explains the design and its implications for the rest of the document.', transform: [1, 0, 0, 12, 72, 700], height: 12, width: 320 },
      { str: 'The following paragraph gives more details about the approach and evaluation.', transform: [1, 0, 0, 12, 72, 685], height: 12, width: 300 },
    );
    const result = await parsePdfDocument(new ArrayBuffer(8), { fileName: 'article.pdf' });
    expect(result.segments[0]?.kind).toBe('heading');
    expect(result.segments[0]?.page).toBe(1);
    expect(result.segments[1]?.contextPath).toContain('Introduction');
  });
  it('将编号列表的标记独立保存，并将无标记续行合并进同一列表项', async () => {
    sampleItems.splice(0, sampleItems.length,
      { str: '1. First list item continues', transform: [1, 0, 0, 12, 72, 720], height: 12, width: 190 },
      { str: 'on the following visual line', transform: [1, 0, 0, 12, 72, 705], height: 12, width: 180 },
      { str: '2. The second item contains enough text to remain a distinct entry.', transform: [1, 0, 0, 12, 72, 690], height: 12, width: 300 },
    );
    const result = await parsePdfDocument(new ArrayBuffer(8), { fileName: 'list.pdf' });

    expect(result.segments).toHaveLength(2);
    expect(result.segments[0]?.kind).toBe('list-item');
    expect(result.segments[0]?.marker).toBe('1.');
    expect(result.segments[0]?.text).toContain('First list item continues on the following visual line');
    expect(result.segments[0]?.text).not.toMatch(/^1\./);
    expect(result.segments[1]?.marker).toBe('2.');
    expect(result.segments[1]?.text).not.toMatch(/^2\./);
  });

  it('解析抛错时 loadingTask 仍被销毁（finally，避免 worker 泄漏）', async () => {
    cfg.getPageThrows = true;
    const ab = new ArrayBuffer(8);
    await expect(parsePdfDocument(ab, { fileName: 'x.pdf' })).rejects.toThrow('boom');
    expect(destroySpy).toHaveBeenCalledTimes(1);
    cfg.getPageThrows = false;
  });
});
