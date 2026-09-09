import JSZip from 'jszip';
import type { DocumentSegment, ParsedDocument, SegmentKind } from '../types';
import { DEFAULT_MAX_SEGMENT_CHARS, splitLongText } from './text';
import { decodeEntities, parseHtmlDocument } from './html';

/**
 * DOCX / EPUB 解析。
 *
 * 两者本质都是 ZIP + XML，所以共用 jszip（~100KB），不引入 mammoth / epub.js
 * 这类重型库 —— 我们要的是"文本 + 块级结构"，不是完整渲染。
 */

/** DOCX 段落属性 → 语义。 */
const HEADING_STYLE_RE = /heading\s*(\d)/i;

function decodeXmlText(xml: string): string {
  return decodeEntities(
    xml
      .replace(/<w:tab\b[^>]*\/>/g, '\t')
      .replace(/<w:br\b[^>]*\/>/g, '\n')
      .replace(/<[^>]+>/g, ''),
  );
}

function pushSegments(
  out: DocumentSegment[],
  startIndex: number,
  text: string,
  kind: SegmentKind,
  max: number,
  level?: number,
  path?: string,
): number {
  let index = startIndex;
  const trimmed = text.replace(/[ \t]+/g, ' ').trim();
  if (!trimmed) return index;
  for (const piece of splitLongText(trimmed, max)) {
    out.push({ id: `s${index}`, index, text: piece, kind, level, path });
    index++;
  }
  return index;
}

export interface ParseOfficeOptions {
  maxSegmentChars?: number;
  fileName?: string;
}

/** DOCX：按 w:p 切块，从 pStyle / outlineLvl 识别标题层级与列表。 */
export async function parseDocxDocument(
  arrayBuffer: ArrayBuffer,
  options: ParseOfficeOptions = {},
): Promise<ParsedDocument> {
  const max = options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS;
  const warnings: string[] = [];
  const zip = await JSZip.loadAsync(arrayBuffer);

  const docFile = zip.file('word/document.xml');
  if (!docFile) {
    return emptyResult('docx', options.fileName, ['不是有效的 DOCX 文件：缺少 word/document.xml']);
  }
  const xml = await docFile.async('string');

  let title = '';
  const coreFile = zip.file('docProps/core.xml');
  if (coreFile) {
    const core = await coreFile.async('string');
    title = (/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(core)?.[1] ?? '').trim();
  }

  const segments: DocumentSegment[] = [];
  let index = 0;
  const paragraphRe = /<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g;
  let m: RegExpExecArray | null;

  while ((m = paragraphRe.exec(xml)) !== null) {
    const block = m[1] as string;
    const text = decodeXmlText(block);
    if (!text.trim()) continue;

    let kind: SegmentKind = 'paragraph';
    let level: number | undefined;

    const styleVal = /w:pStyle\s+w:val="([^"]+)"/.exec(block)?.[1] ?? '';
    const headingByStyle = HEADING_STYLE_RE.exec(styleVal);
    if (headingByStyle) {
      kind = 'heading';
      level = Number(headingByStyle[1]);
    } else {
      const outline = /w:outlineLvl\s+w:val="(\d)"/.exec(block)?.[1];
      if (outline !== undefined && outline !== '9') {
        kind = 'heading';
        level = Math.min(Number(outline) + 1, 6);
      }
    }
    if (kind === 'paragraph' && /<w:numPr\b/.test(block)) kind = 'list-item';

    index = pushSegments(segments, index, text, kind, max, level);
  }

  // 表格里的文字在上面的 w:p 扫描里会被漏掉（w:tbl 内嵌 w:p 其实会被匹配到，
  // 这里兜底：完全没有段落时再扫一遍全文，避免整篇是表格的文档空结果）
  if (!segments.length) {
    const all = decodeXmlText(xml.replace(/<w:tbl\b/g, '\n<w:tbl'));
    index = pushSegments(segments, index, all, 'paragraph', max);
    if (segments.length) warnings.push('文档以表格为主，已按顺序提取文字');
  }
  if (!segments.length) warnings.push('未从 DOCX 中提取到文本，可能是图片型文档');

  return {
    format: 'docx',
    title: title || (options.fileName ?? '').replace(/\.[^.]+$/, '') || '文档',
    segments,
    meta: {
      charCount: segments.reduce((n, s) => n + s.text.length, 0),
      segmentCount: segments.length,
      warnings,
    },
  };
}

