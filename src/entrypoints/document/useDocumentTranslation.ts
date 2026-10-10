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
  const detected = detectLanguage(segments.map((s) => s.text).join('\n'));
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

/** 把服务端结果合并进当前运行状态，并按客户端原有批次重新计算完整度。 */
function applyServerDocumentResult(
  segments: DocumentSegment[],
  result: ServerDocumentTranslationResponse,
  batches: DocumentSegment[][],
  state: { value: DocumentTranslateState },
): void {
  const expectedIds = new Set(segments.map((segment) => segment.id));
  for (const [id, value] of Object.entries(result.translations ?? {})) {
    if (expectedIds.has(id) && typeof value === 'string' && value.trim()) {
      state.value.translations.set(id, value);
    }
  }
  state.value.done = batches.filter((batch) =>
    batch.every((segment) => !!state.value.translations.get(segment.id)?.trim()),
  ).length;
  state.value.failedBatches = batches
    .map((batch, index) => ({ batch, index }))
    .filter(({batch}) => batch.some((segment) => !state.value.translations.get(segment.id)?.trim()))
    .map(({index}) => index);
  const serverErrors = Array.isArray(result.errors)
    ? result.errors.filter((error): error is string => typeof error === 'string')
    : [];
  const missingCount = segments.filter((segment) => !state.value.translations.get(segment.id)?.trim()).length;
  state.value.error = missingCount
    ? serverErrors.join('；') || ('仍有 ' + missingCount + ' 个片段未翻译完成')
    : '';
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
  const isCurrentRun = (runId: number) => generation === runId;

  function reset() {
    generation++;
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
    // 本地和服务端模式使用同一份结构化元数据：章节路径/标题层级/列表编号只作为语境，
    // 不进入翻译正文；服务端模式则通过结构化 endpoint 发送同样字段。
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
    // 保留有效部分，但漏掉任何预期 ID 都必须走重试/失败路径，不能把 HTTP 成功当作完整成功。
    for (const [id, text] of normalized) state.value.translations.set(id, text);
    // 对重试响应允许只返回剩余 ID；用当前批次累计已提交的结果做对账，避免误报仍缺失。
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
    const batches = buildSegmentBatches(segments, options.budget);
    state.value.total = batches.length;
    state.value.running = true;

    // 文档级语言检测（整篇只做一次），结果贯穿本批全部批次与重试。
    const effectiveOptions: TranslateOptions = {
      ...options,
      promptStyle: resolveDocumentStyle(segments, options),
    };

    if (effectiveOptions.useServerTranslation) {
      try {
        const response = await translateSegmentsViaServer(segments, effectiveOptions, runId, isCurrentRun);
        if (response && isCurrentRun(runId)) {
          applyServerDocumentResult(segments, response, batches, state);
        }
      } catch (error) {
        if (isCurrentRun(runId)) {
          state.value.failedBatches = batches.map((_, index) => index);
          state.value.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (isCurrentRun(runId)) state.value.running = false;
      }
      return state.value;
    }

    const concurrency = Math.max(1, options.concurrency ?? 3);
    const retries = options.retries ?? 1;
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
              // 简单退避：避免连续 429；停止或切换文档后不会进入下一轮。
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            }
          }
        }
        if (!isCurrentRun(runId)) return;
        if (ok) state.value.done++;
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, () => {
        return worker();
      }),
    );

    if (isCurrentRun(runId)) state.value.running = false;
    return state.value;
  }

  /** 只重跑失败的批次。 */
  async function retryFailed(
    segments: DocumentSegment[],
    options: TranslateOptions,
  ) {
    const failed = [...state.value.failedBatches];
    if (!failed.length) return;
    const batches = buildSegmentBatches(segments, options.budget);
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

    if (effectiveOptions.useServerTranslation) {
      const missing = failed.flatMap((index) => batches[index] ?? [])
        .filter((segment) => !state.value.translations.get(segment.id)?.trim());
      try {
        const response = await translateSegmentsViaServer(missing, effectiveOptions, runId, isCurrentRun);
        if (response && isCurrentRun(runId)) applyServerDocumentResult(segments, response, batches, state);
      } catch (error) {
        if (isCurrentRun(runId)) {
          state.value.error = error instanceof Error ? error.message : String(error);
        }
      } finally {
        if (isCurrentRun(runId)) state.value.running = false;
      }
      return state.value;
    }

    for (const index of failed) {
      if (!isCurrentRun(runId)) break;
      const batch = batches[index];
      if (!batch) continue;
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
    if (isCurrentRun(runId)) state.value.running = false;
  }

  return { state, run, retryFailed, stop, reset };
}
