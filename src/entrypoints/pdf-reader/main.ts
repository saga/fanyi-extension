import browser from 'webextension-polyfill';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { getConfig } from '../utils/config';
import { detectLanguage } from '../utils/languageDetector';
import type { TranslateChunkMessage, TranslateChunkResponse } from '../../types/messages';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Paragraph = { id: string; text: string; page: number; heading: boolean; translated?: string };
type PdfTextItem = { str: string; transform: number[]; width: number; height: number; hasEOL?: boolean };

const params = new URLSearchParams(location.search);
const sourceUrl = params.get('url') || '';
const titleNode = document.querySelector<HTMLElement>('#source-title')!;
const statusNode = document.querySelector<HTMLElement>('#status')!;
const paperNode = document.querySelector<HTMLElement>('#paper')!;
const translateButton = document.querySelector<HTMLButtonElement>('#translate')!;
const modeButton = document.querySelector<HTMLButtonElement>('#mode-toggle')!;
let paragraphs: Paragraph[] = [];
let translationOnly = false;
let translated = false;

function status(message: string, error = false): void {
  statusNode.textContent = message;
  statusNode.classList.toggle('error', error);
}

function isArxivPdfUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(^|\.)arxiv\.org$/i.test(url.hostname) && /^\/pdf\//.test(url.pathname);
  } catch { return false; }
}

function isLikelyMath(text: string): boolean {
  const compact = text.replace(/\s/g, '');
  if (compact.length < 3) return false;
  const symbols = (compact.match(/[=<>±×÷∑∏∫√∞∂∇∈∉⊂⊃≤≥≠≈→←↔∀∃λμσθαβγδπΩℝℤℕ∝∼∩∪]/g) || []).length;
  return symbols >= 2 || (/[=<>]/.test(compact) && /[_^{}]/.test(compact));
}

function normalizeLine(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/\u00ad/g, '').trim();
}

function splitColumns(items: PdfTextItem[], pageWidth: number): PdfTextItem[][] {
  const xs = items.map(item => item.transform[4]).filter(Number.isFinite).sort((a,b)=>a-b);
  if (xs.length < 20) return [items];
  let bestGap = 0;
  let splitX = 0;
  for (let i=1;i<xs.length;i++) {
    const gap = xs[i]! - xs[i-1]!;
    if (gap > bestGap) { bestGap = gap; splitX = (xs[i]! + xs[i-1]!)/2; }
  }
  if (bestGap < pageWidth * 0.075 || splitX < pageWidth * 0.3 || splitX > pageWidth * 0.7) return [items];
  const left = items.filter(item => item.transform[4] < splitX);
  const right = items.filter(item => item.transform[4] >= splitX);
  if (left.length < 8 || right.length < 8) return [items];
  return [left, right];
}

function itemsToLines(items: PdfTextItem[]): string[] {
  const sorted = [...items].sort((a,b) => {
    const ay = a.transform[5], by = b.transform[5];
    return Math.abs(ay-by) > 2 ? by-ay : a.transform[4]-b.transform[4];
  });
  const lines: Array<{ y:number; parts:PdfTextItem[] }> = [];
  for (const item of sorted) {
    if (!item.str?.trim()) continue;
    const y = item.transform[5];
    let line = lines.find(candidate => Math.abs(candidate.y-y) <= 2.5);
    if (!line) { line = {y,parts:[]}; lines.push(line); }
    line.parts.push(item);
  }
  return lines.sort((a,b)=>b.y-a.y).map(line =>
    normalizeLine(line.parts.sort((a,b)=>a.transform[4]-b.transform[4]).map(item=>item.str).join(' '))
  ).filter(Boolean);
}

function linesToParagraphs(lines: string[], page: number): Paragraph[] {
  const result: Paragraph[] = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = normalizeLine(buffer.join(' '));
    buffer = [];
    if (text.length < 18 || isLikelyMath(text)) {
      if (text.length >= 4) result.push({id:'p'+page+'-'+result.length,text,page,heading:false});
      return;
    }
    const heading = text.length < 115 && !/[.!?;:,]$/.test(text) &&
      (/^(\d+(\.\d+)*\s+)?[A-Z][A-Za-z0-9 ,:()/-]{2,}$/.test(text) || text === text.toUpperCase());
    result.push({id:'p'+page+'-'+result.length,text,page,heading});
  };
  for (const line of lines) {
    if (!line) continue;
    if (buffer.length && /[.!?:;)]$/.test(buffer[buffer.length-1]!) && line.length > 35) flush();
    buffer.push(line);
    if (line.length < 100 && /^(\d+(\.\d+)*\s+)?[A-Z][A-Za-z0-9 ,:()/-]{2,}$/.test(line)) flush();
  }
  if (buffer.length) flush();
  return result;
}

