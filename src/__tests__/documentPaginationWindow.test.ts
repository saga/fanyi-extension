import { describe, it, expect } from 'vitest';
import { nextUntranslatedPageWindow, type DocumentReaderPage } from '../entrypoints/utils/document/pagination';
import type { DocumentSegment } from '../entrypoints/utils/document/types';

/**
 * 「翻译下三页」的推进语义：锚点是已译区域的末端，不是固定的当前页。
 * 连续点击必须持续向后推进（3 页 → 6 页 → 9 页），不能在同一窗口空转。
 */

function segment(id: string): DocumentSegment {
  return { id, text: 'text of ' + id, kind: 'paragraph' } as DocumentSegment;
}

function page(index: number, segmentIds: string[]): DocumentReaderPage {
  const segments = segmentIds.map(segment);
  return {
    id: 'page-' + index,
    title: '阅读页 ' + (index + 1),
    sectionTitle: '阅读页 ' + (index + 1),
    segments,
    charCount: segments.reduce((sum, item) => sum + item.text.length, 0),
  };
}

/** 生成 12 页、每页 1 段的文档。 */
function twelvePages(): DocumentReaderPage[] {
  return Array.from({ length: 12 }, (_, index) => page(index, ['s' + index]));
}

/** 用一组「已译片段 ID」构造判据。 */
function translated(ids: string[]): (segmentId: string) => boolean {
  const set = new Set(ids);
  return (segmentId: string) => set.has(segmentId);
}

describe('nextUntranslatedPageWindow', () => {
  it('当前页未译时窗口从当前页开始，共 3 页', () => {
    const window = nextUntranslatedPageWindow(twelvePages(), 0, 3, translated([]));
    expect(window.map((item) => item.id)).toEqual(['page-0', 'page-1', 'page-2']);
  });

  it('连续点击持续推进：3 页 → 6 页 → 9 页', () => {
    const pages = twelvePages();
    const done = new Set<string>();
    const mark = (window: DocumentReaderPage[]) => {
      for (const item of window) for (const seg of item.segments) done.add(seg.id);
    };
    const isTranslated = (segmentId: string) => done.has(segmentId);

    const first = nextUntranslatedPageWindow(pages, 0, 3, isTranslated);
    expect(first.map((item) => item.id)).toEqual(['page-0', 'page-1', 'page-2']);
    mark(first);

    // 第二次点击：当前页（page-0）已译完，窗口整体后移，不是重复第一窗口。
    const second = nextUntranslatedPageWindow(pages, 0, 3, isTranslated);
    expect(second.map((item) => item.id)).toEqual(['page-3', 'page-4', 'page-5']);
    mark(second);

    const third = nextUntranslatedPageWindow(pages, 0, 3, isTranslated);
    expect(third.map((item) => item.id)).toEqual(['page-6', 'page-7', 'page-8']);
  });

  it('当前页已译完时，第一次点击就跳过当前页', () => {
    const window = nextUntranslatedPageWindow(twelvePages(), 2, 3, translated(['s0', 's1', 's2']));
    expect(window.map((item) => item.id)).toEqual(['page-3', 'page-4', 'page-5']);
  });

  it('中间存在未译空洞时，跳过已译页面继续收集，凑满 3 个待译页', () => {
    // page-0 已译、page-1 未译、page-2..page-5 已译：窗口是 page-1 再往后两个待译页。
    const window = nextUntranslatedPageWindow(
      twelvePages(), 0, 3, translated(['s0', 's2', 's3', 's4', 's5']),
    );
    expect(window.map((item) => item.id)).toEqual(['page-1', 'page-6', 'page-7']);
  });

  it('部分译完的页面仍然计入窗口', () => {
    const pages = twelvePages();
    pages[0]!.segments = [segment('a'), segment('b')];
    const window = nextUntranslatedPageWindow(pages, 0, 3, translated(['a']));
    expect(window.map((item) => item.id)).toEqual(['page-0', 'page-1', 'page-2']);
  });

  it('pageCount=1 时只推进一页', () => {
    const window = nextUntranslatedPageWindow(twelvePages(), 0, 1, translated(['s0']));
    expect(window.map((item) => item.id)).toEqual(['page-1']);
  });

  it('全部译完时返回空数组（按钮应据此置灰）', () => {
    const pages = twelvePages();
    const allIds = pages.flatMap((item) => item.segments.map((seg) => seg.id));
    expect(nextUntranslatedPageWindow(pages, 0, 3, translated(allIds))).toEqual([]);
  });

  it('当前页越界或页码非法时不抛错', () => {
    const pages = twelvePages();
    expect(nextUntranslatedPageWindow(pages, 99, 3, translated([]))).toEqual([]);
    expect(nextUntranslatedPageWindow(pages, -5, 3, translated([])).map((item) => item.id))
      .toEqual(['page-0', 'page-1', 'page-2']);
    expect(nextUntranslatedPageWindow([], 0, 3, translated([]))).toEqual([]);
    expect(nextUntranslatedPageWindow(pages, 0, 0, translated([]))).toEqual([]);
  });
});
