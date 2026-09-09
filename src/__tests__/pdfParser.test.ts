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

  it('解析抛错时 loadingTask 仍被销毁（finally，避免 worker 泄漏）', async () => {
    cfg.getPageThrows = true;
    const ab = new ArrayBuffer(8);
    await expect(parsePdfDocument(ab, { fileName: 'x.pdf' })).rejects.toThrow('boom');
    expect(destroySpy).toHaveBeenCalledTimes(1);
    cfg.getPageThrows = false;
  });
});
