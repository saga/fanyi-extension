import browser from 'webextension-polyfill';
import type { Chunk } from '../utils/contentHelper';
import { mergeSegmentTranslations } from '../utils/chunkBuilder';
import type { Glossary } from '../service/_service';
import { TranslationQueue } from '../utils/translationQueue';
import {
  buildRetryChunk,
  diffMissingIds,
  shouldRetryMissing,
} from '../utils/chunkRetry';
import { applyBlockTranslation } from '../utils/translationDisplay';
import type { TranslationState } from './translationTypes';
import type { TranslateChunkResponse } from '../../types/messages';
import type { PromptStyle, TranslationMode } from '../service/deepseek';

import { logger } from '../../utils/logger';

/**
 * Page-level literary post-edit prompt. The shared translation service still owns the outer
 * [{ id, translated_text }] response contract, so each translated_text must itself be a JSON
 * string containing finalTranslation/findings; the caller parses that inner object by id.
 * Do not build a glossary here: the source and draft plus the nearby page context are the only
 * evidence available for this independent editorial pass.
 */
function buildLiteraryPageReviewInstructions(): string {
  return [
    '你是文学翻译的独立第二遍编辑。输入的每个 text 字段是一段 JSON 字符串，包含 source（原文）、draft（初译）和 kind。请编辑译文，不要把这段 JSON 当成要展示给读者的正文。',
    '目标是准确、自然、有文学质感的目标语言表达：修正生硬直译、别扭搭配、机械句序、无意义连接词、解释性补句、情绪词不准、人物声音同质化和被抹平的节奏。尊重原文简洁、重复、停顿、留白、歧义、反讽与潜台词。',
    '准确性优先。不可漏译、误译、增加事实、改动人物关系、否定、时态、视角或因果；不得为了华丽而新增比喻、情绪或解释。候选实体/人名/地名/物品名须按原文和输入片段一致处理；不要创建术语表，也不要因为英文大写而保留普通词。',
    '仅在有明确文本依据时记录 finding。category 只能为 accuracy、terminology 或 style；前两类 priority=must_fix，style priority=optional。style 必须指出具体翻译腔或节奏/语气问题，不能只是个人审美。',
    '必须遵守通用输出格式：每个输入 id 返回一个 translated_text；translated_text 的值必须是严格 JSON 字符串，形如 {"finalTranslation":"完整修订译文","findings":[{"category":"accuracy|terminology|style","priority":"must_fix|optional","sourceExcerpt":"原文短引","draftExcerpt":"初译问题短引","reason":"具体理由","suggestion":"修订建议"}]}。没有问题时 findings=[]，finalTranslation 原样保留 draft。不要在 translated_text 外添加字段或 Markdown。',
  ].join('\\n');
}
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

/**
 * 校验模型返回的块结果，只允许本次请求中的 ID 和非空译文进入成功集合。
 * 单独暴露为纯函数，方便回归测试“陌生 ID/空译文不能被计为成功”。
 */
export function normalizeChunkTranslationEntries(
  entries: unknown,
  expectedIds: readonly string[],
): Map<string, string> {
  const expected = new Set(expectedIds);
  const normalized = new Map<string, string>();
  if (!Array.isArray(entries)) {
    logger.warn('[ContentScript] Translation response result is not an array.');
    return normalized;
  }

  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      logger.warn('[ContentScript] Skipping malformed entry:', entry);
      continue;
    }
    const [id, text] = entry as unknown[];
    if (typeof id !== 'string' || !expected.has(id)) {
      logger.warn('[ContentScript] Ignoring unexpected block ID:', id);
      continue;
    }
    if (typeof text !== 'string' || !text.trim()) {
      logger.warn('[ContentScript] Skipping block ' + id + ': translation is empty or not a string.');
      continue;
    }
    if (normalized.has(id)) {
      logger.warn('[ContentScript] Ignoring duplicate response entry for block:', id);
      continue;
    }
    normalized.set(id, text);
  }
  return normalized;
}

// ============================================================
// Chunk dispatch — warmup-then-parallel
// ============================================================