function emptyResult(
  format: 'docx' | 'epub',
  fileName: string | undefined,
  warnings: string[],
): ParsedDocument {
  return {
    format,
    title: (fileName ?? '').replace(/\.[^.]+$/, '') || '文档',
    segments: [],
    meta: { charCount: 0, segmentCount: 0, warnings },
  };
}

/** 取 OPF 所在目录，用于解析相对路径。 */
function dirOf(path: string): string {
  const at = path.lastIndexOf('/');
  return at >= 0 ? path.slice(0, at + 1) : '';
}

function resolvePath(base: string, relative: string): string {
  if (relative.startsWith('/')) return relative.slice(1);
  const stack = base.split('/').filter(Boolean);
  for (const part of relative.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  return stack.join('/');
}

/** EPUB：container.xml → OPF → spine 顺序逐章解析，保证阅读顺序正确。 */
export async function parseEpubDocument(
  arrayBuffer: ArrayBuffer,
  options: ParseOfficeOptions = {},
): Promise<ParsedDocument> {
  const max = options.maxSegmentChars ?? DEFAULT_MAX_SEGMENT_CHARS;
  const warnings: string[] = [];
  const zip = await JSZip.loadAsync(arrayBuffer);

  const container = zip.file('META-INF/container.xml');
  if (!container) return emptyResult('epub', options.fileName, ['不是有效的 EPUB 文件：缺少 META-INF/container.xml']);

  const containerXml = await container.async('string');
  const opfPath = /<rootfile[^>]+full-path="([^"]+)"/.exec(containerXml)?.[1];
  if (!opfPath) return emptyResult('epub', options.fileName, ['EPUB container.xml 中未找到 rootfile']);

  const opfFile = zip.file(opfPath);
  if (!opfFile) return emptyResult('epub', options.fileName, [`EPUB 缺少 ${opfPath}`]);
  const opfXml = await opfFile.async('string');
  const opfDir = dirOf(opfPath);

  let title = (/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/.exec(opfXml)?.[1] ?? '').trim();

  const manifest = new Map<string, string>();
  const manifestRe = /<item\b[^>]*>/g;
  let mm: RegExpExecArray | null;
  while ((mm = manifestRe.exec(opfXml)) !== null) {
    const tag = mm[0];
    const id = /\bid="([^"]+)"/.exec(tag)?.[1];
    const href = /\bhref="([^"]+)"/.exec(tag)?.[1];
    if (id && href) manifest.set(id, href);
  }

  const spineIds = [...opfXml.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)]
    .map((match) => match[1] as string)
    .filter((id) => manifest.has(id));

  // spine 为空（部分 EPUB 不写 spine）时退化为"所有 XHTML 按文件名排序"
  const chapters = spineIds.length
    ? spineIds.map((id) => manifest.get(id) as string)
    : [...manifest.values()].filter((h) => /\.(x?html|xml)$/i.test(h)).sort();

  const segments: DocumentSegment[] = [];
  let index = 0;

  for (const href of chapters) {
    const fullPath = decodeURIComponent(resolvePath(opfDir, href));
    const file = zip.file(fullPath) ?? zip.file(href);
    if (!file) continue;
    const html = await file.async('string');
    const chapter = parseHtmlDocument(html, { maxSegmentChars: max, fileName: href });
    if (!chapter.segments.length) continue;

    // 章节标题：优先用本章第一个 heading，其次用文件名
    if (!index && !title) title = chapter.segments[0]?.text.slice(0, 60) ?? '';

    for (const segment of chapter.segments) {
      segments.push({ ...segment, id: `s${index}`, index, path: fullPath });
      index++;
    }
  }

  if (!segments.length) warnings.push('未从 EPUB 中提取到正文');

  return {
    format: 'epub',
    title: title || (options.fileName ?? '').replace(/\.[^.]+$/, '') || '文档',
    segments,
    meta: {
      charCount: segments.reduce((n, s) => n + s.text.length, 0),
      segmentCount: segments.length,
      warnings,
    },
  };
}
