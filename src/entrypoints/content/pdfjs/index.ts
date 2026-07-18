/**
 * PDF.js viewer 翻译模块。
 *
 * 背景：
 *   PDF.js 把 PDF 内容渲染为 `<canvas>` 位图（用户看到的文字是画布上的像素），
 *   `.textLayer span` 是不可见的文字选择层（color: transparent; position: absolute;
 *   transform: scaleX(...)），仅用于支持文字选中/复制。每个 span 通常只含一个词或
 *   短片段，位置被精确调整以对齐 canvas 上的字形。
 *
 *   因此普通 DOM 翻译（`applyBlockTranslation` 把原文包裹进 .fanyi-original，
 *   旁边插入 .fanyi-translation span）对 PDF.js 无效：
 *     1. .fanyi-translation span 继承 color: transparent，用户看不到
 *     2. 注入子 span 破坏原 span 的 transform 对齐，文字选择错位
 *     3. blockExtractor 的 INLINE_SET 分支要求 isInsideArticle，PDF.js 没有 <article>
 *        祖先，多数 span 会被 FILTER_SKIP，最多抓到工具栏 UI 文字
 *
 * 方案：
 *   1. 用 DOM 特征检测识别 PDF.js viewer（`#viewer.pdfViewer`），不靠 URL/host —
 *      同时覆盖 mozilla.github.io demo、Firefox 内置 PDF 查看器、其他站点自托管实例
 *   2. 从所有已渲染的 `.textLayer span` 收集文字，按视觉位置（top 坐标）分组为行，
 *      再按垂直间距/缩进启发式聚合成段落（保留上下文，提升翻译质量）
 *   3. 复用现有 `buildChunks()` 切分翻译块，通过 `browser.runtime.sendMessage`
 *      走 background → DeepSeek 路径（与普通翻译同一通道）
 *   4. 在每个段落下方渲染可见的 `div.fanyi-pdfjs-translation` 覆盖层
 *      （半透明白底 + 左侧蓝色边条 + pointer-events:none 不阻挡选择）
 *
 * 不处理（v1 范围外）：
 *   - 缩放后 textLayer 重建：用户重新点击翻译即可
 *   - 滚动到新页面时自动翻译：同上
 *   - 多栏 PDF 的栏检测：每段独立翻译，可能跨栏，但可读
 */
import browser from 'webextension-polyfill';
import { buildChunks, type Chunk } from '../../utils/chunkBuilder';
import type { TextBlock } from '../../utils/blockExtractor';
import type { TranslationState } from '../translationTypes';
import type {
  TranslateChunkMessage,
  TranslateChunkResponse,
  TranslationEntry,
} from '../../../types/messages';

import { logger } from '../../../utils/logger';

// ============================================================
// 检测
// ============================================================

/**
 * 检测当前文档是否是 PDF.js viewer。
 *
 * 信号优先级：
 *   1. `#viewer.pdfViewer` — PDF.js viewer 初始化时给 #viewer div 加 pdfViewer class，
 *      这是最可靠的信号，覆盖 mozilla.github.io demo 和 Firefox 内置查看器
 *   2. `#viewerContainer` + 存在 `.textLayer` — 兜底，处理变体或自托管实例
 *
 * 不依赖 URL/host：用户可能在任意域名托管 PDF.js，host-based 规则会漏。
 */
export function isPdfJsViewer(doc: Document): boolean {
  const viewer = doc.getElementById('viewer');
  if (viewer && viewer.classList.contains('pdfViewer')) return true;

  const container = doc.getElementById('viewerContainer');
  if (container && doc.querySelector('.textLayer') !== null) return true;

  return false;
}

/** 当前文档是否已被本模块翻译过（用于防止重复翻译 + restore 判定）。 */
export function isPdfJsTranslated(doc: Document): boolean {
  return doc.querySelector('.fanyi-pdfjs-translation') !== null;
}

// ============================================================
// 行收集 + 段落聚合
// ============================================================

/** 一个文本行：同一 .textLayer 内 top 坐标接近的 span 集合。 */
interface PdfLine {
  spans: HTMLElement[];
  text: string;
  textLayer: HTMLElement;
  page: HTMLElement;
  /** 行的边界（相对 .textLayer，单位 px） */
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 行高（bottom - top），用于段落聚合的间距判断 */
  height: number;
}