async function extractPdf(url: string): Promise<void> {
  if (!isArxivPdfUrl(url)) throw new Error('当前版本仅支持 arXiv 论文 PDF 地址（arxiv.org/pdf/...）。');
  status('正在下载并解析论文…');
  const loadingTask = pdfjs.getDocument({url, withCredentials:false});
  try {
    const pdf = await loadingTask.promise;
    titleNode.textContent = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'arXiv paper');
    const all: Paragraph[] = [];
    for (let pageNo=1; pageNo<=pdf.numPages; pageNo++) {
      status('正在提取 PDF：第 '+pageNo+' / '+pdf.numPages+' 页');
      const page = await pdf.getPage(pageNo);
      const viewport = page.getViewport({scale:1});
      const content = await page.getTextContent();
      const items = content.items.filter(item =>
        typeof (item as PdfTextItem).str === 'string' && !!(item as PdfTextItem).str.trim()
      ) as unknown as PdfTextItem[];
      const columns = splitColumns(items, viewport.width);
      const pageParagraphs = columns.flatMap(column =>
        linesToParagraphs(itemsToLines(column), pageNo)
      );
      all.push(...pageParagraphs);
      page.cleanup();
    }
    await pdf.cleanup();
    paragraphs = all.filter(item => item.text.length >= 4);
    if (!paragraphs.length) throw new Error('PDF 没有可提取的文本；扫描版/OCR PDF 暂不支持。');
    renderPaper();
    status('已提取 '+paragraphs.length+' 个文本段落，共 '+pdf.numPages+' 页，开始翻译…');
    void translateAll();
  } finally {
    await loadingTask.destroy();
  }
}

function renderPaper(): void {
  paperNode.replaceChildren();
  const heading = document.createElement('h1');
  heading.className = 'paper-title';
  heading.textContent = titleNode.textContent || 'arXiv paper';
  paperNode.append(heading);
  const meta = document.createElement('div');
  meta.className = 'paper-meta';
  meta.textContent = sourceUrl;
  paperNode.append(meta);
  let currentSection: HTMLElement | null = null;
  for (const paragraph of paragraphs) {
    if (paragraph.heading) {
      currentSection = document.createElement('section');
      const h = document.createElement('h2');
      h.className = 'original';
      h.textContent = paragraph.text;
      h.classList.toggle('hidden', translationOnly);
      const translatedHeading = document.createElement('div');
      translatedHeading.className = 'translation';
      translatedHeading.textContent = paragraph.translated || '';
      translatedHeading.classList.toggle('hidden', !paragraph.translated);
      currentSection.append(h, translatedHeading);
      paperNode.append(currentSection);
      continue;
    }
    if (!currentSection) {
      currentSection = document.createElement('section');
      paperNode.append(currentSection);
    }
    const block = document.createElement('div');
    block.className = 'block';
    block.dataset.paragraphId = paragraph.id;
    const original = document.createElement('p');
    original.className = 'original';
    original.textContent = paragraph.text;
    const translation = document.createElement('p');
    translation.className = 'translation';
    translation.textContent = paragraph.translated || '';
    translation.classList.toggle('hidden', !paragraph.translated);
    original.classList.toggle('hidden', translationOnly);
    block.append(original, translation);
    currentSection.append(block);
  }
}

async function translateAll(): Promise<void> {
  if (!paragraphs.length || translated) return;
  translateButton.disabled = true;
  try {
    const config = await getConfig();
    const detected = detectLanguage(paragraphs.slice(0,12).map(p=>p.text).join('\\n'));
    const sourceLang = config.sourceLang === 'auto'
      ? (detected.language === 'unknown' ? 'en' : detected.language)
      : config.sourceLang;
    const targetLang = config.targetLang || 'zh';
    const eligible = paragraphs.filter(p => !isLikelyMath(p.text) && p.text.length >= (p.heading ? 4 : 18));
    const batchSize = 8;
    let done = 0;
    for (let offset=0; offset<eligible.length; offset+=batchSize) {
      const batch = eligible.slice(offset, offset+batchSize);
      const message: TranslateChunkMessage = {
        action:'translateChunk',
        jsonContent: JSON.stringify(batch.map(p=>({id:p.id,text:p.text}))),
        sourceLang,
        targetLang,
        pageUrl:sourceUrl,
        promptStyle:config.promptStyle,
        translationMode:'technical',
      };
      const response = await browser.runtime.sendMessage(message) as TranslateChunkResponse;
      if (!response?.success) throw new Error(response?.error || '翻译请求失败');
      const translatedMap = new Map(response.result.map(([id,text])=>[id,text]));
      for (const paragraph of batch) paragraph.translated = translatedMap.get(paragraph.id);
      done += batch.length;
      renderPaper();
      status('正在翻译：'+done+' / '+eligible.length+' 段');
    }
    translated = true;
    status('翻译完成。共翻译 '+done+' 段。');
    translateButton.textContent = '翻译完成';
  } catch (error) {
    status(error instanceof Error ? error.message : String(error), true);
    translateButton.disabled = false;
  }
}

modeButton.addEventListener('click', () => {
  translationOnly = !translationOnly;
  modeButton.textContent = translationOnly ? '显示原文' : '仅显示译文';
  for (const block of paperNode.querySelectorAll<HTMLElement>('.block')) {
    block.querySelector('.original')?.classList.toggle('hidden', translationOnly);
    const translation = block.querySelector('.translation');
    translation?.classList.toggle('hidden', !translation.textContent);
  }
});

translateButton.addEventListener('click', () => void translateAll());
document.querySelector<HTMLButtonElement>('#back')!.addEventListener('click', () => history.back());

if (!sourceUrl) {
  status('缺少 PDF 地址。请从 arXiv PDF 页面点击扩展翻译。', true);
  translateButton.disabled = true;
} else {
  void extractPdf(sourceUrl).catch(error => status(error instanceof Error ? error.message : String(error), true));
}
