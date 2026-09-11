import { ref } from 'vue';
import browser from 'webextension-polyfill';
import type { TranslateChunkResponse } from '@/types/messages';
import type { TranslationEntry } from '@/types/messages';
import type { Glossary } from '@/entrypoints/service/_service';
import type { PromptStyle } from '@/entrypoints/service/deepseek';
import { detectLanguage, shouldUseJapaneseSource } from '@/entrypoints/utils/languageDetector';
import { buildSegmentBatches, type BatchBudget } from '@/entrypoints/utils/document/batcher';
import type { DocumentSegment } from '@/entrypoints/utils/document/types';

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

  let stopped = false;
  let active = 0;

  function reset() {
    stopped = false;
    active = 0;
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
    stopped = true;
    state.value.running = false;
  }

  async function translateBatch(
    batch: DocumentSegment[],
    options: TranslateOptions,
  ): Promise<boolean> {
    const jsonContent = JSON.stringify(
      batch.map((s) => ({ id: s.id, text: s.text })),
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

    if (!response?.success) {
      throw new Error(response?.error || '翻译失败');
    }
    if (stopped) return false;

    for (const [id, text] of response.result as TranslationEntry[]) {
      if (text) state.value.translations.set(id, text);
    }
    return true;
  }

  async function run(segments: DocumentSegment[], options: TranslateOptions) {
    reset();
    const batches = buildSegmentBatches(segments, options.budget);
    state.value.total = batches.length;
    state.value.running = true;

    // 文档级语言检测（整篇只做一次），结果贯穿本批全部批次与重试。
    const effectiveOptions: TranslateOptions = {
      ...options,
      promptStyle: resolveDocumentStyle(segments, options),
    };

    const concurrency = Math.max(1, options.concurrency ?? 3);
    const retries = options.retries ?? 1;
    let cursor = 0;

    const worker = async () => {
      while (cursor < batches.length && !stopped) {
        const index = cursor++;
        const batch = batches[index] as DocumentSegment[];
        let ok = false;
        for (let attempt = 0; attempt <= retries && !stopped; attempt++) {
          try {
            ok = await translateBatch(batch, effectiveOptions);
            if (ok) break;
          } catch (err) {
            if (attempt === retries) {
              state.value.failedBatches.push(index);
              state.value.error = (err as Error).message;
            } else {
              // 简单退避：避免连续 429
              await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
            }
          }
        }
        if (ok || stopped) state.value.done++;
      }
      active--;
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, batches.length) }, () => {
        active++;
        return worker();
      }),
    );

    state.value.running = false;
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
    state.value.failedBatches = [];
    state.value.error = '';
    state.value.running = true;
    stopped = false;

    // 与 run 同一份解析结果：重试批次必须沿用同一文风，否则缓存 key 不同、
    // 且同一文档会出现文风割裂。
    const effectiveOptions: TranslateOptions = {
      ...options,
      promptStyle: resolveDocumentStyle(segments, options),
    };

    for (const index of failed) {
      if (stopped) break;
      const batch = batches[index];
      if (!batch) continue;
      try {
        const ok = await translateBatch(batch, effectiveOptions);
        if (ok) state.value.done++;
        else state.value.failedBatches.push(index);
      } catch (err) {
        state.value.failedBatches.push(index);
        state.value.error = (err as Error).message;
      }
    }
    state.value.running = false;
  }

  return { state, run, retryFailed, stop, reset };
}