/** 一个段落：同一页内垂直间距小、缩进一致的连续行。 */
interface PdfParagraph {
  lines: PdfLine[];
  text: string;
  textLayer: HTMLElement;
  page: HTMLElement;
  left: number;
  top: number;
  right: number;
  bottom: number;
  /** 首行 font-size，用于覆盖层视觉一致 */
  fontSize: string;
}

/** top 坐标聚合容差（px）。同页内 top 差 ≤ 此值的 span 视为同一行。 */
const LINE_TOP_TOLERANCE_PX = 3;

/** 段落断行阈值：行间距 > 行高 × 此倍数时视为段落分隔。 */
const PARAGRAPH_GAP_RATIO = 1.5;

/** 段落缩进变化阈值（px）：左缩进变化超过此值视为新段落。 */
const PARAGRAPH_INDENT_PX = 30;

/** 跳过过短的行（少于 N 字符），避免抓到页码、装饰符号等噪声。 */
const MIN_LINE_CHARS = 2;

/**
 * 解析元素 style 上的 px 值（如 "12.3px" → 12.3）。
 * 失败返回 0。
 */
function parsePxValue(value: string | null): number {
  if (!value) return 0;
  const num = parseFloat(value);
  return Number.isFinite(num) ? num : 0;
}

/**
 * 获取 span 相对其 .textLayer 父级的位置和尺寸。
 *
 * 用 getBoundingClientRect 而非 style.left/top，因为不同 PDF.js 版本可能
 * 用 transform: translate 替代 left/top，getBoundingClientRect 统一处理。
 * textLayer 是 position:absolute; inset:0，其 rect 与 .page 相同，
 * 所以相对 textLayer 的坐标 = 相对 .page 的坐标。
 */
function getSpanRect(span: HTMLElement, textLayer: HTMLElement): {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
} {
  const spanRect = span.getBoundingClientRect();
  const layerRect = textLayer.getBoundingClientRect();
  return {
    left: spanRect.left - layerRect.left,
    top: spanRect.top - layerRect.top,
    right: spanRect.right - layerRect.left,
    bottom: spanRect.bottom - layerRect.top,
    width: spanRect.width,
    height: spanRect.height,
  };
}

/**
 * 找到 span 的 .textLayer 祖先（PDF.js 把 textLayer 放在 .page 下）。
 * 没找到返回 null，调用方应跳过该 span。
 */
function findTextLayer(span: HTMLElement): HTMLElement | null {
  let el: Element | null = span;
  while (el && el !== document.documentElement) {
    if (el instanceof HTMLElement && el.classList.contains('textLayer')) {
      return el;
    }
    el = el.parentElement;
  }
  return null;
}

/**
 * 找到 span 的 .page 祖先（用于按页分组 + 覆盖层定位参考）。
 * 没找到返回 textLayer 作为兜底（极端情况下不应该发生）。
 */
function findPage(span: HTMLElement, textLayer: HTMLElement): HTMLElement {
  let el: Element | null = textLayer.parentElement;
  while (el && el !== document.documentElement) {
    if (el instanceof HTMLElement && el.classList.contains('page')) {
      return el;
    }
    el = el.parentElement;
  }
  return textLayer;
}

/**
 * 从所有已渲染的 .textLayer 收集 span，按 (textLayer, top) 聚合成行。
 *
 * 算法（sort + merge，正确实现"top 差 ≤ 容差即同一行"的契约）：
 *   1. 查询 .textLayer span（含 .markedContent 子节点内的）
 *   2. 跳过无文本/无尺寸（display:none）的 span
 *   3. 按 (textLayer 所属 page 序, top) 排序
 *   4. 顺序扫描：同一 textLayer 内，若当前 span 的 top 与行首 span 的 top
 *      差 ≤ LINE_TOP_TOLERANCE_PX，并入当前行；否则开启新行
 *   5. 行内 span 按 left 排序，拼接文本
 *   6. 跳过过短的行
 *   7. 按 (page 序, top) 排序输出
 *
 * 注：之前用 `Math.round(top / tolerance)` 做桶哈希，但在桶边界处
 *   (如 top=10 入桶 3、top=12 入桶 4) 会把容差内的 span 拆到不同桶，
 *   违反"top 差 ≤ 容差即同行"的契约。sort + merge 没有这个问题。
 */
