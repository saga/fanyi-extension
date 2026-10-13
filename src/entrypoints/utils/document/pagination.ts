import type { DocumentSegment, ParsedDocument } from './types';

/** 阅读页默认大小：约一万字，且限制片段数量，防止长书一次渲染成超长页面。 */
export interface DocumentPageOptions {
  maxChars?: number;
  maxSegments?: number;
}

export interface DocumentReaderPage {
  /** 当前解析结果中的页面 key；不是持久化的文档 ID。 */
  id: string;
  /** 阅读导航显示的页标题，章节过长时附带子页序号。 */
  title: string;
  /** 逻辑章节标题，供导航与阅读位置提示使用。 */
  sectionTitle: string;
  segments: DocumentSegment[];
  charCount: number;
}

const DEFAULT_PAGE_OPTIONS: Required<DocumentPageOptions> = {
  maxChars: 10_000,
  maxSegments: 80,
};

function headingTitle(segments: DocumentSegment[]): string | undefined {
  return segments.find((segment) => segment.kind === 'heading')?.text.trim().slice(0, 100);
}

function splitGroup(
  segments: DocumentSegment[],
  title: string,
  groupId: string,
  budget: Required<DocumentPageOptions>,
): DocumentReaderPage[] {
  const chunks: DocumentSegment[][] = [];
  let current: DocumentSegment[] = [];
  let chars = 0;

  for (const segment of segments) {
    // 超预算前结束当前页。单个超长片段独占一页，不从句子中间截断。
    if (current.length > 0 &&
      (chars + segment.text.length > budget.maxChars || current.length >= budget.maxSegments)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(segment);
    chars += segment.text.length;
  }
  if (current.length) chunks.push(current);

  return chunks.map((chunk, index) => {
    const suffix = chunks.length > 1 ? ' · ' + (index + 1) + '/' + chunks.length : '';
    return {
      id: groupId + ':' + index,
      title: title + suffix,
      sectionTitle: title,
      segments: chunk,
      charCount: chunk.reduce((sum, segment) => sum + segment.text.length, 0),
    };
  });
}

/**
 * 生成阅读器的虚拟分页，不修改文档原始 segment 顺序或稳定 ID。
 * EPUB 先按 spine path 分章再按字符数切长章；PDF 尽量按原始页码；其余格式按阅读预算切页。
 */
export function buildDocumentPages(
  doc: ParsedDocument,
  options: DocumentPageOptions = {},
): DocumentReaderPage[] {
  const budget = { ...DEFAULT_PAGE_OPTIONS, ...options };
  const segments = doc.segments;
  if (!segments.length) return [];

  if (doc.format === 'epub') {
    const groups: Array<{ path: string; segments: DocumentSegment[] }> = [];
    for (const segment of segments) {
      const path = segment.path || segment.contextPath || 'epub-body';
      const previous = groups[groups.length - 1];
      if (!previous || previous.path !== path) groups.push({ path, segments: [segment] });
      else previous.segments.push(segment);
    }

    const pages: DocumentReaderPage[] = [];
    for (let chapterIndex = 0; chapterIndex < groups.length; chapterIndex++) {
      const group = groups[chapterIndex]!;
      const title = group.segments[0]?.contextPath ||
        headingTitle(group.segments) ||
        ('第 ' + (chapterIndex + 1) + ' 章');
      pages.push(...splitGroup(group.segments, title, 'epub-' + chapterIndex, budget));
    }
    return pages;
  }

  if (doc.format === 'pdf') {
    const groups: Array<{ page: number | undefined; segments: DocumentSegment[] }> = [];
    for (const segment of segments) {
      const pageNumber = segment.page;
      const previous = groups[groups.length - 1];
      if (!previous || previous.page !== pageNumber) groups.push({ page: pageNumber, segments: [segment] });
      else previous.segments.push(segment);
    }
    const pages: DocumentReaderPage[] = [];
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]!;
      const title = group.page ? 'PDF 第 ' + group.page + ' 页' : '阅读页 ' + (index + 1);
      pages.push(...splitGroup(group.segments, title, 'pdf-' + (group.page ?? index), budget));
    }
    return pages;
  }

  const chunks = splitGroup(segments, '文档', 'document', budget);
  return chunks.map((page, index) => {
    const heading = headingTitle(page.segments);
    return {
      ...page,
      title: (heading ? heading + ' · ' : '') + '阅读页 ' + (index + 1),
      sectionTitle: heading || '阅读页 ' + (index + 1),
    };
  });
}
