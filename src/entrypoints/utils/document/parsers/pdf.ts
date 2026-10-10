// 用 legacy 构建：modern 构建依赖 Promise.withResolvers 等较新 API，
// 在 Firefox ESR / 旧版上会直接崩；legacy 额外带 core-js polyfill，兼容性更好。
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { DocumentSegment, ParsedDocument, SegmentKind } from '../types';
import { DEFAULT_MAX_SEGMENT_CHARS, splitLongText } from './text';

interface PdfTextItem {
  str: string;
  transform: number[];
  height: number;
  width?: number;
}

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface ParsePdfOptions {
  maxSegmentChars?: number;
  fileName?: string;
  /** 最多解析页数，防超大 PDF 卡死。默认 300。 */
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
}

interface Atom { text: string; x: number; y: number; width: number; height: number; }
interface Line {
  y: number; x: number; right: number; height: number; text: string;
  /** 0/1 为检测到的正文栏，-1 为疑似跨栏标题；未检测出分栏时全为 0。 */
  column: number; pageHeight: number;
}
interface ParsedPage { pageNo: number; width: number; height: number; lines: Line[]; }

function isTextItem(item: unknown): item is PdfTextItem {
  return typeof item === 'object' && item !== null &&
    typeof (item as PdfTextItem).str === 'string' &&
    Array.isArray((item as PdfTextItem).transform);
}

function median(values: number[], fallback: number): number {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallback;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle] as number
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function toAtom(item: PdfTextItem): Atom | null {
  const text = item.str.replace(/\u0000/g, '').replace(/[\t\u00a0 ]+/g, ' ').trim();
  const x = item.transform[4];
  const y = item.transform[5];
  const height = item.height || Math.abs(item.transform[3] || 0) || 10;
  if (!text || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  // PDF.js 的 width 通常可靠；测试夹具/异常 PDF 缺失 width 时以平均字宽估算。
  const width = Number.isFinite(item.width) && (item.width as number) > 0
    ? item.width as number
    : Math.max(height * 0.25, Array.from(text).length * height * 0.5);
  return { text, x, y, width, height };
}

/** 相同基线的文字项依照 x 排列；明显跨越空白槽的片段先拆开，供双栏判定。 */
function groupIntoLines(items: PdfTextItem[], pageHeight: number): Line[] {
  const atoms = items.map(toAtom).filter((atom): atom is Atom => atom !== null)
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Atom[][] = [];

  for (const atom of atoms) {
    const current = rows[rows.length - 1];
    const rowHeight = current?.reduce((height, entry) => Math.max(height, entry.height), 0) ?? atom.height;
    const rowY = current?.length ? median(current.map((entry) => entry.y), atom.y) : atom.y;
    if (current && Math.abs(rowY - atom.y) <= Math.max(atom.height, rowHeight) * 0.48) {
      current.push(atom);
    } else {
      rows.push([atom]);
    }
  }

  const lines: Line[] = [];
  for (const row of rows) {
    row.sort((a, b) => a.x - b.x);
    let fragment: Atom[] = [];
    const flushFragment = () => {
      if (!fragment.length) return;
      const first = fragment[0] as Atom;
      let text = first.text;
      let right = first.x + first.width;
      let height = first.height;
      let x = first.x;
      for (let i = 1; i < fragment.length; i++) {
        const atom = fragment[i] as Atom;
        const previousText = text.trimEnd();
        const nextText = atom.text.trimStart();
        const gap = atom.x - right;
        const previousChar = Array.from(previousText).at(-1) ?? '';
        const nextChar = Array.from(nextText)[0] ?? '';
        const noSpaceScript = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
        const punctuationStart = /^[,.;:!?，。；：！？、)】》」』〕］｝]/u.test(nextText);
        const needsSpace = gap > Math.max(1, Math.min(atom.height, height) * 0.12) &&
          previousChar && nextChar && !/\s/u.test(previousChar) &&
          !punctuationStart && !(noSpaceScript.test(previousChar) && noSpaceScript.test(nextChar));
        if (needsSpace) text += ' ';
        text += nextText;
        right = Math.max(right, atom.x + atom.width);
        height = Math.max(height, atom.height);
        x = Math.min(x, atom.x);
      }
      lines.push({
        y: median(fragment.map((atom) => atom.y), first.y),
        x, right, height,
        text: text.replace(/[ \t]+/g, ' ').trim(),
        column: 0,
        pageHeight,
      });
      fragment = [];
    };

    let rightEdge: number | null = null;
    let previousHeight = 0;
    for (const atom of row) {
      // 留白大于约 2.5 个字高通常表示栏沟或表格单元格间隔。
      const gap = rightEdge === null ? 0 : atom.x - rightEdge;
      const gutter = rightEdge !== null && gap > Math.max(18, Math.max(atom.height, previousHeight) * 2.5);
      if (gutter) {
        flushFragment();
        rightEdge = null;
        previousHeight = 0;
      }
      fragment.push(atom);
      rightEdge = Math.max(rightEdge ?? atom.x, atom.x + atom.width);
      previousHeight = Math.max(previousHeight, atom.height);
    }
    flushFragment();
  }
  return lines.filter((line) => line.text.length > 0);
}

