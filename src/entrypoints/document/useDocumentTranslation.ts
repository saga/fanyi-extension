import { ref } from 'vue';
import browser from 'webextension-polyfill';
import type { TranslateChunkResponse } from '../../types/messages';
import type { Glossary } from '../service/_service';
import type { PromptStyle } from '../service/deepseek';
import { detectLanguage, shouldUseJapaneseSource } from '../utils/languageDetector';
import { buildSegmentBatches, type BatchBudget } from '../utils/document/batcher';
import type { DocumentSegment } from '../utils/document/types';
import { getMissingDocumentBatchIds, normalizeDocumentBatchResult } from '../utils/document/translationResult';
import {
  addLiteraryExamples,
  buildLiteraryContextForText,
  buildLiteraryTranslationContextPrompt,
  createEmptyLiteraryMemory,
  mergeLiteraryMemory,
  type LiteraryBookMemory,
} from '../utils/document/literary';

/**
 * 文档翻译执行器。
 *
 * 三个关键设计（对应长文档翻译最容易翻车的地方）：
 *   1. **逐批提交**：每批成功就把译文写进 map，UI 立刻可见；
 *      不"全部成功后再一次性渲染"，否则中途失败等于白等。
 *   2. **失败隔离 + 重试**：单批失败只重试该批，成功后继续；
 *      最终失败的批单独列出，可一键重跑，不影响已完成部分。
 *   3. **可中断**：stop() 后已在途的请求不再回写，用户不必等长文档跑完才能退出。
 */

export interface TranslateOptions {
  sourceLang: string;
  targetLang: string;
  concurrency?: number;
  budget?: Partial<BatchBudget>;
  /** 单批失败重试次数，默认 1。 */
  retries?: number;
  /** 用户术语表（与网页翻译行为一致，避免文档里同名专有名词被翻错）。 */
  glossary?: Glossary;
  /**
   * 已解析的文风。调用方通常不传 —— 由 `run`/`retryFailed` 基于全部 segment
   * 做一次文档级语言检测后填入（见 resolveDocumentStyle）。
   */
  promptStyle?: PromptStyle;
  /** 跟随扩展全局设置：将已重建的文档片段交给 vocal-saga 服务端翻译。 */
  useServerTranslation?: boolean;
  serverUrl?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  documentFileName?: string;
  documentTitle?: string;
  documentFormat?: string;
  documentWarnings?: string[];
  /** 首批优先翻译当前阅读页；其他片段随后继续翻译。 */
  prioritySegmentIds?: string[];
  /** 仅 EPUB/PDF 可开启：逐章实体分析、书籍记忆、文学译稿审校。 */
  literaryMode?: boolean;
}

/**
 * 解析本次文档翻译应使用的文风。
 *
 * 与网页翻译、PDF 翻译同一策略：日语原文 → 非日语目标语言时，把 default
 * 自动升级为 ja-source-natural（保留原文的克制、论述顺序与限定语气）。
 * 用户手工选择的文风永远优先 —— 策略集中在 shouldUseJapaneseSource。
 *
 * 检测基于**全部** segment 而不是单批：单批文本可能过短，会触发
 * languageDetector 的短文本保护而判不出语言，导致同一文档内各批文风不一致。
 */
function resolveDocumentStyle(
  segments: DocumentSegment[],
  options: TranslateOptions,
): PromptStyle | undefined {
  // 语言识别只需要有代表性的样本。不要把整本 EPUB 拼成超大字符串，
  // 否则正式发送第一个翻译请求之前，还要额外复制并扫描整本书。
  const SAMPLE_LIMIT = 20_000;
  let sample = '';
  for (const segment of segments) {
    if (sample.length >= SAMPLE_LIMIT) break;
    sample += segment.text.slice(0, SAMPLE_LIMIT - sample.length) + '\n';
  }
  const detected = detectLanguage(sample);
  return shouldUseJapaneseSource(options.promptStyle, detected.language, options.targetLang)
    ? 'ja-source-natural'
    : options.promptStyle;
}

