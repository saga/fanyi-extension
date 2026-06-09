import browser from 'webextension-polyfill';
import type { Chunk } from '../utils/contentHelper';
import { TranslationQueue } from '../utils/translationQueue';
import {
  buildRetryChunk,
  diffMissingIds,
  shouldRetryMissing,
} from '../utils/chunkRetry';
import { applyBlockTranslation } from '../utils/translationDisplay';

// ============================================================
// Error categorisation for [SessionSummary]
// ============================================================

/**
 * 把失败错误消息归入短分类标签，用于 [SessionSummary] 的
 * hardFailed 分桶统计。
 */
function categorizeError(msg: string): string {
  if (!msg) return 'other';
  if (msg.includes('HTTP 401')) return '401-auth';
  if (msg.includes('HTTP 403')) return '403-billing';
  if (msg.includes('HTTP 429')) return '429-rate-limit';
  if (msg.includes('HTTP 5')) return '5xx-server';
  if (msg.includes('HTTP 400')) return '400-bad-req';
  if (/HTTP 4\d\d/.test(msg)) return '4xx-other';
  if (msg.includes('网络请求失败') || msg.includes('fetch')) return 'network';
  if (msg.includes('请求超时') || msg.includes('timeout')) return 'timeout';
  if (msg.includes('Unexpected token') || msg.includes('JSON')) return 'json-parse';
  if (msg.includes('缺少 choices[0].message.content')) return 'invalid-resp';
  if (msg.includes('response body is null')) return 'null-body';
  return 'other';
}

// ============================================================
// Chunk dispatch — warmup-then-parallel
// ============================================================

export interface ChunkCallContext {
  nodeMap: Map<string, Node>;
  mode: 'bilingual' | 'target';
  sourceLang: string;
  targetLang: string;
  glossary: Array<{ term: string; translation: string }>;
  onFailure: () => void;
  onApply: (chunkMap: Map<string, string>) => void;
  translatedIds: Set<string>;
  onChunkComplete: (
    outcome: 'fully-ok' | 'needed-retry' | 'hard-failed',
    recoveredCount: number,
    stillMissingCount: number,
    errMsg?: string,
  ) => void;
}

/**
 * 批量发送 chunk 到 background，采用 warmup-then-parallel 策略：
 * 前 2 个串行（帮助 KV cache 构建），后续并行（桌面 4 / 移动 2）。
 */