/**
 * 只在证据充分时重排双栏：两侧均有多行、起始 x 相距明显、纵向范围重叠，
 * 且每栏不是由短小表格单元格组成。否则保留逐行阅读顺序，避免把表格变成列优先。
 */
function orderLinesForReading(lines: Line[], pageWidth: number, pageHeight: number): Line[] {
  const topDown = [...lines].sort((a, b) => b.y - a.y || a.x - b.x);
  if (lines.length < 8 || !(pageWidth > 0)) return topDown;
  const bodyHeight = median(lines.map((line) => line.height).filter((height) => height >= 4), 10);
  const body = lines.filter((line) => line.right - line.x < pageWidth * 0.68);
  const tolerance = Math.max(bodyHeight * 1.8, pageWidth * 0.018);
  const clusters: Array<{ center: number; lines: Line[] }> = [];

  for (const line of [...body].sort((a, b) => a.x - b.x)) {
    const nearest = clusters
      .map((cluster, index) => ({ cluster, index, distance: Math.abs(cluster.center - line.x) }))
      .filter((entry) => entry.distance <= tolerance)
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest) {
      nearest.cluster.lines.push(line);
      nearest.cluster.center = median(nearest.cluster.lines.map((entry) => entry.x), line.x);
    } else {
      clusters.push({ center: line.x, lines: [line] });
    }
  }

  const viable = clusters.filter((cluster) => cluster.lines.length >= 3).sort((a, b) => a.center - b.center);
  let selected: [typeof viable[number], typeof viable[number]] | null = null;
  let selectedGap = 0;
  for (let i = 0; i < viable.length; i++) {
    for (let j = i + 1; j < viable.length; j++) {
      const left = viable[i] as typeof viable[number];
      const right = viable[j] as typeof viable[number];
      const gap = right.center - left.center;
      if (gap < Math.max(bodyHeight * 7, pageWidth * 0.16)) continue;
      const leftTop = Math.min(...left.lines.map((line) => line.y));
      const leftBottom = Math.max(...left.lines.map((line) => line.y));
      const rightTop = Math.min(...right.lines.map((line) => line.y));
      const rightBottom = Math.max(...right.lines.map((line) => line.y));
      const overlap = Math.max(0, Math.min(leftBottom, rightBottom) - Math.max(leftTop, rightTop));
      if (overlap < Math.max(bodyHeight * 4, pageHeight * 0.2)) continue;
      const averageLength = (group: typeof left) =>
        group.lines.reduce((sum, line) => sum + line.text.length, 0) / group.lines.length;
      // 表格列常由大量短文本组成；除非两侧都更像正文，否则不把列优先当成双栏文章。
      if (averageLength(left) < 28 || averageLength(right) < 28) continue;
      if (gap > selectedGap) {
        selected = [left, right];
        selectedGap = gap;
      }
    }
  }

  // 没有充分的双栏证据时，不强行重排；普通单栏与大多数表格保持原来的从上到下顺序。
  if (!selected) return topDown;

  const [leftCluster, rightCluster] = selected;
  for (const line of lines) {
    if (line.right - line.x >= pageWidth * 0.68) line.column = -1;
    else line.column =
      Math.abs(line.x - leftCluster.center) <= Math.abs(line.x - rightCluster.center) ? 0 : 1;
  }

  // 宽行在真实 y 位置切分阅读区域：跨栏标题/图注不会全部跑到页面最前面。
  // 每个区域先读完整左栏，再读完整右栏，从根本上避免左右栏逐行交错。
  const output: Line[] = [];
  let band: Line[] = [];
  const flushBand = () => {
    if (!band.length) return;
    output.push(...band.filter((line) => line.column === 0).sort((a, b) => b.y - a.y || a.x - b.x));
    output.push(...band.filter((line) => line.column === 1).sort((a, b) => b.y - a.y || a.x - b.x));
    band = [];
  };
  for (const line of topDown) {
    if (line.column === -1) {
      flushBand();
      output.push(line);
    } else {
      band.push(line);
    }
  }
  flushBand();
  return output;
}