interface ServerDocumentTranslationResponse {
  translations?: Record<string, unknown>;
  failedBatches?: unknown;
  errors?: unknown;
  complete?: unknown;
  missingSegmentIds?: unknown;
  reviewedSegmentCount?: unknown;
  reviewerErrors?: unknown;
}

/**
 * 将各部署模式的现有 serverUrl 规范化为结构化文档端点。
 * 默认设置是 /fanyi/page；文档接口与之同域，但路径独立，服务端不会接收 PDF 二进制。
 */
function resolveServerDocumentEndpoint(
  serverUrl?: string,
  endpointPath = '/api/translate/document/segments',
): string {
  const base = serverUrl?.trim() || 'https://s.sunxiunan.com/fanyi/page';
  const url = new URL(base);
  if (url.pathname !== endpointPath) {
    url.pathname = endpointPath;
    url.search = '';
    url.hash = '';
  }
  return url.toString();
}

/**
 * 上传已在浏览器端提取好的结构化片段。
 * 响应只接纳当前请求中存在的 ID；服务端返回部分结果时保留有效译文，
 * 再由调用方根据实际缺失片段重试，避免把 HTTP 200 当成完整成功。
 */
async function translateSegmentsViaServer(
  segments: DocumentSegment[],
  options: TranslateOptions,
  runId: number,
  isCurrentRun: (runId: number) => boolean,
  bookMemory?: LiteraryBookMemory,
): Promise<ServerDocumentTranslationResponse | null> {
  if (!segments.length) return { translations: {}, failedBatches: [], errors: [], complete: true };

  const format = options.documentFormat || 'txt';
  const fileName = options.documentFileName ||
    ((options.documentTitle || 'document') + '.' + format);
  const endpoint = resolveServerDocumentEndpoint(options.serverUrl);
  const provider = options.provider || 'deepseek';
  const payload = {
    fileName,
    title: options.documentTitle,
    format,
    warnings: options.documentWarnings ?? [],
    source: options.sourceLang,
    target: options.targetLang,
    glossary: options.glossary,
    promptStyle: options.promptStyle,
    ...(options.literaryMode && bookMemory ? {
      literaryContext: bookMemory,
      literaryReview: true,
      chapterTitle: segments[0]?.contextPath,
    } : {}),
    provider,
    model: options.model,
    ...(provider === 'deepseek' && options.apiKey ? { apiKey: options.apiKey } : {}),
    segments: segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      kind: segment.kind,
      level: segment.level,
      marker: segment.marker,
      page: segment.page,
      contextPath: segment.contextPath,
      path: segment.path,
      start: segment.start,
      end: segment.end,
    })),
  };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data: ServerDocumentTranslationResponse & { error?: string };
  try {
    data = await response.json() as ServerDocumentTranslationResponse & { error?: string };
  } catch {
    throw new Error('服务端文档翻译返回了无法解析的响应');
  }
  if (!isCurrentRun(runId)) return null;
  if (!response.ok) {
    throw new Error(data.error || ('服务端文档翻译失败：HTTP ' + response.status));
  }

  const expectedIds = new Set(segments.map((segment) => segment.id));
  const normalized: Record<string, string> = {};
  if (data.translations && typeof data.translations === 'object') {
    for (const [id, value] of Object.entries(data.translations)) {
      if (expectedIds.has(id) && typeof value === 'string' && value.trim()) {
        normalized[id] = value;
      }
    }
  }
  return { ...data, translations: normalized };
}


interface LiteraryStatus {
  enabled: boolean;
  chapterTitle: string;
  bookProfileReady: boolean;
  analyzedChapters: number;
  reviewedSegments: number;
  warnings: string[];
}

