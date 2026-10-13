import { ref } from 'vue';
import browser from 'webextension-polyfill';
import type { TranslateChunkResponse } from '../../types/messages';
import type { Glossary } from '../service/_service';
import type { PromptStyle } from '../service/deepseek';
import { detectLanguage, shouldUseJapaneseSource } from '../utils/languageDetector';
import { buildSegmentBatches, type BatchBudget } from '../utils/document/batcher';
import type { DocumentSegment } from '../utils/document/types';
import { getMissingDocumentBatchIds, normalizeDocumentBatchResult } from '../utils/document/translationResult';

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
}

/**
 * 将各部署模式的现有 serverUrl 规范化为结构化文档端点。
 * 默认设置是 /fanyi/page；文档接口与之同域，但路径独立，服务端不会接收 PDF 二进制。
 */
function resolveServerDocumentEndpoint(serverUrl?: string): string {
  const base = serverUrl?.trim() || 'https://s.sunxiunan.com/fanyi/page';
  const url = new URL(base);
  if (!url.pathname.endsWith('/api/translate/document/segments')) {
    url.pathname = '/api/translate/document/segments';
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

  // 每次运行有独立 generation；停止或启动新任务时递增，丢弃旧请求的迟到结果。
  let generation = 0;
  // 重试必须沿用上一轮批次顺序（其中可能把当前阅读页提到了最前面）。
  let lastRunSegmentIds: string[] = [];
  const isCurrentRun = (runId: number) => generation === runId;

  function reset() {
    generation++;
    lastRunSegmentIds = [];
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
  ): Promise<boolean> {
    if (options.useServerTranslation) {
      // 服务端与本地翻译都按相同预算逐批提交。不要把整本书放入单个 HTTP 请求，
      // 否则用户在最后一批返回前看不到译文，也无法按批次重试。
      const result = await translateSegmentsViaServer(batch, options, runId, isCurrentRun);
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
      return isCurrentRun(runId);
    }

    // 本地模式与服务端模式使用同一份结构化片段元数据。
    const jsonContent = JSON.stringify(
      batch.map((segment) => ({
        id: segment.id,
        text: segment.text,
        ...(segment.contextPath ? { contextPath: segment.contextPath } : {}),
        kind: segment.kind,
        ...(segment.level ? { level: segment.level } : {}),
        ...(segment.marker ? { marker: segment.marker } : {}),
      })),
    );

    const response = (await browser.runtime.sendMessage({
      action: 'translateChunk',
      jsonContent,
      sourceLang: options.sourceLang,
      targetLang: options.targetLang,
      pageUrl: 'fanyi://document',
      glossary: options.glossary,
      promptStyle: options.promptStyle,
    })) as TranslateChunkResponse;

    // 当前任务可能已停止或被新文档替换。旧响应不得再修改共享状态。
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
    return isCurrentRun(runId);
  }

  async function run(segments: DocumentSegment[], options: TranslateOptions) {
    reset();
    const runId = generation;
    const priorityIds = new Set(options.prioritySegmentIds ?? []);
    const orderedSegments = priorityIds.size
      ? [
          ...segments.filter((segment) => priorityIds.has(segment.id)),
          ...segments.filter((segment) => !priorityIds.has(segment.id)),
        ]
      : [...segments];
    lastRunSegmentIds = orderedSegments.map((segment) => segment.id);
    const batches = buildSegmentBatches(orderedSegments, options.budget);
    state.value.total = batches.length;
    state.value.running = true;

    // 文档级语言检测只使用有限样本；不再拼接、扫描整本 EPUB。
    const effectiveOptions: TranslateOptions = {
      ...options,
      promptStyle: resolveDocumentStyle(segments, options),
    };
    const concurrency = Math.max(1, options.concurrency ?? 3);
    // 服务端明确返回 partial 时保留缺失片段并暴露给用户重试；不要在一次点击中自动吞掉 partial。
    const retries = effectiveOptions.useServerTranslation ? 0 : (options.retries ?? 1);
    let cursor = 0;

    const worker = async () => {
      while (cursor < batches.length && isCurrentRun(runId)) {
        const index = cursor++;
        const batch = batches[index] as DocumentSegment[];
        let ok = false;
        for (let attempt = 0; attempt <= retries && isCurrentRun(runId); attempt++) {
          try {
            ok = await translateBatch(batch, effectiveOptions, runId);
            if (ok) break;
          } catch (err) {
            if (!isCurrentRun(runId)) return;
            if (attempt === retries) {
              state.value.failedBatches.push(index);
              state.value.error = (err as Error).message;
            } else {
              // 简单退避，避免连续 429；停止或切换文档后不会进入下一轮。
              await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
            }
          }
        }
        if (!isCurrentRun(runId)) return;
        if (ok) state.value.done++;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, () => worker()),
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
    const batches = buildSegmentBatches(orderedSegments, options.budget);
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
        const ok = await translateBatch(batch, effectiveOptions, runId);
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

  return { state, run, retryFailed, stop, reset };
}