function normalizedFurnitureText(text: string): string {
  return text.toLocaleLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/** 跨多页、重复出现在页顶/页底的短文本视为页眉/页脚；少页文档不猜测。 */
function removeRepeatedFurniture(pages: ParsedPage[]): number {
  if (pages.length < 3) return 0;
  const pageCountByKey = new Map<string, Set<number>>();
  for (const page of pages) {
    for (const line of page.lines) {
      const atEdge = line.y > page.height * 0.88 ? 'top'
        : line.y < page.height * 0.12 ? 'bottom' : '';
      if (!atEdge || line.text.length > 90 || !/[a-zA-Z\p{Script=Han}]/u.test(line.text)) continue;
      const key = atEdge + ':' + normalizedFurnitureText(line.text);
      const found = pageCountByKey.get(key) ?? new Set<number>();
      found.add(page.pageNo);
      pageCountByKey.set(key, found);
    }
  }
  const threshold = Math.max(3, Math.ceil(pages.length * 0.3));
  const repeated = new Set(
    [...pageCountByKey.entries()].filter(([, pageNos]) => pageNos.size >= threshold).map(([key]) => key),
  );
  let removed = 0;
  for (const page of pages) {
    const before = page.lines.length;
    page.lines = page.lines.filter((line) => {
      const atEdge = line.y > page.height * 0.88 ? 'top'
        : line.y < page.height * 0.12 ? 'bottom' : '';
      if (!atEdge || line.text.length > 90) return true;
      return !repeated.has(atEdge + ':' + normalizedFurnitureText(line.text));
    });
    removed += before - page.lines.length;
  }
  return removed;
}

function endsSentence(text: string): boolean {
  return /[.!?。！？；;:：]["')\]}”’』」]*$/u.test(text.trim());
}

function joinWrappedLines(previous: string, next: string): string {
  const left = previous.trimEnd();
  const right = next.trimStart();
  if (!left) return right;
  if (!right) return left;
  // PDF 常在行末把英文单词断成 hyphen；只在下一行以小写字母开头时去掉连字符。
  if (/[-\u2010\u00ad]$/u.test(left) && /^[a-z]/u.test(right)) {
    return left.replace(/[-\u2010\u00ad]$/u, '') + right;
  }
  const last = Array.from(left).at(-1) ?? '';
  const first = Array.from(right)[0] ?? '';
  const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  if (cjk.test(last) && cjk.test(first)) return left + right;
  if (/[([{（【「『]$/u.test(left) || /^[,.;:!?，。；：！？、)\]}）】」』]/u.test(right)) return left + right;
  return left + ' ' + right;
}

function isHeadingLine(line: Line, medianHeight: number): boolean {
  const text = line.text.trim();
  const short = text.length > 0 && text.length < 120;
  // 同字号的“1. item”通常是列表；只有字号明显突出时才把编号列表样式提升为标题。
  if (extractListMarker(text) && line.height <= medianHeight * 1.22) return false;
  const semanticHeading = /^(?:\d+(?:\.\d+)*\s+[A-Z][^.!?。！？]{0,90}|chapter\s+\d+\b|abstract\b|introduction\b|conclusion\b|references\b|摘要\b|引言\b|结论\b|参考文献\b)/iu.test(text);
  return short && (line.height > medianHeight * 1.22 || semanticHeading);
}

function extractListMarker(text: string): string | undefined {
  const match = /^\s*(?:([•●▪◦*-])|(\(?\d+[.)、])|([A-Za-z][.)]))\s+/u.exec(text);
  if (!match) return undefined;
  // 统一视觉项目符号，保留数字/字母编号；正文里不包含 marker，防止重复输出。
  return match[2] ?? match[3] ?? '-';
}

function stripListMarker(text: string): string {
  return text.replace(/^\s*(?:[•●▪◦*-]|\(?\d+[.)、]|[A-Za-z][.)])\s+/u, '').trim();
}