export function collectLines(doc: Document): PdfLine[] {
  const spans = Array.from(doc.querySelectorAll('.textLayer span')) as HTMLElement[];

  // 收集有效 span 的元数据
  interface SpanInfo {
    span: HTMLElement;
    textLayer: HTMLElement;
    page: HTMLElement;
    rect: { left: number; top: number; right: number; bottom: number; width: number; height: number };
    text: string;
  }
  const spanInfos: SpanInfo[] = [];
  for (const span of spans) {
    const text = (span.textContent || '').trim();
    if (text.length === 0) continue;
    const textLayer = findTextLayer(span);
    if (!textLayer) continue;
    const page = findPage(span, textLayer);
    const rect = getSpanRect(span, textLayer);
    if (rect.width === 0 || rect.height === 0) continue;
    spanInfos.push({ span, textLayer, page, rect, text });
  }

  // 按 (page 序, top) 排序 — 同一 textLayer 的 span 自然聚到一起
  const pageNumber = (el: HTMLElement): number => {
    const n = el.getAttribute('data-page-number');
    return n ? parseInt(n, 10) : 0;
  };
  spanInfos.sort((a, b) => {
    const pageDiff = pageNumber(a.page) - pageNumber(b.page);
    if (pageDiff !== 0) return pageDiff;
    // 同页内不同 textLayer 也按 textLayer 在 DOM 中的顺序（用 page 引用兜底）
    if (a.textLayer !== b.textLayer) {
      return 0; // 同页不同 textLayer 极少发生，保持原序
    }
    return a.rect.top - b.rect.top;
  });

  // 顺序扫描，按 (textLayer, top within tolerance) 聚合成行
  const lines: PdfLine[] = [];
  let currentGroup: SpanInfo[] = [];
  let anchorTop = NaN;
  let currentTextLayer: HTMLElement | null = null;

  const flushGroup = (): void => {
    if (currentGroup.length === 0) return;
    const textLayer = currentGroup[0].textLayer;
    // 行内按 left 排序
    currentGroup.sort((a, b) => a.rect.left - b.rect.left);
    // 计算行边界
    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const info of currentGroup) {
      left = Math.min(left, info.rect.left);
      top = Math.min(top, info.rect.top);
      right = Math.max(right, info.rect.right);
      bottom = Math.max(bottom, info.rect.bottom);
    }
    const text = currentGroup
      .map((s) => s.text)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text.length >= MIN_LINE_CHARS) {
      lines.push({
        spans: currentGroup.map((s) => s.span),
        text,
        textLayer,
        page: currentGroup[0].page,
        left,
        top,
        right,
        bottom,
        height: bottom - top,
      });
    }
    currentGroup = [];
  };

  for (const info of spanInfos) {
    const newLine =
      currentTextLayer !== info.textLayer ||
      !Number.isNaN(anchorTop) && Math.abs(info.rect.top - anchorTop) > LINE_TOP_TOLERANCE_PX;
    if (newLine) {
      flushGroup();
      anchorTop = info.rect.top;
      currentTextLayer = info.textLayer;
    }
    currentGroup.push(info);
  }
  flushGroup();

  // 最终按 (page 序, top) 排序输出（sort + merge 已经基本有序，这里兜底）
  lines.sort((a, b) => {
    const pageDiff = pageNumber(a.page) - pageNumber(b.page);
    if (pageDiff !== 0) return pageDiff;
    return a.top - b.top;
  });

  return lines;
}

/**
 * 把连续行聚合成段落。
 *
 * 启发式：同一页内，若当前行与前一行满足以下任一条件，则视为新段落开始：
 *   1. 行间距 > 前段平均行高 × PARAGRAPH_GAP_RATIO（明显垂直空隙）
 *   2. 左缩进变化 > PARAGRAPH_INDENT_PX（缩进/凸出，典型如列表项、新段落首行缩进）
 *   3. 前行文本以句末标点结尾（. ! ? 。！？）
 *
 * 否则当前行并入当前段落。
 */