/** 从长章中均匀抽样；分析请求有界，书籍全文不会送进单个请求。 */
function selectLiteraryChapterSample(segments: DocumentSegment[]): DocumentSegment[] {
  const valid = segments.filter((segment) => segment.text.trim());
  if (valid.length <= 24) return valid.map((segment) => ({ ...segment, text: segment.text.slice(0, 900) }));
  const selected = new Map<number, DocumentSegment>();
  for (let i = 0; i < valid.length; i++) {
    if (valid[i]?.kind === 'heading') selected.set(i, valid[i]!);
  }
  const slots = Math.max(0, 24 - selected.size);
  for (let i = 0; i < slots; i++) {
    const index = Math.round((i + 0.5) * (valid.length - 1) / Math.max(slots, 1));
    selected.set(index, valid[index]!);
  }
  return Array.from(selected.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 24)
    .map(([, segment]) => ({ ...segment, text: segment.text.slice(0, 900) }));
}

/**
 * 全书预分析采用跨章节均匀抽样，不把全文送进一个请求。
 * 先保证目录中不同章节都有代表，再填充额外段落；后续每章仍会按需增补新实体。
 */
/**
 * 章节/上下文单元的稳定键。放在模块级是因为全书预分析的抽样器也要用它；
 * EPUB 以章节路径为主，缺少章节标题的 PDF 每 8 页合成一个分析窗口。
 */
function literaryChapterKey(segment: DocumentSegment, enabled: boolean, format?: string): string {
  if (!enabled) return '';
  const context = segment.contextPath?.trim();
  if (context) return context;
  if (format === 'pdf' && segment.page) {
    const firstPage = Math.floor((segment.page - 1) / 8) * 8 + 1;
    return 'PDF 第 ' + firstPage + '-' + (firstPage + 7) + ' 页';
  }
  return segment.page ? 'PDF 第 ' + segment.page + ' 页' : '正文';
}

function selectLiteraryBookSample(segments: DocumentSegment[], format?: string): DocumentSegment[] {
  const valid = segments.filter((segment) => segment.text.trim());
  const groups = new Map<string, Array<{ segment: DocumentSegment; index: number }>>();
  valid.forEach((segment, index) => {
    const key = literaryChapterKey(segment, true, format);
    const group = groups.get(key) ?? [];
    group.push({ segment, index });
    groups.set(key, group);
  });

  const orderedGroups = Array.from(groups.values());
  const selected = new Map<number, DocumentSegment>();
  const addRepresentative = (group: Array<{ segment: DocumentSegment; index: number }>) => {
    const item = group.find((entry) => entry.segment.kind === 'heading') ?? group[0];
    if (item) selected.set(item.index, item.segment);
  };

  // 书里章节多于可用 slot 时，均匀取样而不是只分析开头的章节。
  if (orderedGroups.length >= 24) {
    for (let i = 0; i < 24; i++) {
      const groupIndex = Math.round((i + 0.5) * (orderedGroups.length - 1) / 24);
      const group = orderedGroups[groupIndex];
      if (group) addRepresentative(group);
    }
  } else {
    for (const group of orderedGroups) addRepresentative(group);
    const slots = Math.max(0, 24 - selected.size);
    for (let i = 0; i < slots; i++) {
      const index = Math.round((i + 0.5) * (valid.length - 1) / Math.max(slots, 1));
      if (valid[index]) selected.set(index, valid[index]!);
    }
  }

  return Array.from(selected.entries())
    .sort((a, b) => a[0] - b[0])
    .slice(0, 24)
    .map(([, segment]) => ({ ...segment, text: segment.text.slice(0, 900) }));
}