export async function translateChunksViaBackground(
  chunks: Chunk[],
  sourceLang: string,
  targetLang: string,
  nodeMap: Map<string, Node>,
  mode: 'bilingual' | 'target',
  glossary: Array<{ term: string; translation: string }>,
  onProgress?: (current: number, total: number) => void,
  isMobile: boolean = false,
): Promise<{ allSucceeded: boolean; translatedIds: Set<string> }> {
  console.log('[ContentScript] translateChunksViaBackground called, chunks:', chunks.length);

  const maxConcurrency = isMobile ? 2 : 4;
  console.log(
    `[ContentScript] Warmup serial, then parallel=${maxConcurrency} (isMobile=${isMobile})`,
  );

  // pool starts at concurrency=1 (serial); addAllWithWarmup bumps after warmup
  const pool = new TranslationQueue(1, 0, 0);

  let completedCount = 0;
  let hasFailure = false;
  const applyPromises: Promise<void>[] = [];
  const translatedIds = new Set<string>();
  const stats = {
    fullyOk: 0,
    neededRetry: 0,
    neededRetryRecovered: 0,
    neededRetryStillMissing: 0,
    hardFailed: 0,
    firstErrorMsg: '' as string,
    errorsByCategory: {} as Record<string, number>,
  };

  const tasks = chunks.map((chunk) =>
    async () => {
      await translateChunkPayload(
        chunk,
        /* isRetry */ false,
        {
          nodeMap,
          mode,
          sourceLang,
          targetLang,
          glossary,
          onFailure: () => { hasFailure = true; },
          onApply: (chunkMap) =>
            applyPromises.push(applyTranslationsWithRAF(chunkMap, nodeMap, mode)),
          onChunkComplete: (outcome, recovered, stillMissing, errMsg) => {
            if (outcome === 'fully-ok') stats.fullyOk++;
            else if (outcome === 'needed-retry') {
              stats.neededRetry++;
              stats.neededRetryRecovered += recovered;
              stats.neededRetryStillMissing += stillMissing;
            } else if (outcome === 'hard-failed') {
              stats.hardFailed++;
              if (!stats.firstErrorMsg && errMsg) stats.firstErrorMsg = errMsg;
              const cat = categorizeError(errMsg || '');
              stats.errorsByCategory[cat] = (stats.errorsByCategory[cat] || 0) + 1;
            }
          },
          translatedIds,
        },
      );
      completedCount++;
      onProgress?.(completedCount, chunks.length);
    },
  );

  await pool.addAllWithWarmup(tasks, 2, maxConcurrency);
  await Promise.all(applyPromises);

  const errorCatStr = Object.keys(stats.errorsByCategory).length > 0
    ? ' ' + Object.entries(stats.errorsByCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  console.log(
    `[ContentScript][SessionSummary] total=${chunks.length} ` +
    `fullyOk=${stats.fullyOk} ` +
    `neededRetry=${stats.neededRetry}(recovered=${stats.neededRetryRecovered},stillMissing=${stats.neededRetryStillMissing}) ` +
    `hardFailed=${stats.hardFailed}${errorCatStr}` +
    (stats.firstErrorMsg ? ` firstError="${stats.firstErrorMsg.substring(0, 100)}"` : ''),
  );
  return { allSucceeded: !hasFailure, translatedIds };
}

// ============================================================
// Single chunk: sendMessage → parse → apply → per-chunk retry
// ============================================================

async function translateChunkPayload(
  chunk: Chunk,
  isRetry: boolean,
  ctx: ChunkCallContext,
): Promise<Map<string, string>> {
  const chunkMap = new Map<string, string>();
  const inputIds = chunk.blocks.map((b) => b.id);
  const label = isRetry ? `${chunk.id}(retry)` : chunk.id;

  let outerMissingCount = 0;
  let recoveredIds: string[] = [];

  try {
    const response: any = await browser.runtime.sendMessage({
      action: 'translateChunk',
      jsonContent: chunk.jsonContent,
      sourceLang: ctx.sourceLang,
      targetLang: ctx.targetLang,
      pageUrl: window.location.href,
      glossary: ctx.glossary,
    });

    if (!response.success) {
      ctx.onFailure();
      console.error(
        `[ContentScript] ${label} translation FAILED — full response:`,
        {
          success: response.success,
          error: response.error,
          debugInfo: response.debugInfo ?? null,
          resultKeys: response.result ? Object.keys(response.result) : null,
          rawResponse: response,
        },
      );
      if (!isRetry) {
        ctx.onChunkComplete('hard-failed', 0, 0, response.error || 'unknown');
      }
      return chunkMap;
    }

    const outputIds: string[] = [];
    for (const entry of response.result) {
      if (!Array.isArray(entry) || entry.length !== 2) {
        console.warn('[ContentScript]   Skipping malformed entry:', entry);
        continue;
      }
      const [id, text] = entry;
      if (typeof text !== 'string') {
        console.warn(
          `[ContentScript]   Skipping block ${id}: translated_text is not a string (${typeof text})`,
        );
        continue;
      }
      chunkMap.set(id, text);
      outputIds.push(id);
      ctx.translatedIds.add(id);
    }

    const chunkMissing = diffMissingIds(inputIds, outputIds);
    if (!isRetry) outerMissingCount = chunkMissing.length;
    const missingHint =
      chunkMissing.length > 0
        ? ` (e.g. ${chunkMissing.slice(0, 3).join(',')}${chunkMissing.length > 3 ? `,+${chunkMissing.length - 3}` : ''})`
        : '';
    console.log(
      `[ContentScript][ChunkTrace] chunk=${label}`,
      `inputIds=[${inputIds.join(',')}]`,
      `outputIds=[${outputIds.join(',')}]`,
      `missing=${chunkMissing.length}${missingHint}`,
    );
    if (chunkMissing.length > 0) {
      console.warn(
        `[ContentScript][ChunkTrace] chunk=${label} model returned ${outputIds.length}/${inputIds.length} entries — root cause in [Background][ChunkTrace] OUTPUT/MISSING`,
      );
      if (response.trace) {
        console.warn(
          `[ContentScript][ChunkTrace] chunk=${label} trace from background:\n` +
            JSON.stringify(response.trace, null, 2),
        );
      }
    }

    ctx.onApply(chunkMap);

    if (
      shouldRetryMissing({
        missingCount: chunkMissing.length,
        totalCount: chunk.blocks.length,
        isRetry,
      })
    ) {
      const retryChunk = buildRetryChunk(chunk, chunkMissing);
      console.log(
        `[ContentScript] ${label} missing ${chunkMissing.length} block(s), retrying as ${retryChunk.id}`,
      );
      const retryMap = await translateChunkPayload(retryChunk, true, ctx);
      for (const id of retryMap.keys()) {
        if (!ctx.translatedIds.has(id)) {
          ctx.translatedIds.add(id);
          recoveredIds.push(id);
        }
      }
      console.log(
        `[ContentScript] ${label} retry recovered ${recoveredIds.length}/${chunkMissing.length} block(s)`,
      );
    }

    if (!isRetry) {
      if (outerMissingCount === 0) {
        ctx.onChunkComplete('fully-ok', 0, 0);
      } else {
        const stillMissing = Math.max(0, outerMissingCount - recoveredIds.length);
        ctx.onChunkComplete('needed-retry', recoveredIds.length, stillMissing);
      }
    }
  } catch (error) {
    ctx.onFailure();
    console.error(
      `[ContentScript] ${label} threw — runtime/network error (no response):`,
      {
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.substring(0, 500) : null,
      },
    );
    if (!isRetry) {
      const msg = error instanceof Error ? error.message : String(error);
      ctx.onChunkComplete('hard-failed', 0, 0, msg);
    }
  }
  return chunkMap;
}

// ============================================================
// DOM 应用（用 rAF 避免阻塞主线程）
// ============================================================

function applyTranslations(
  translationMap: Map<string, string>,
  nodeMap: Map<string, Node>,
  mode: 'bilingual' | 'target',
): void {
  for (const [blockId, translatedText] of translationMap) {
    const node = nodeMap.get(blockId);
    if (!node || !(node instanceof HTMLElement)) continue;
    applyBlockTranslation(node, translatedText, mode);
  }
}

/**
 * 把译文写回 DOM：用 requestAnimationFrame 等下一帧批量应用，
 * 避免一次性 reflow 阻塞主线程。5s fallback 防止 hidden tab 时 rAF 不触发。
 */
export function applyTranslationsWithRAF(
  translationMap: Map<string, string>,
  nodeMap: Map<string, Node>,
  mode: 'bilingual' | 'target',
): Promise<void> {
  return new Promise((resolve) => {
    let applied = false;
    const frameId = requestAnimationFrame(() => {
      applied = true;
      applyTranslations(translationMap, nodeMap, mode);
      resolve();
    });
    setTimeout(() => {
      if (applied) return;
      cancelAnimationFrame(frameId);
      applyTranslations(translationMap, nodeMap, mode);
      resolve();
    }, 5000);
  });
}