export function groupLinesIntoParagraphs(lines: PdfLine[]): PdfParagraph[] {
  const paragraphs: PdfParagraph[] = [];
  let current: PdfParagraph | null = null;

  const sentenceEndRe = /[.!?。！？]\s*$/;

  for (const line of lines) {
    if (!current) {
      current = makeParagraph(line);
      continue;
    }

    const samePage = line.page === current.page;
    const gap = line.top - current.bottom;
    const avgLineHeight = current.lines.length > 0
      ? current.lines.reduce((sum, l) => sum + l.height, 0) / current.lines.length
      : line.height;
    const largeGap = gap > avgLineHeight * PARAGRAPH_GAP_RATIO;
    const indentChange = Math.abs(line.left - current.left) > PARAGRAPH_INDENT_PX;
    const prevEndedSentence = sentenceEndRe.test(current.lines[current.lines.length - 1].text);

    if (samePage && !largeGap && !indentChange && !prevEndedSentence) {
      current.lines.push(line);
      current.bottom = line.bottom;
      current.left = Math.min(current.left, line.left);
      current.right = Math.max(current.right, line.right);
      // 段落文本在最后统一拼接
      current.text = '';
    } else {
      finalizeParagraphText(current);
      paragraphs.push(current);
      current = makeParagraph(line);
    }
  }

  if (current) {
    finalizeParagraphText(current);
    paragraphs.push(current);
  }

  return paragraphs;
}

function makeParagraph(line: PdfLine): PdfParagraph {
  return {
    lines: [line],
    text: '',
    textLayer: line.textLayer,
    page: line.page,
    left: line.left,
    top: line.top,
    right: line.right,
    bottom: line.bottom,
    fontSize: getSpanFontSize(line.spans[0]),
  };
}