async function analyzeLiteraryChapterViaServer(
  chapterTitle: string,
  segments: DocumentSegment[],
  options: TranslateOptions,
  memory: LiteraryBookMemory,
  runId: number,
  isCurrentRun: (runId: number) => boolean,
): Promise<{ memory: LiteraryBookMemory; analyzed: boolean; warning?: string } | null> {
  const sampled = selectLiteraryChapterSample(segments);
  if (!sampled.length) return { memory, analyzed: false, warning: '当前内容没有足够的正文片段供实体分析' };
  const endpoint = resolveServerDocumentEndpoint(options.serverUrl, '/api/translate/document/literary/analyze');
  const provider = options.useServerTranslation ? (options.provider || 'deepseek') : 'deepseek';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chapterTitle,
      segments: sampled.map((segment) => ({
        id: segment.id, text: segment.text, kind: segment.kind, contextPath: segment.contextPath,
      })),
      memory,
      source: options.sourceLang,
      target: options.targetLang,
      glossary: options.glossary,
      promptStyle: options.promptStyle,
      provider,
      model: options.model,
      ...(provider === 'deepseek' && options.apiKey ? { apiKey: options.apiKey } : {}),
    }),
  });
  let data: { memory?: unknown; analyzed?: unknown; warning?: unknown; error?: string };
  try { data = await response.json() as typeof data; }
  catch { throw new Error('书籍实体分析接口返回了无法解析的响应'); }
  if (!isCurrentRun(runId)) return null;
  if (!response.ok) throw new Error(data.error || ('书籍实体分析失败：HTTP ' + response.status));
  return {
    memory: mergeLiteraryMemory(memory, data.memory),
    analyzed: data.analyzed === true,
    ...(typeof data.warning === 'string' && data.warning ? { warning: data.warning } : {}),
  };
}

async function reviewLiteraryBatchViaServer(
  segments: DocumentSegment[],
  drafts: Map<string, string>,
  options: TranslateOptions,
  memory: LiteraryBookMemory,
  runId: number,
  isCurrentRun: (runId: number) => boolean,
): Promise<Map<string, string> | null> {
  const candidates = segments.flatMap((segment) => {
    const draft = drafts.get(segment.id);
    return draft?.trim() ? [{
      id: segment.id, source: segment.text, draft, kind: segment.kind, contextPath: segment.contextPath,
    }] : [];
  });
  if (!candidates.length) return new Map();
  const endpoint = resolveServerDocumentEndpoint(options.serverUrl, '/api/translate/document/literary/review');
  const provider = options.useServerTranslation ? (options.provider || 'deepseek') : 'deepseek';
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chapterTitle: candidates[0]?.contextPath || options.documentTitle,
      segments: candidates,
      memory,
      source: options.sourceLang,
      target: options.targetLang,
      glossary: options.glossary,
      promptStyle: options.promptStyle,
      provider,
      model: options.model,
      ...(provider === 'deepseek' && options.apiKey ? { apiKey: options.apiKey } : {}),
    }),
  });
  let data: { translations?: unknown; reviewedIds?: unknown; missingIds?: unknown; error?: string };
  try { data = await response.json() as typeof data; }
  catch { throw new Error('文学审校接口返回了无法解析的响应'); }
  if (!isCurrentRun(runId)) return null;
  if (!response.ok) throw new Error(data.error || ('文学审校失败：HTTP ' + response.status));
  const allowed = new Set(candidates.map((segment) => segment.id));
  const reviewed = new Map<string, string>();
  if (data.translations && typeof data.translations === 'object' && !Array.isArray(data.translations)) {
    for (const [id, value] of Object.entries(data.translations)) {
      if (allowed.has(id) && typeof value === 'string' && value.trim()) reviewed.set(id, value.trim());
    }
  }
  return reviewed;
}

export interface DocumentTranslateState {
  /** segmentId → 译文 */
  translations: Map<string, string>;
  total: number;
  done: number;
  failedBatches: number[];
  running: boolean;
  error: string;
}