function classifyLine(text: string): SegmentKind {
  if (extractListMarker(text)) return 'list-item';
  if (/^(?:fig(?:ure)?|table|图|表)\s*[.:-]?\s*\d+/iu.test(text)) return 'caption';
  if (/^>\s?/u.test(text)) return 'quote';
  return 'paragraph';
}

export async function parsePdfDocument(
  arrayBuffer: ArrayBuffer,
  options: ParsePdfOptions = {},
): Promise<ParsedDocument> {
  const max = options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS;
  const maxPages = options.maxPages ?? 300;
  const warnings: string[] = [];
  const segments: DocumentSegment[] = [];
  const loadingTask = pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) });
  const doc = await loadingTask.promise;
  try {
    const total = Math.min(doc.numPages, maxPages);
    if (doc.numPages > maxPages) warnings.push('文档共 ' + doc.numPages + ' 页，本次只解析前 ' + maxPages + ' 页');

    let title = (options.fileName ?? '').replace(/\.[^.]+$/, '') || '文档';
    const blankPages: number[] = [];
    const parsedPages: ParsedPage[] = [];

    // 先按页提取并保留少量几何信息，后续才能统一识别重复页眉/页脚和分栏。
    for (let pageNo = 1; pageNo <= total; pageNo++) {
      const page = await doc.getPage(pageNo);
      try {
        const content = await page.getTextContent();
        const items = content.items.filter(isTextItem).filter((item) => item.str.trim());
        let width = 0;
        let height = 0;
        if (typeof (page as unknown as { getViewport?: unknown }).getViewport === 'function') {
          const viewport = (page as unknown as { getViewport: (args: { scale: number }) => { width: number; height: number } }).getViewport({ scale: 1 });
          width = viewport.width;
          height = viewport.height;
        }
        if (!items.length) {
          blankPages.push(pageNo);
          options.onProgress?.(pageNo, total);
          parsedPages.push({ pageNo, width, height, lines: [] });
          continue;
        }

        const lines = groupIntoLines(items, height);
        if (!width) width = Math.max(...lines.map((line) => line.right), 0) + 24;
        if (!height) height = Math.max(...lines.map((line) => line.y), 0) + 24;
        parsedPages.push({ pageNo, width, height, lines });
        options.onProgress?.(pageNo, total);
      } finally {
        page.cleanup?.();
      }
    }

    const removedFurniture = removeRepeatedFurniture(parsedPages);
    if (removedFurniture) warnings.push('已过滤 ' + removedFurniture + ' 条跨页重复的页眉/页脚文本');

    let index = 0;
    const sectionTitles: string[] = [];
    let shortTextPages = 0;

    for (const page of parsedPages) {
      if (!page.lines.length) continue;
      const orderedLines = orderLinesForReading(page.lines, page.width, page.height);
      const medianHeight = median(orderedLines.map((line) => line.height).filter((height) => height >= 4), 10);
      const pitches: number[] = [];
      for (let i = 1; i < orderedLines.length; i++) {
        const previous = orderedLines[i - 1] as Line;
        const current = orderedLines[i] as Line;
        const gap = previous.y - current.y;
        if (previous.column === current.column && gap > medianHeight * 0.55 && gap < medianHeight * 2.8) pitches.push(gap);
      }
      const medianPitch = median(pitches, medianHeight * 1.2);

      let bufferedLines: Line[] = [];
      let bufferKind: SegmentKind = 'paragraph';
      let bufferLevel: number | undefined;
      let bufferMarker: string | undefined;
      let bufferPage = page.pageNo;
      let previousLine: Line | null = null;
      const currentContext = () => sectionTitles.filter(Boolean).join(' > ');

      const flush = () => {
        if (!bufferedLines.length) return;
        let text = '';
        for (const line of bufferedLines) text = text ? joinWrappedLines(text, line.text) : line.text.trim();
        text = text.replace(/[ \t]+/g, ' ').trim();
        bufferedLines = [];
        if (!text) return;

        const pieces = splitLongText(text, max);
        for (let pieceIndex = 0; pieceIndex < pieces.length; pieceIndex++) {
          const piece = pieces[pieceIndex] as string;
          segments.push({
            id: 's' + index,
            index,
            text: piece,
            // 超长列表项被软切后，只有第一段保留列表标记，避免导出时每段都重复编号。
            kind: bufferKind === 'list-item' && pieceIndex > 0 ? 'paragraph' : bufferKind,
            level: bufferLevel,
            ...(bufferMarker && pieceIndex === 0 ? { marker: bufferMarker } : {}),
            page: bufferPage,
            contextPath: currentContext() || undefined,
          });
          index++;
        }
        bufferKind = 'paragraph';
        bufferLevel = undefined;
        bufferMarker = undefined;
      };

      for (const line of orderedLines) {
        const text = line.text.trim();
        if (!text) continue;
        const isHeading = isHeadingLine(line, medianHeight);
        const gap = previousLine ? previousLine.y - line.y : 0;
        const columnChanged = !!previousLine && previousLine.column !== line.column;
        const pageWideBoundary = line.column === -1 || previousLine?.column === -1;
        const previousWasHeading = !!previousLine && isHeadingLine(previousLine, medianHeight);
        // 新列表项开始时切段；普通续行继续附着到当前 item，不因为上一行有 marker 而被拆开。
        const listBoundary = !!extractListMarker(text);
        const newParagraph = !previousLine ||
          previousWasHeading ||
          listBoundary ||
          columnChanged ||
          pageWideBoundary ||
          gap > Math.max(medianPitch * 1.5, medianHeight * 1.8) ||
          (!!previousLine && endsSentence(previousLine.text) && gap > medianHeight * 0.95);

        if (isHeading || newParagraph) flush();

        if (isHeading) {
          const level = line.height > medianHeight * 1.65 ? 1 : 2;
          sectionTitles.length = Math.min(sectionTitles.length, level - 1);
          sectionTitles[level - 1] = text;
          bufferKind = 'heading';
          bufferLevel = level;
          if (page.pageNo === 1 && index === 0 && text.length < 100) title = text;
        } else if (bufferedLines.length === 0) {
          bufferKind = classifyLine(text);
          bufferLevel = undefined;
          bufferMarker = bufferKind === 'list-item' ? extractListMarker(text) : undefined;
        }
        if (bufferedLines.length === 0) bufferPage = page.pageNo;
        bufferedLines.push(bufferKind === 'list-item' && extractListMarker(text)
          ? { ...line, text: stripListMarker(text) }
          : line);
        previousLine = line;
      }
      flush();
      if (page.lines.reduce((sum, line) => sum + line.text.length, 0) < 80) shortTextPages++;
    }

    if (!segments.length) {
      warnings.push('未提取到文字；该 PDF 可能是扫描件，需要 OCR 后才能翻译');
    } else if (blankPages.length) {
      warnings.push(
        '第 ' + blankPages.slice(0, 8).join('、') + (blankPages.length > 8 ? ' 等' : '') +
        ' ' + blankPages.length + ' 页无可提取文字（可能是扫描页或空白页）',
      );
    }
    if (shortTextPages > 0 && segments.length > 0) {
      warnings.push(shortTextPages + ' 页提取到的文本较少，请检查这些页面是否为扫描页、图表页或文本层损坏的页面');
    }

    return {
      format: 'pdf',
      title,
      segments,
      meta: {
        charCount: segments.reduce((n, segment) => n + segment.text.length, 0),
        segmentCount: segments.length,
        warnings,
      },
    };
  } finally {
    // pdfjs v6 的 destroy() 属于 PDFDocumentLoadingTask，不属于 PDFDocumentProxy。
    await loadingTask.destroy();
  }
}