function finalizeParagraphText(para: PdfParagraph): void {
  para.text = para.lines
    .map((l) => l.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 读取 span 的 font-size（含 inline style 和 computed style 兜底）。 */
function getSpanFontSize(span: HTMLElement): string {
  const inline = span.style.fontSize;
  if (inline) return inline;
  try {
    return window.getComputedStyle(span).fontSize;
  } catch {
    return '14px';
  }
}

// ============================================================
// 翻译调度
// ============================================================

/** 并行度：同时发送的 chunk 数（与 translateChunksViaBackground 桌面端一致）。 */
const TRANSLATE_CONCURRENCY = 4;

/**
 * 并行发送多个 chunk 到 background 翻译，返回 lineId → 译文 的映射。
 *
 * 不复用 `translateChunksViaBackground`：那个函数把译文直接写回 DOM
 * （`applyBlockTranslation` 注入 .fanyi-original / .fanyi-translation span），
 * 对 PDF.js 透明 span 无效。这里只收集译文，由 `renderOverlay` 负责渲染。
 */
async function translateParagraphs(
  chunks: Chunk[],
  sourceLang: string,
  targetLang: string,
  pageUrl: string,
  onProgress?: (current: number, total: number) => void,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  if (chunks.length === 0) return results;

  let completed = 0;
  for (let i = 0; i < chunks.length; i += TRANSLATE_CONCURRENCY) {
    const batch = chunks.slice(i, i + TRANSLATE_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((chunk) => translateOneChunk(chunk, sourceLang, targetLang, pageUrl)),
    );
    for (const resultMap of batchResults) {
      for (const [id, text] of resultMap) {
        results.set(id, text);
      }
      completed++;
      onProgress?.(completed, chunks.length);
    }
  }
  return results;
}

/** 发送单个 chunk 到 background，解析响应返回 blockId → 译文。 */
async function translateOneChunk(
  chunk: Chunk,
  sourceLang: string,
  targetLang: string,
  pageUrl: string,
): Promise<Map<string, string>> {
  const message: TranslateChunkMessage = {
    action: 'translateChunk',
    jsonContent: chunk.jsonContent,
    sourceLang,
    targetLang,
    pageUrl,
  };
  try {
    const response = (await browser.runtime.sendMessage(message)) as TranslateChunkResponse;
    if (!response.success) {
      logger.warn(`[PdfJs] chunk ${chunk.id} translation failed:`, response.error);
      return new Map();
    }
    const map = new Map<string, string>();
    for (const entry of response.result as TranslationEntry[]) {
      if (Array.isArray(entry) && entry.length === 2 && typeof entry[1] === 'string') {
        map.set(entry[0], entry[1]);
      }
    }
    return map;
  } catch (err) {
    logger.error(`[PdfJs] chunk ${chunk.id} threw:`, err);
    return new Map();
  }
}

// ============================================================
// 覆盖层渲染
// ============================================================

/**
 * 在段落下方渲染可见译文覆盖层。
 *
 * 定位：
 *   - left: para.left（与段落左对齐）
 *   - top: para.bottom + 2px（紧贴段落下方，2px 视觉间隔）
 *   - max-width: page 右边界 - para.left（避免溢出页面）
 *
 * 样式：
 *   - color: 蓝色（#1a73e8），与原文（canvas 黑色）形成对比
 *   - background: 半透明白底（rgba(255,255,255,0.9)），保证在 canvas 上可读
 *   - border-left: 2px 蓝色边条，视觉提示"这是译文"
 *   - pointer-events: none，不阻挡文字选择
 *   - white-space: normal，允许长译文换行
 *
 * 挂载到 .textLayer（与 span 同父级，坐标系一致）。
 */
function renderOverlay(para: PdfParagraph, translatedText: string): HTMLElement {
  const overlay = document.createElement('div');
  overlay.className = 'fanyi-pdfjs-translation';
  overlay.textContent = translatedText;

  // 定位
  overlay.style.position = 'absolute';
  overlay.style.left = `${para.left}px`;
  overlay.style.top = `${para.bottom + 2}px`;

  // 限制宽度避免溢出页面右侧
  const pageRect = para.page.getBoundingClientRect();
  const layerRect = para.textLayer.getBoundingClientRect();
  const pageWidth = pageRect.width;
  const maxWidth = pageWidth - para.left;
  overlay.style.maxWidth = `${Math.max(100, maxWidth)}px`;

  // 视觉样式（CSS 类已定义基础样式，这里补 inline 以防 CSS 未加载）
  overlay.style.color = '#1a73e8';
  overlay.style.background = 'rgba(255, 255, 255, 0.9)';
  overlay.style.borderLeft = '2px solid #1a73e8';
  overlay.style.padding = '1px 6px';
  overlay.style.borderRadius = '2px';
  overlay.style.fontSize = para.fontSize;
  overlay.style.lineHeight = '1.3';
  overlay.style.whiteSpace = 'normal';
  overlay.style.wordBreak = 'break-word';
  overlay.style.pointerEvents = 'none';
  overlay.style.zIndex = '1';
  overlay.style.boxSizing = 'border-box';

  para.textLayer.appendChild(overlay);
  return overlay;
}

/** 给段落的所有 span 打上 data-fanyi-pdfjs-line 标记，便于调试和 restore。 */
function tagParagraphSpans(para: PdfParagraph, paraId: string): void {
  for (const line of para.lines) {
    for (const span of line.spans) {
      span.dataset.fanyiPdfjsLine = paraId;
    }
  }
}

/** 清除所有 span 上的 data-fanyi-pdfjs-line 标记。 */
function clearSpanTags(doc: Document): void {
  const tagged = doc.querySelectorAll('[data-fanyi-pdfjs-line]');
  for (const el of Array.from(tagged)) {
    (el as HTMLElement).removeAttribute('data-fanyi-pdfjs-line');
  }
}

// ============================================================
// 公共 API
// ============================================================

export interface PdfJsTranslationResult {
  translated: boolean;
  /** 翻译的段落数 */
  paragraphCount: number;
  /** 跳过的段落数（过短/无文本） */
  skippedCount: number;
}

/**
 * 翻译 PDF.js viewer 的已渲染页面。
 *
 * 流程：
 *   1. collectLines: 从 .textLayer span 聚合成行
 *   2. groupLinesIntoParagraphs: 按垂直间距/缩进聚合成段落
 *   3. buildChunks: 切分翻译块（复用现有逻辑）
 *   4. translateParagraphs: 并行发送到 background 翻译
 *   5. renderOverlay: 在每段下方渲染可见译文
 *   6. 标记 body.dataset.fanyiTranslated，保存 state 用于 restore
 *
 * @param config 用户配置（sourceLang/targetLang/provider/deepseekApiKey 等）
 * @param state 翻译状态（用于保存 originalTexts/translatedTexts 供 restore）
 * @param onStatus 状态提示回调（msg, type）
 */
export async function translatePdfJsViewer(
  config: { sourceLang: string; targetLang: string; useServerTranslation?: boolean; provider?: string; deepseekApiKey?: string },
  state: TranslationState,
  onStatus: (msg: string, type: 'loading' | 'success' | 'error') => void,
): Promise<PdfJsTranslationResult> {
  onStatus('正在提取 PDF 文本...', 'loading');

  const lines = collectLines(document);
  if (lines.length === 0) {
    throw new Error('PDF.js viewer 中没有已渲染的文字。请滚动到要翻译的页面后重试。');
  }

  const paragraphs = groupLinesIntoParagraphs(lines);
  // 跳过过短段落（< 3 字符），避免抓到页码、装饰符号
  const translatable = paragraphs.filter((p) => p.text.length >= 3);
  const skippedCount = paragraphs.length - translatable.length;

  if (translatable.length === 0) {
    throw new Error('PDF.js viewer 中没有可翻译的段落。');
  }

  onStatus(`共 ${translatable.length} 段，正在翻译...`, 'loading');

  // 构建 TextBlock（每段一个）
  const blocks: TextBlock[] = translatable.map((para, i) => {
    const id = `pdfjs-p${i}`;
    tagParagraphSpans(para, id);
    // 保存原文映射，用于 restore
    state.originalTexts.set(id, para.text);
    return {
      id,
      xpath: '',
      tag: 'div',
      text: para.text,
      context: { headingPath: [], position: i },
    };
  });

  const chunks = buildChunks(blocks);
  logger.debug(
    `[PdfJs] ${lines.length} lines → ${paragraphs.length} paragraphs (${translatable.length} translatable, ${skippedCount} skipped) → ${chunks.length} chunks`,
  );

  const translations = await translateParagraphs(
    chunks,
    config.sourceLang,
    config.targetLang,
    window.location.href,
    (current, total) => onStatus(`PDF 翻译进度: ${current}/${total}`, 'loading'),
  );

  // 渲染覆盖层
  let renderedCount = 0;
  for (const block of blocks) {
    const translated = translations.get(block.id);
    if (!translated) continue;
    const para = translatable[parseInt(block.id.replace('pdfjs-p', ''), 10)];
    if (!para) continue;
    renderOverlay(para, translated);
    state.translatedTexts.set(block.id, translated);
    state.translatedBlocks.add(block.id);
    renderedCount++;
  }

  if (document.body) {
    document.body.dataset.fanyiTranslated = 'true';
  }

  logger.debug(
    `[PdfJs] Translation complete: ${renderedCount}/${translatable.length} paragraphs rendered`,
  );

  return {
    translated: renderedCount > 0,
    paragraphCount: renderedCount,
    skippedCount,
  };
}

/**
 * 恢复 PDF.js viewer 原文：移除所有覆盖层，清除 span 标记。
 *
 * 不需要恢复 span 文本——原文 span 始终未被修改（只读取 textContent），
 * 覆盖层是独立 div，直接删除即可。
 */
export function restorePdfJsViewer(doc: Document): void {
  const overlays = doc.querySelectorAll('.fanyi-pdfjs-translation');
  for (const el of Array.from(overlays)) {
    el.remove();
  }
  clearSpanTags(doc);
  if (doc.body) {
    delete doc.body.dataset.fanyiTranslated;
  }
}

/**
 * 切换 PDF.js 译文显示/隐藏。
 *
 * 通过切换覆盖层的 display 属性实现。与 `toggleBlockTranslation` 不同，
 * PDF.js 的译文是独立 div（不是 span 的子元素），直接 toggle display 即可。
 */
export function togglePdfJsViewer(doc: Document): void {
  const overlays = doc.querySelectorAll('.fanyi-pdfjs-translation');
  for (const el of Array.from(overlays)) {
    const htmlEl = el as HTMLElement;
    htmlEl.style.display = htmlEl.style.display === 'none' ? '' : 'none';
  }
}
