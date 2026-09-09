// 用 legacy 构建：modern 构建依赖 Promise.withResolvers 等较新 API，
// 在 Firefox ESR / 旧版上会直接崩；legacy 额外带 core-js polyfill，兼容性更好。
// 代价是体积略大，但只在文档翻译页动态加载，不影响 popup / sidepanel。
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import type { DocumentSegment, ParsedDocument, SegmentKind } from '../types';
import { DEFAULT_MAX_SEGMENT_CHARS, splitLongText } from './text';

/**
 * pdfjs 的类型导出在不同版本间漂移过（TextItem 一度要从
 * `pdfjs-dist/types/src/display/api` 单独引），这里自己声明最小结构，
 * 避免升级 pdfjs 时类型报错 —— 我们只用到 str / transform / height 三个字段。
 */
interface PdfTextItem {
  str: string;
  transform: number[];
  height: number;
}

/**
 * PDF 解析（pdfjs-dist）。
 *
 * PDF 没有"段落"概念，只有带坐标的文字碎片（text atom）。
 * 所以要做两件还原：
 *   1. 按 y 坐标聚成行（同一行的碎片 y 相同 / 相近）
 *   2. 按行间距聚成段（间距明显变大 = 换段；字号明显变大 = 标题）
 * 质量取决于 PDF 本身：矢量文字效果好，扫描件（纯图片）提取不到任何文字，
 * 这种情况明确给出 warning，而不是静默返回空。
 */

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export interface ParsePdfOptions {
  maxSegmentChars?: number;
  fileName?: string;
  /** 最多解析页数，防超大 PDF 卡死。默认 300。 */
  maxPages?: number;
  onProgress?: (done: number, total: number) => void;
}

interface Line {
  y: number;
  height: number;
  text: string;
}

/** 同一行的判定容差：字号的一半。 */
function groupIntoLines(items: PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  const sorted = [...items].sort((a, b) => b.transform[5] - a.transform[5] || a.transform[4] - b.transform[4]);

  for (const item of sorted) {
    const y = item.transform[5];
    const height = item.height || Math.abs(item.transform[3]) || 10;
    const current = lines[lines.length - 1];
    if (current && Math.abs(current.y - y) <= Math.max(height, current.height) * 0.5) {
      current.text += item.str;
    } else {
      lines.push({ y, height, text: item.str });
    }
  }
  return lines;
}

function isTextItem(item: unknown): item is PdfTextItem {
  return typeof item === 'object' && item !== null && typeof (item as PdfTextItem).str === 'string';
}

export async function parsePdfDocument(
  arrayBuffer: ArrayBuffer,
  options: ParsePdfOptions = {},
): Promise<ParsedDocument> {
  const max = options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS;
  const maxPages = options.maxPages ?? 300;
  const warnings: string[] = [];
  const segments: DocumentSegment[] = [];
  let index = 0;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const total = Math.min(doc.numPages, maxPages);
  if (doc.numPages > maxPages) {
    warnings.push(`文档共 ${doc.numPages} 页，本次只解析前 ${maxPages} 页`);
  }

  let title = (options.fileName ?? '').replace(/\.[^.]+$/, '') || '文档';
  const blankPages: number[] = [];

  for (let pageNo = 1; pageNo <= total; pageNo++) {
    const page = await doc.getPage(pageNo);
    const content = await page.getTextContent();
    const items = content.items.filter(isTextItem).filter((item) => item.str.trim());
    if (!items.length) {
      blankPages.push(pageNo);
      options.onProgress?.(pageNo, total);
      continue;
    }

    const lines = groupIntoLines(items).filter((line) => line.text.trim());
    // 行高取中位数，抗噪（页眉页脚字号突兀时不影响判定）
    const heights = lines.map((l) => l.height).sort((a, b) => a - b);
    const medianHeight = heights[Math.floor(heights.length / 2)] ?? 10;

    let buffer: string[] = [];
    let bufferKind: SegmentKind = 'paragraph';
    let bufferLevel: number | undefined;
    let prevBottom: number | null = null;

    const flush = () => {
      const text = buffer.join('').replace(/[ \t]+/g, ' ').trim();
      buffer = [];
      if (!text) return;
      for (const piece of splitLongText(text, max)) {
        segments.push({ id: `s${index}`, index, text: piece, kind: bufferKind, level: bufferLevel });
        index++;
      }
      bufferKind = 'paragraph';
      bufferLevel = undefined;
    };

    for (const line of lines) {
      const text = line.text.replace(/\s+$/, '').trim();
      if (!text) continue;

      const isHeading = line.height > medianHeight * 1.15 && text.length < 120;
      const gap = prevBottom != null ? prevBottom - line.y : 0;
      const newParagraph = prevBottom === null || gap > medianHeight * 1.4;

      if (isHeading || newParagraph) flush();

      if (isHeading) {
        bufferKind = 'heading';
        bufferLevel = line.height > medianHeight * 1.6 ? 1 : 2;
        // 第一页第一个大字号文本当作文档标题
        if (pageNo === 1 && index === 0 && text.length < 100) title = text;
      }
      buffer.push(text);
      prevBottom = line.y;
    }
    flush();
    options.onProgress?.(pageNo, total);
  }

  await doc.destroy();

  if (!segments.length) {
    warnings.push('未提取到文字，该 PDF 可能是扫描件（图片型），需要 OCR 才能翻译');
  } else if (blankPages.length) {
    const preview = blankPages.slice(0, 5).join('、');
    warnings.push(
      `第 ${preview}${blankPages.length > 5 ? ' 等' : ''} ${blankPages.length} 页无可提取文字（可能是图片或空白）`,
    );
  }

  return {
    format: 'pdf',
    title,
    segments,
    meta: {
      charCount: segments.reduce((n, s) => n + s.text.length, 0),
      segmentCount: segments.length,
      warnings,
    },
  };
}