export interface ChunkCallContext {
  nodeMap: Map<string, Node>;
  sourceLang: string;
  targetLang: string;
  glossary: Glossary;
  /**
   * 页级语言检测后解析出的文风。随消息传给 background，避免 background
   * 只能读 config.promptStyle（那样会把日语页面的 default 又打回通用直译）。
   */
  promptStyle?: PromptStyle;
  translationMode: TranslationMode;
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
 * 前 2 个串行（帮助远程 KV cache 构建），后续并行（桌面 4 / 移动 2）。
 * 本机 Agent 没有 KV cache 收益，调用方传 skipWarmup=true 直接全并行，
 * 省掉 2 个串行预热（本机每单约 10s，预热即 20s）。
 */
export async function translateChunksViaBackground(
  chunks: Chunk[],
  sourceLang: string,
  targetLang: string,
  nodeMap: Map<string, Node>,
  glossary: Glossary,
  onProgress?: (current: number, total: number) => void,
  isMobile: boolean = false,
  state?: TranslationState,
  promptStyle?: PromptStyle,
  skipWarmup: boolean = false,
  translationMode: TranslationMode = 'technical',
): Promise<{ allSucceeded: boolean; translatedIds: Set<string> }> {
  const runStartedAt = Date.now();
  logger.debug('[ContentScript] translateChunksViaBackground called, chunks:', chunks.length);

  const maxConcurrency = isMobile ? 2 : 4;
  logger.debug(
    `[ContentScript] Warmup serial, then parallel=${maxConcurrency} (isMobile=${isMobile})`,
  );

  // pool starts at concurrency=1 (serial); addAllWithWarmup bumps after warmup
  const pool = new TranslationQueue(1, 0, 0);

  let completedCount = 0;
  let hasFailure = false;
  const applyPromises: Promise<void>[] = [];
  const translatedIds = new Set<string>();
  const segmentBlockById = new Map<string, Chunk['blocks'][number]>();
  const segmentTranslations = new Map<string, string>();
  for (const chunk of chunks) {
    for (const block of chunk.blocks) {
      if (block.segmentOf) segmentBlockById.set(block.id, block);
    }
  }
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
          sourceLang,
          targetLang,
          glossary,
          promptStyle,
          translationMode,
          onFailure: () => { hasFailure = true; },
          onApply: (chunkMap) => {
            const directMap = new Map<string, string>();
            for (const [id, text] of chunkMap) {
              if (segmentBlockById.has(id)) segmentTranslations.set(id, text);
              else directMap.set(id, text);
            }
            if (directMap.size > 0) {
              applyPromises.push(applyTranslationsWithRAF(directMap, nodeMap, state));
            }
          },
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

  if (skipWarmup) {
    // 本机模式：无 KV cache 可建，直接全并行。
    pool.setConcurrency(maxConcurrency);
    await Promise.all(tasks.map((task) => pool.add(task)));
  } else {
    await pool.addAllWithWarmup(tasks, 2, maxConcurrency);
  }
  await Promise.all(applyPromises);

  if (segmentBlockById.size > 0) {
    // 分片不能逐片写回同一个 DOM 元素，否则最后一个片段会覆盖前面的内容。
    // 所有片段成功后才合并并回填原始块；任意片段缺失时保留原文并报告 missing。
    for (const segmentId of segmentBlockById.keys()) translatedIds.delete(segmentId);
    const mergedSegments = mergeSegmentTranslations(chunks, segmentTranslations);
    for (const originalId of mergedSegments.keys()) translatedIds.add(originalId);
    if (mergedSegments.size > 0) {
      await applyTranslationsWithRAF(mergedSegments, nodeMap, state);
    }
  }

  const errorCatStr = Object.keys(stats.errorsByCategory).length > 0
    ? ' ' + Object.entries(stats.errorsByCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(',')
    : '';
  // 整轮摘要常开（info）：排查"慢"时只看这一行就能拿到总数、成功率与耗时，
  // 不用开 fanyi-debug。明细（每 chunk 的 ids/trace）仍在 debug 里。
  logger.info(
    `[ContentScript][SessionSummary] total=${chunks.length} ` +
    `fullyOk=${stats.fullyOk} ` +
    `neededRetry=${stats.neededRetry}(recovered=${stats.neededRetryRecovered},stillMissing=${stats.neededRetryStillMissing}) ` +
    `hardFailed=${stats.hardFailed}${errorCatStr}` +
    (stats.firstErrorMsg ? ` firstError="${stats.firstErrorMsg.substring(0, 100)}"` : '') +
    ` wallMs=${Date.now() - runStartedAt} warmupSkipped=${skipWarmup}`,
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
    const response = await browser.runtime.sendMessage({
      action: 'translateChunk',
      jsonContent: chunk.jsonContent,
      sourceLang: ctx.sourceLang,
      targetLang: ctx.targetLang,
      pageUrl: window.location.href,
      glossary: ctx.glossary,
      promptStyle: ctx.promptStyle,
      translationMode: ctx.translationMode,
    }) as TranslateChunkResponse;

    if (!response.success) {
      ctx.onFailure();
      logger.error(
        `[ContentScript] ${label} translation FAILED — full response:`,
        {
          success: response.success,
          error: response.error,
          debugInfo: response.debugInfo ?? null,
          rawResponse: response,
        },
      );
      if (!isRetry) {
        ctx.onChunkComplete('hard-failed', 0, 0, response.error || 'unknown');
      }
      return chunkMap;
    }

    const normalizedEntries = normalizeChunkTranslationEntries(response.result, inputIds);
    const outputIds = Array.from(normalizedEntries.keys());
    for (const [id, text] of normalizedEntries) {
      chunkMap.set(id, text);
      ctx.translatedIds.add(id);
    }

    const chunkMissing = diffMissingIds(inputIds, outputIds);
    if (!isRetry) outerMissingCount = chunkMissing.length;
    const missingHint =
      chunkMissing.length > 0
        ? ` (e.g. ${chunkMissing.slice(0, 3).join(',')}${chunkMissing.length > 3 ? `,+${chunkMissing.length - 3}` : ''})`
        : '';
    logger.debug(
      `[ContentScript][ChunkTrace] chunk=${label}`,
      `inputIds=[${inputIds.join(',')}]`,
      `outputIds=[${outputIds.join(',')}]`,
      `missing=${chunkMissing.length}${missingHint}`,
    );
    if (chunkMissing.length > 0) {
      logger.warn(
        `[ContentScript][ChunkTrace] chunk=${label} model returned ${outputIds.length}/${inputIds.length} entries — root cause in [Background][ChunkTrace] OUTPUT/MISSING`,
      );
      if (response.trace) {
        logger.warn(
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
      logger.debug(
        `[ContentScript] ${label} missing ${chunkMissing.length} block(s), retrying as ${retryChunk.id}`,
      );
      const retryMap = await translateChunkPayload(retryChunk, true, ctx);
      // 递归重试会先把成功的 ID 加入 ctx.translatedIds，因此不能再以该 Set
      // 判断是否“刚刚恢复”；应直接与本轮原本缺失的 ID 集合对账。
      const missingIdSet = new Set(chunkMissing);
      for (const id of retryMap.keys()) {
        if (missingIdSet.has(id) && !recoveredIds.includes(id)) {
          ctx.translatedIds.add(id);
          recoveredIds.push(id);
        }
      }
      logger.debug(
        `[ContentScript] ${label} retry recovered ${recoveredIds.length}/${chunkMissing.length} block(s)`,
      );
    }

    // Literary web pages use two model passes: initial translation, then independent copy-editing.
    // Drafts have already been applied for responsive UI; accepted revisions replace them here.
    // Reviewer failures are non-fatal and never turn a successful translation chunk into a failure.
    if (!isRetry && ctx.translationMode === 'literary' && chunkMap.size > 0) {
      const reviewBlocks = chunk.blocks.flatMap((block) => {
        const draft = chunkMap.get(block.id);
        return draft?.trim()
          ? [{
              id: block.id,
              text: JSON.stringify({
                source: block.text,
                draft,
                kind: block.tag || 'paragraph',
              }),
            }]
          : [];
      });
      if (reviewBlocks.length > 0) {
        try {
          const reviewResponse = await browser.runtime.sendMessage({
            action: 'translateChunk',
            jsonContent: JSON.stringify(reviewBlocks),
            sourceLang: ctx.sourceLang,
            targetLang: ctx.targetLang,
            pageUrl: window.location.href,
            promptStyle: ctx.promptStyle,
            translationMode: 'literary',
            taskInstructions: buildLiteraryPageReviewInstructions(),
          }) as TranslateChunkResponse;
          if (reviewResponse?.success) {
            const reviewed = normalizeChunkTranslationEntries(
              reviewResponse.result,
              reviewBlocks.map((block) => block.id),
            );
            const revised = new Map(chunkMap);
            let appliedRevision = false;
            for (const [id, raw] of reviewed) {
              if (!raw.trim()) continue;
              try {
                const parsed: unknown = JSON.parse(raw);
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
                const value = parsed as Record<string, unknown>;
                if (typeof value.finalTranslation !== 'string' || !value.finalTranslation.trim()) continue;
                const findings = Array.isArray(value.findings) ? value.findings : [];
                const actionable = findings.some((finding) =>
                  !!finding && typeof finding === 'object' && !Array.isArray(finding) &&
                  ['accuracy', 'terminology', 'style'].includes(
                    String((finding as Record<string, unknown>).category),
                  ),
                );
                if (actionable) {
                  revised.set(id, value.finalTranslation.trim());
                  appliedRevision = true;
                }
              } catch {
                // Bad review JSON is ignored; the already-visible first translation remains intact.
              }
            }
            if (appliedRevision) ctx.onApply(revised);
          } else {
            logger.warn('[ContentScript] Literary review did not succeed; preserving initial chunk translation:', reviewResponse?.error);
          }
        } catch (reviewError) {
          logger.warn('[ContentScript] Literary review failed; preserving initial chunk translation:',
            reviewError instanceof Error ? reviewError.message : String(reviewError));
        }
      }
    }

    if (!isRetry) {
      if (outerMissingCount === 0) {
        ctx.onChunkComplete('fully-ok', 0, 0);
      } else {
        const stillMissing = Math.max(0, outerMissingCount - recoveredIds.length);
        // 只有所有缺失 ID 都被重试恢复时，批次才算成功；模型返回 HTTP 200 但漏块
        // 不能让 allSucceeded 继续保持 true。
        if (stillMissing > 0) ctx.onFailure();
        ctx.onChunkComplete('needed-retry', recoveredIds.length, stillMissing);
      }
    }
  } catch (error) {
    ctx.onFailure();
    logger.error(
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
  state?: TranslationState,
): void {
  for (const [blockId, translatedText] of translationMap) {
    const node = nodeMap.get(blockId);
    if (!node || !(node instanceof HTMLElement)) continue;
    applyBlockTranslation(node, translatedText);
    // 保存译文映射，用于 React/Next.js 重新渲染后恢复
    if (state && state.translatedTexts) {
      state.translatedTexts.set(blockId, translatedText);
    }
  }
}

/**
 * 把译文写回 DOM：用 requestAnimationFrame 等下一帧批量应用，
 * 避免一次性 reflow 阻塞主线程。5s fallback 防止 hidden tab 时 rAF 不触发。
 */
export function applyTranslationsWithRAF(
  translationMap: Map<string, string>,
  nodeMap: Map<string, Node>,
  state?: TranslationState,
): Promise<void> {
  return new Promise((resolve) => {
    let applied = false;
    const frameId = requestAnimationFrame(() => {
      applied = true;
      applyTranslations(translationMap, nodeMap, state);
      resolve();
    });
    setTimeout(() => {
      if (applied) return;
      cancelAnimationFrame(frameId);
      applyTranslations(translationMap, nodeMap, state);
      resolve();
    }, 5000);
  });
}