export function useDocumentTranslation() {
  const state = ref<DocumentTranslateState>({
    translations: new Map(),
    total: 0,
    done: 0,
    failedBatches: [],
    running: false,
    error: '',
  });

  // 文学记忆属于当前阅读会话，继续/重试保留；切换文档时重置。
  const literaryMemory = ref<LiteraryBookMemory>(createEmptyLiteraryMemory());
  const literaryStatus = ref<LiteraryStatus>({
    enabled: false, bookProfileReady: false, chapterTitle: '', analyzedChapters: 0, reviewedSegments: 0, warnings: [],
  });
  let analyzedChapterKeys = new Set<string>();

  // 每次运行有独立 generation；停止或启动新任务时递增，丢弃旧请求的迟到结果。
  let generation = 0;
  // 重试必须沿用上一轮批次顺序（其中可能把当前阅读页提到了最前面）。
  let lastRunSegmentIds: string[] = [];
  const isCurrentRun = (runId: number) => generation === runId;

  function reset() {
    generation++;
    lastRunSegmentIds = [];
    analyzedChapterKeys = new Set<string>();
    literaryMemory.value = createEmptyLiteraryMemory();
    literaryStatus.value = {
      enabled: false, bookProfileReady: false, chapterTitle: '', analyzedChapters: 0, reviewedSegments: 0, warnings: [],
    };
    state.value = {
      translations: new Map(),
      total: 0,
      done: 0,
      failedBatches: [],
      running: false,
      error: '',
    };
  }

  function stop() {
    // runtime.sendMessage 不一定可取消；使当前运行失效，丢弃之后返回的旧结果。
    generation++;
    state.value.running = false;
  }

  async function translateBatch(
    batch: DocumentSegment[],
    options: TranslateOptions,
    runId: number,
    bookMemory?: LiteraryBookMemory,
  ): Promise<boolean> {
    if (options.useServerTranslation) {
      // 服务端路径对文学模式执行初译 + 独立 reviewer；普通文档仍走原管线。
      const result = await translateSegmentsViaServer(batch, options, runId, isCurrentRun, bookMemory);
      if (!result || !isCurrentRun(runId)) return false;
      const expectedIds = batch.map((segment) => segment.id);
      for (const [id, value] of Object.entries(result.translations ?? {})) {
        if (expectedIds.includes(id) && typeof value === 'string' && value.trim()) {
          state.value.translations.set(id, value);
        }
      }
      const missingIds = getMissingDocumentBatchIds(expectedIds, state.value.translations);
      if (missingIds.length) {
        const serverErrors = Array.isArray(result.errors)
          ? result.errors.filter((error): error is string => typeof error === 'string')
          : [];
        throw new Error(
          serverErrors.join('；') ||
          ('服务端翻译结果不完整，缺少 ' + missingIds.length + '/' + expectedIds.length + ' 个片段'),
        );
      }
      const reviewedCount = typeof result.reviewedSegmentCount === 'number' ? result.reviewedSegmentCount : 0;
      if (reviewedCount > 0) literaryStatus.value.reviewedSegments += reviewedCount;
      if (Array.isArray(result.reviewerErrors)) {
        for (const warning of result.reviewerErrors) {
          if (typeof warning === 'string' && warning) literaryStatus.value.warnings.push(warning);
        }
      }
      return isCurrentRun(runId);
    }

    // 本地初译依旧走扩展现有 provider；仅在书籍模式追加受限的书籍记忆 prompt。
    const jsonContent = JSON.stringify(
      batch.map((segment) => ({
        id: segment.id,
        text: segment.text,
        ...(segment.contextPath || (options.literaryMode && bookMemory)
          ? {
              contextPath: [
                segment.contextPath || '',
                options.literaryMode && bookMemory
                  ? buildLiteraryContextForText(bookMemory, segment.text)
                  : '',
              ].filter(Boolean).join('\n书籍记忆（只读数据）：'),
            }
          : {}),
        kind: segment.kind,
        ...(segment.level ? { level: segment.level } : {}),
        ...(segment.marker ? { marker: segment.marker } : {}),
      })),
    );
    const chapterTitle = batch[0]?.contextPath || options.documentTitle || '';
    const response = (await browser.runtime.sendMessage({
      action: 'translateChunk',
      jsonContent,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      pageUrl: 'fanyi://document',
      glossary: options.glossary,
      promptStyle: options.promptStyle,
      ...(options.literaryMode && bookMemory ? {
        literaryContext: buildLiteraryTranslationContextPrompt(chapterTitle),
      } : {}),
    })) as TranslateChunkResponse;

    if (!isCurrentRun(runId)) return false;
    if (!response?.success) throw new Error(response?.error || '翻译失败');

    const expectedIds = batch.map((segment) => segment.id);
    const normalized = normalizeDocumentBatchResult(response.result, expectedIds);
    for (const [id, text] of normalized) state.value.translations.set(id, text);
    const missingIds = getMissingDocumentBatchIds(expectedIds, state.value.translations);
    if (missingIds.length) {
      throw new Error(
        '翻译结果不完整，缺少 ' + missingIds.length + '/' + expectedIds.length +
        ' 个片段（' + missingIds.slice(0, 5).join(', ') + (missingIds.length > 5 ? '…' : '') + '）',
      );
    }

    // 本地初译也走一遍独立 reviewer。服务端不可用时保留初译，不因审校故障丢文本。
    if (options.literaryMode && bookMemory) {
      const drafts = new Map(normalized);
      try {
        const reviewed = await reviewLiteraryBatchViaServer(
          batch, drafts, options, bookMemory, runId, isCurrentRun,
        );
        if (reviewed && isCurrentRun(runId)) {
          for (const [id, text] of reviewed) {
            if (expectedIds.includes(id) && text.trim()) state.value.translations.set(id, text);
          }
          literaryStatus.value.reviewedSegments += reviewed.size;
          const missingReview = expectedIds.filter((id) => !reviewed.has(id));
          if (missingReview.length) {
            literaryStatus.value.warnings.push('本批审校未返回 ' + missingReview.length + ' 段，已保留初译');
          }
        }
      } catch (error) {
        if (isCurrentRun(runId)) {
          literaryStatus.value.warnings.push(
            '文学审校不可用，已保留初译：' + (error instanceof Error ? error.message : String(error)),
          );
        }
      }
    }
    return isCurrentRun(runId);
  }

  async function prepareLiteraryChapter(
    key: string,
    segments: DocumentSegment[],
    options: TranslateOptions,
    runId: number,
  ): Promise<boolean> {
    if (!options.literaryMode || analyzedChapterKeys.has(key)) return isCurrentRun(runId);
    literaryStatus.value.chapterTitle = key;
    try {
      const result = await analyzeLiteraryChapterViaServer(
        key, segments, options, literaryMemory.value, runId, isCurrentRun,
      );
      if (!result || !isCurrentRun(runId)) return false;
      literaryMemory.value = result.memory;
      if (result.warning) literaryStatus.value.warnings.push(result.warning);
      if (result.analyzed) literaryStatus.value.analyzedChapters++;
    } catch (error) {
      if (!isCurrentRun(runId)) return false;
      // 分析失败不阻断阅读；后续仍按通用文学 prompt 和已有记忆翻译。
      literaryStatus.value.warnings.push(
        '本章实体/文风分析失败，继续翻译：' + (error instanceof Error ? error.message : String(error)),
      );
    }
    // 即使分析服务失败也只尝试一次，避免每批反复支付同一分析的成本。
    analyzedChapterKeys.add(key);
    return isCurrentRun(runId);
  }

  async function run(
    segments: DocumentSegment[],
    options: TranslateOptions,
    preserveExisting = false,
  ) {
    if (preserveExisting) {
      generation++;
      state.value.failedBatches = [];
      state.value.error = '';
      state.value.running = false;
    } else {
      reset();
    }
    const runId = generation;
    const literaryEnabled = !!options.literaryMode &&
      (options.documentFormat === 'epub' || options.documentFormat === 'pdf');
    literaryStatus.value.enabled = literaryEnabled;
    if (!literaryEnabled) {
      literaryMemory.value = createEmptyLiteraryMemory();
      analyzedChapterKeys = new Set<string>();
    }

    // 文学模式必须按原书顺序累积上下文；只有普通文档才把当前页提前。
    const priorityIds = new Set(literaryEnabled ? [] : (options.prioritySegmentIds ?? []));
    const orderedSegments = priorityIds.size
      ? [
          ...segments.filter((segment) => priorityIds.has(segment.id)),
          ...segments.filter((segment) => !priorityIds.has(segment.id)),
        ]
      : [...segments];
    lastRunSegmentIds = orderedSegments.map((segment) => segment.id);

    // 文学模式强制在章节/PDF 页边界拆批；普通文档继续使用原分批行为。
    const budget: Partial<BatchBudget> = {
      ...options.budget,
      ...(literaryEnabled ? { splitOnContextChange: true } : {}),
    };
    const allBatches = buildSegmentBatches(orderedSegments, budget);
    state.value.total = allBatches.length;
    state.value.done = allBatches.filter((batch) =>
      batch.every((segment) => !!state.value.translations.get(segment.id)?.trim()),
    ).length;
    const pendingBatches = allBatches
      .map((batch, index) => ({
        index,
        batch: batch.filter((segment) => !state.value.translations.get(segment.id)?.trim()),
      }))
      .filter((item) => item.batch.length > 0);
    state.value.running = pendingBatches.length > 0;
    if (pendingBatches.length === 0) return state.value;

    const effectiveOptions: TranslateOptions = {
      ...options,
      literaryMode: literaryEnabled,
      promptStyle: resolveDocumentStyle(segments, options),
    };

    // 第一个正式译稿之前，先用覆盖全书的少量代表片段建立实体/关系和声线底稿。
    // 这样早期章节也能认识后续章节反复出现的人物；翻译本身仍然逐批渐次执行。
    if (literaryEnabled && !literaryStatus.value.bookProfileReady && isCurrentRun(runId)) {
      literaryStatus.value.chapterTitle = '全书预分析';
      try {
        const profile = await analyzeLiteraryChapterViaServer(
          '全书预分析',
          selectLiteraryBookSample(segments, options.documentFormat),
          effectiveOptions,
          literaryMemory.value,
          runId,
          isCurrentRun,
        );
        if (!profile || !isCurrentRun(runId)) return state.value;
        literaryMemory.value = profile.memory;
        literaryStatus.value.bookProfileReady = profile.analyzed;
        if (profile.analyzed) {
          // 单章文件的全书抽样已经覆盖了本章，无须为同一章再付一次分析请求。
          const chapterKeys = new Set(
            segments.map((segment) => literaryChapterKey(segment, true, options.documentFormat)),
          );
          if (chapterKeys.size === 1) {
            const onlyChapter = chapterKeys.values().next().value as string | undefined;
            if (onlyChapter) analyzedChapterKeys.add(onlyChapter);
            // 单章节书籍的全书抽样已经覆盖该章；避免第二次付费分析，但状态仍反映该章已分析。
            if (literaryStatus.value.analyzedChapters === 0) literaryStatus.value.analyzedChapters = 1;
          }
        }
        if (profile.warning) literaryStatus.value.warnings.push(profile.warning);
      } catch (error) {
        literaryStatus.value.warnings.push(
          '全书预分析失败，将逐章补充实体记忆：' +
          (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    // 文学模式每次只推进一个尚未完成的章节/PDF 上下文单元。
    // 上一单元的初译、reviewer 与译例更新完成后，再由用户继续下一章。
    let workBatches = pendingBatches;
    if (literaryEnabled && pendingBatches.length > 0) {
      const firstPending = pendingBatches[0]!;
      const chapterKey = literaryChapterKey(firstPending.batch[0]!, true, options.documentFormat);
      workBatches = pendingBatches.filter((item) =>
        literaryChapterKey(item.batch[0]!, true, options.documentFormat) === chapterKey,
      );
    }

    const retries = effectiveOptions.useServerTranslation ? 0 : (options.retries ?? 1);
    // 文学模式按章节串行推进，使先完成的章节记忆能稳定影响后续章节。
    const concurrency = literaryEnabled ? 1 : Math.max(1, options.concurrency ?? 3);
    let cursor = 0;

    const worker = async () => {
      while (cursor < workBatches.length && isCurrentRun(runId)) {
        const item = workBatches[cursor++];
        if (!item) continue;
        const { index, batch } = item;
        if (literaryEnabled) {
          const key = literaryChapterKey(batch[0]!, literaryEnabled, options.documentFormat);
          const chapterSegments = segments.filter((segment) =>
            literaryChapterKey(segment, literaryEnabled, options.documentFormat) === key);
          if (!(await prepareLiteraryChapter(key, chapterSegments, effectiveOptions, runId))) return;
        }
        let ok = false;
        for (let attempt = 0; attempt <= retries && isCurrentRun(runId); attempt++) {
          try {
            ok = await translateBatch(
              batch, effectiveOptions, runId, literaryEnabled ? literaryMemory.value : undefined,
            );
            if (ok) break;
          } catch (err) {
            if (!isCurrentRun(runId)) return;
            if (attempt === retries) {
              state.value.failedBatches.push(index);
              state.value.error = (err as Error).message;
            } else {
              await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
            }
          }
        }
        if (!isCurrentRun(runId)) return;
        if (ok) {
          state.value.done++;
          if (literaryEnabled) {
            literaryMemory.value = addLiteraryExamples(literaryMemory.value, batch.flatMap((segment) => {
              const translated = state.value.translations.get(segment.id);
              return translated ? [{
                source: segment.text, target: translated, chapter: segment.contextPath || '',
              }] : [];
            }));
          }
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, workBatches.length) }, () => worker()),
    );

    if (isCurrentRun(runId)) {
      state.value.failedBatches.sort((a, b) => a - b);
      state.value.running = false;
    }
    return state.value;
  }

  /** 只重跑失败的批次。 */
  async function retryFailed(
    segments: DocumentSegment[],
    options: TranslateOptions,
  ) {
    const failed = [...state.value.failedBatches];
    if (!failed.length) return;
    const byId = new Map(segments.map((segment) => [segment.id, segment]));
    const orderedSegments = lastRunSegmentIds.length
      ? lastRunSegmentIds.map((id) => byId.get(id)).filter((segment): segment is DocumentSegment => !!segment)
      : [...segments];
    const batches = buildSegmentBatches(orderedSegments, {
      ...options.budget,
      ...(options.literaryMode ? { splitOnContextChange: true } : {}),
    });
    const runId = ++generation;
    state.value.failedBatches = [];
    state.value.error = '';
    state.value.running = true;

    // 与 run 同一份解析结果：重试批次必须沿用同一文风，否则缓存 key 不同、
    // 且同一文档会出现文风割裂。
    const effectiveOptions: TranslateOptions = {
      ...options,
      promptStyle: resolveDocumentStyle(segments, options),
    };


    for (const index of failed) {
      if (!isCurrentRun(runId)) break;
      const batch = (batches[index] ?? [])
        // 部分成功的批次只提交缺失片段，已成功的译文不重复消耗请求与 token。
        .filter((segment) => !state.value.translations.get(segment.id)?.trim());
      if (!batch.length) continue;
      try {
        if (options.literaryMode) {
          const key = literaryChapterKey(batch[0]!, true, options.documentFormat);
          const chapterSegments = segments.filter((segment) =>
            literaryChapterKey(segment, true, options.documentFormat) === key);
          if (!(await prepareLiteraryChapter(key, chapterSegments, effectiveOptions, runId))) break;
        }
        const ok = await translateBatch(
          batch, effectiveOptions, runId,
          options.literaryMode ? literaryMemory.value : undefined,
        );
        if (!isCurrentRun(runId)) break;
        if (ok) state.value.done++;
        else state.value.failedBatches.push(index);
      } catch (err) {
        if (!isCurrentRun(runId)) break;
        state.value.failedBatches.push(index);
        state.value.error = (err as Error).message;
      }
    }
    if (isCurrentRun(runId)) {
      state.value.failedBatches.sort((a, b) => a - b);
      state.value.running = false;
    }
  }

  return { state, run, retryFailed, stop, reset, literaryMemory, literaryStatus };
}
