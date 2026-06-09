import browser from 'webextension-polyfill';
import { prepareDocument, type Chunk } from '../utils/contentHelper';
import { buildNodeMap, type TextBlock } from '../utils/blockExtractor';
import { getConfig } from '../utils/config';
import { DOMObserverManager } from '../utils/domObserver';
import {
  applyBlockTranslation,
  restoreBlock,
  toggleBlockTranslation,
} from '../utils/translationDisplay';
import {
  buildRetryChunk,
  diffMissingIds,
  shouldRetryMissing,
} from '../utils/chunkRetry';
import { buildChunks } from '../utils/chunkBuilder';
import { extractGlossaryLocal } from '../utils/glossaryExtractor';
import { showStatus, hideStatus } from './statusOverlay';
import { updateButtonState } from './floatingButton';

/**
 * 翻译流程控制：把页面上所有可翻译文本块 → 调 API → 写回 DOM。
 *
 * 这是 content script 的核心模块，分三层：
 *   1. handleFullTranslation()        — 整页翻译编排（提取→术语→分块→批量翻译→重试→标记）
 *   2. translateChunksViaBackground() — 串行处理每个 chunk（call API → 解析 → 应用 → 立即重试）
 *   3. translateChunkPayload()        — 单个 chunk 的全流程（含 per-chunk retry 递归）
 *
 * 关键设计：
 *   - per-chunk retry 在每次 API 返回后立即触发（不是所有 chunk 跑完才重试），
 *     用户在主进度条上看不到中间态
 *   - 全局重试作为兜底：主循环后再次扫 missing，1-3 块小 chunk 走一次 fresh API
 *   - fanyi-missing class 标记：所有重试都失败时给用户视觉提示
 *   - 动态内容监听：翻译完成后，DOM 变化触发的新 block 走单块翻译
 */

// ============================================================
// 顶层 Controller：暴露给 index.ts 的三个动作
// ============================================================

/** 共享状态：在主流程中累积，restore 时用。 */
export interface TranslationState {
  originalTexts: Map<string, string>;
  translatedBlocks: Set<string>;
}

export interface TranslationController {
  /** 启动/恢复整页翻译（防重入：翻译中再次调用直接返回）。 */
  start(): Promise<void>;
  /** 恢复原文，清理 .fanyi-translated / .fanyi-missing 标记。 */
  restore(): void;
  /** 切换译文显示/隐藏（不重新翻译，只 toggle .fanyi-translated 类）。 */
  toggle(): void;
  /** 当前是否处于"已翻译"状态。 */
  isTranslated(): boolean;
}

export function createTranslationController(
  isMobile: boolean,
  state: TranslationState,
): TranslationController {
  let isTranslating = false;
  let isTranslatedState = false;
  let domObserver: DOMObserverManager | null = null;

  // 闭包注入：translateChunksViaBackground 在串行循环里读 isMobile 决定
  // 块间延迟；createTranslationController 的其他闭包（start/restore）
  // 也会用到 isMobile。一并闭包注入避免每个函数都加参数。
  const ctx = { isMobile };

  return {
    async start() {
      if (isTranslating) return;
      if (isTranslatedState || isPageTranslated()) {
        showStatus('页面已翻译', 'success');
        setTimeout(hideStatus, 2000);
        return;
      }

      const config = await getConfig();
      if (!config.deepseekApiKey) {
        showStatus('API Key 没有配置', 'error');
        setTimeout(hideStatus, 3000);
        return;
      }
      if (!config.enabled) return;

      isTranslating = true;
      showStatus('正在提取文本...', 'loading');

      try {
        const result = await handleFullTranslation(
          config,
          ctx.isMobile,
          state,
          (observer) => { domObserver = observer; },
        );
        isTranslatedState = result.translated;
        if (result.observer) {
          domObserver = result.observer;
          // 保留引用以便未来 restore 时能停止监听（目前未使用）
          void domObserver;
        }
      } catch (error) {
        console.error('Translation failed:', error);
        showStatus(error instanceof Error ? error.message : '翻译失败', 'error');
      } finally {
        isTranslating = false;
      }
    },

    restore() {
      isTranslatedState = false;
      restoreOriginal();
    },

    toggle() {
      toggleTranslation();
    },

    isTranslated() {
      return isTranslatedState || isPageTranslated();
    },
  };
}

// ============================================================
// 整页翻译编排
// ============================================================

interface TranslationResult {
  translated: boolean;
  observer: DOMObserverManager | null;
}

async function handleFullTranslation(
  config: { sourceLang: string; targetLang: string; mode: 'bilingual' | 'target' },
  isMobile: boolean,
  state: TranslationState,
  setObserver: (obs: DOMObserverManager | null) => void,
): Promise<TranslationResult> {
  console.log('[ContentScript] handleFullTranslation called, config:', config);

  // 1) 提取阶段
  console.log('[ContentScript] Calling prepareDocument...');
  const { blocks, chunks, fullText } = prepareDocument(document);
  console.log('[ContentScript] prepareDocument result:', {
    blocksCount: blocks.length,
    chunksCount: chunks.length,
    fullTextLength: fullText.length,
  });
  console.log(`[ContentScript] API Request Estimate: ${chunks.length} requests`);

  if (blocks.length === 0) {
    throw new Error('没有找到可翻译的内容');
  }

  showStatus(`共 ${blocks.length} 个文本块`, 'loading');

  // 2) DOM 节点映射 + 保存原文
  const nodeMap = buildNodeMap(blocks, document);
  console.log('[ContentScript] nodeMap size:', nodeMap.size, 'blocks length:', blocks.length);
  warnOnNodeMapMismatch(blocks, nodeMap);
  saveOriginalTexts(blocks, nodeMap, state);

  // 3) 术语表提取（仅在文本量足够时执行）
  const glossary = await extractGlossary(fullText);

  // 4) 批量翻译（含 per-chunk retry）
  showStatus(`翻译进度: 0/${chunks.length}`, 'loading');
  const { translatedIds } = await translateChunksViaBackground(
    chunks,
    config.sourceLang,
    config.targetLang,
    nodeMap,
    config.mode,
    glossary,
    (current, total) => showStatus(`翻译进度: ${current}/${total}`, 'loading'),
    isMobile,
  );

  // 5) 全局 missing 兜底重试（per-chunk retry 没救回来的 + 罕见的边缘 case）
  await retryGlobalMissing(blocks, nodeMap, translatedIds, config, isMobile);

  // 6) 标记 + 收尾
  const missingIds = markMissingBlocks(nodeMap, translatedIds);
  updateButtonState(true);
  console.log(
    `[ContentScript] Translation applied: ${nodeMap.size} blocks total, ${translatedIds.size} translated, ${missingIds.length} missing`,
  );

  // 7) 动态内容监听
  const observer = setupDynamicContentObserver(state);
  setObserver(observer);

  // 8) 清理临时 data 属性（这些是中间过程用的，翻译完该清掉）
  cleanupTempAttrs();

  const statusMsg =
    missingIds.length > 0
      ? `翻译完成（${missingIds.length} 段未返回，可重试）`
      : '翻译完成';
  showStatus(statusMsg, 'success');
  setTimeout(hideStatus, 3000);

  return { translated: true, observer };
}

// ============================================================
// 子流程 1：术语表
// ============================================================

async function extractGlossary(
  fullText: string,
): Promise<Array<{ term: string; translation: string }>> {
  if (fullText.length < 50) return [];

  showStatus('正在提取术语表...', 'loading');
  try {
    // 1) 抓 <em>/<strong>/<code> 标签内的强调文本作为候选术语
    const emphasizedTerms: string[] = [];
    for (const tag of ['em', 'strong', 'code']) {
      for (const el of document.querySelectorAll(tag)) {
        const text = el.textContent?.trim();
        if (text && text.length > 1 && text.length < 80) {
          emphasizedTerms.push(text);
        }
      }
    }

    // 2) 用前 4000 字符做本地启发式抽取（不需要额外 API 调用）
    const sample = fullText.substring(0, 4000);
    const glossary = extractGlossaryLocal(sample, emphasizedTerms);
    console.log('[ContentScript] Glossary extracted:', glossary.length, 'terms');
    for (const entry of glossary) {
      console.log(`[ContentScript]   "${entry.term}" → "${entry.translation}"`);
    }
    return glossary;
  } catch (error) {
    console.warn('[ContentScript] Glossary extraction failed, proceeding without:', error);
    return [];
  }
}

// ============================================================
// 子流程 2：块翻译（带 per-chunk retry）
// ============================================================

async function translateChunksViaBackground(
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
  let completedCount = 0;
  let hasFailure = false;
  const applyPromises: Promise<void>[] = [];
  const translatedIds = new Set<string>();

  for (let i = 0; i < chunks.length; i++) {
    await translateChunkPayload(
      chunks[i],
      /* isRetry */ false,
      {
        nodeMap,
        mode,
        sourceLang,
        targetLang,
        glossary,
        onFailure: () => { hasFailure = true; },
        onApply: (chunkMap) => applyPromises.push(applyTranslationsWithRAF(chunkMap, nodeMap, mode)),
        translatedIds,
      },
    );
    completedCount++;
    onProgress?.(completedCount, chunks.length);
    // 移动端每块间多等 200ms，避免 API rate limit
    if (i < chunks.length - 1 && isMobile) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  await Promise.all(applyPromises);
  console.log(
    '[ContentScript] translateChunksViaBackground complete, allSucceeded:',
    !hasFailure,
    'translatedIds:',
    translatedIds.size,
  );
  return { allSucceeded: !hasFailure, translatedIds };
}

interface ChunkCallContext {
  nodeMap: Map<string, Node>;
  mode: 'bilingual' | 'target';
  sourceLang: string;
  targetLang: string;
  glossary: Array<{ term: string; translation: string }>;
  /** 业务失败时回调（影响 hasFailure）。 */
  onFailure: () => void;
  /** 成功解析后回调，把 DOM 应用推入 applyPromises 队列。 */
  onApply: (chunkMap: Map<string, string>) => void;
  /** 累加 set。 */
  translatedIds: Set<string>;
}

/**
 * 单 chunk 全流程：sendMessage → 解析 → 写入 chunkMap → 应用到 DOM → per-chunk retry。
 *
 * 内部用 `ctx` 把"外部世界"（state + callbacks）注入，避免 8 个参数平铺。
 * `isRetry=true` 时跳过 per-chunk retry（递归 cap 1）。
 */
async function translateChunkPayload(
  chunk: Chunk,
  isRetry: boolean,
  ctx: ChunkCallContext,
): Promise<Map<string, string>> {
  const chunkMap = new Map<string, string>();
  const inputIds = chunk.blocks.map((b) => b.id);
  const label = isRetry ? `${chunk.id}(retry)` : chunk.id;

  console.log(`[ContentScript] Translating ${label}, blocks: ${chunk.blocks.length}`);
  const startTime = Date.now();

  try {
    const response: any = await browser.runtime.sendMessage({
      action: 'translateChunk',
      jsonContent: chunk.jsonContent,
      sourceLang: ctx.sourceLang,
      targetLang: ctx.targetLang,
      pageUrl: window.location.href,
      glossary: ctx.glossary,
    });
    const elapsed = Date.now() - startTime;
    console.log(`[ContentScript] ${label} response time: ${elapsed}ms, success: ${response.success}`);

    // === 业务失败：response.success === false ===
    if (!response.success) {
      ctx.onFailure();
      // [FailureTrace] 失败时把整个 response 对象打全：error 字段
      // 之外 background.ts 还会带 debugInfo（name + stack 前 300 字
      // 节）。出现未知字段（如 'retryAfter' / 'code'）也能直接看到，
      // 不用再回头翻 background 的 catch 分支。
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
      return chunkMap;
    }

    // === 成功：解析 entry → 写入 chunkMap + translatedIds ===
    console.log(`[ContentScript] ${label} result blocks:`, response.result?.length || 0);
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
      console.log(`[ContentScript]   Translated block ${id}:`, text.substring(0, 40));
      chunkMap.set(id, text);
      outputIds.push(id);
      ctx.translatedIds.add(id);
    }

    // [ChunkTrace] input/output 对比，缺失的 id 会在 [Background] 端配合
    // 打 inputBlocks/outputBlocks/missingInResponse 三元组。
    const chunkMissing = diffMissingIds(inputIds, outputIds);
    console.log(
      `[ContentScript][ChunkTrace] chunk=${label}`,
      `inputIds=[${inputIds.join(',')}]`,
      `outputIds=[${outputIds.join(',')}]`,
      `missing=[${chunkMissing.join(',')}]`,
    );
    if (chunkMissing.length > 0) {
      console.warn(
        `[ContentScript][ChunkTrace] chunk=${label} missing ${chunkMissing.length} blocks — see [Background][ChunkTrace] for max_tokens / response details`,
        chunkMissing.map((id) => {
          const b = chunk.blocks.find((x) => x.id === id);
          return `${id}(${b?.tag},${b?.text.length}ch):${b?.text.slice(0, 50)}`;
        }),
      );
    }

    // DOM 应用（异步等下一帧，避免阻塞主流程）
    ctx.onApply(chunkMap);

    // === Per-chunk retry ===
    // policy 见 utils/chunkRetry.shouldRetryMissing：
    //   - 已是 retry → 停止递归
    //   - missing = 0 → 无事可做
    //   - missing >= 50% → API 整体坏，retry 无效
    //   - 其他：单块小 chunk 走 fresh API call
    if (
      shouldRetryMissing({
        missingCount: chunkMissing.length,
        totalCount: chunk.blocks.length,
        isRetry,
      })
    ) {
      const retryChunk = buildRetryChunk(chunk, chunkMissing);
      console.log(
        `[ContentScript] ${label} missing ${chunkMissing.length} block(s), retrying as ${retryChunk.id} (${retryChunk.blocks.length} block(s))`,
        chunkMissing,
      );
      const retryMap = await translateChunkPayload(retryChunk, true, ctx);
      const recoveredIds: string[] = [];
      for (const id of retryMap.keys()) {
        if (!ctx.translatedIds.has(id)) {
          ctx.translatedIds.add(id);
          recoveredIds.push(id);
        }
      }
      console.log(
        `[ContentScript] ${label} retry recovered ${recoveredIds.length}/${chunkMissing.length} block(s)`,
        recoveredIds,
      );
    }
  } catch (error) {
    // === 运行时错误：response 根本不存在，sendMessage 抛错 ===
    ctx.onFailure();
    console.error(
      `[ContentScript] ${label} threw — runtime/network error (no response):`,
      {
        name: error instanceof Error ? error.name : 'unknown',
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack?.substring(0, 500) : null,
      },
    );
  }
  return chunkMap;
}

/**
 * 把译文写回 DOM：用 requestAnimationFrame 等下一帧批量应用，
 * 避免一次性 reflow 阻塞主线程。5s fallback 防止 hidden tab 时 rAF 不触发。
 */
function applyTranslationsWithRAF(
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

// ============================================================
// 子流程 3：全局 missing 兜底重试
// ============================================================

async function retryGlobalMissing(
  blocks: TextBlock[],
  nodeMap: Map<string, Node>,
  translatedIds: Set<string>,
  config: { sourceLang: string; targetLang: string; mode: 'bilingual' | 'target' },
  isMobile: boolean,
): Promise<void> {
  const stillMissingIds: string[] = [];
  for (const [id] of nodeMap) {
    if (!translatedIds.has(id)) stillMissingIds.push(id);
  }
  if (stillMissingIds.length === 0) return;

  // 与 shouldRetryMissing 一致的策略：缺任何块就重试。
  // 历史版本曾用 50% 阈值短路掉全局兜底（理由"API 整体坏"），但这个
  // 启发式在 100% 缺失场景下适得其反——per-chunk 重试可能全部失败，导致
  // 整页 yellow，没有任何补译机会。全局重试用 buildChunks 重新切分，
  // 小 chunk 给模型更好的成功率；最坏情况只是多几次 API round-trip。
  console.log(
    `[ContentScript] Global retry: ${stillMissingIds.length}/${nodeMap.size} blocks still missing`,
  );

  showStatus(`补译 ${stillMissingIds.length} 段...`, 'loading');
  console.log(`[ContentScript] Retrying ${stillMissingIds.length} missing block(s):`, stillMissingIds);

  const missingSet = new Set(stillMissingIds);
  const retryBlocks = blocks.filter((b) => missingSet.has(b.id));
  // 1-3 块小 chunk 用 buildChunks 切分（首 chunk cap = 12，但 1-3 块必然一桶装下）
  const retryChunks = buildChunks(retryBlocks);
  console.log(`[ContentScript] Retry built ${retryChunks.length} chunk(s) from ${retryBlocks.length} block(s)`);

  const { translatedIds: retryTranslatedIds } = await translateChunksViaBackground(
    retryChunks,
    config.sourceLang,
    config.targetLang,
    nodeMap,
    config.mode,
    [],
    undefined,
    isMobile,
  );

  let recoveredCount = 0;
  for (const id of retryTranslatedIds) {
    if (!translatedIds.has(id)) {
      translatedIds.add(id);
      recoveredCount++;
    }
  }
  console.log(`[ContentScript] Retry recovered ${recoveredCount}/${stillMissingIds.length} block(s)`);
}

// ============================================================
// 子流程 4：missing 标记 + 状态收尾
// ============================================================

function markMissingBlocks(
  nodeMap: Map<string, Node>,
  translatedIds: Set<string>,
): string[] {
  const missingIds: string[] = [];
  for (const [id, node] of nodeMap) {
    if (translatedIds.has(id)) continue;
    missingIds.push(id);
    if (node instanceof HTMLElement) {
      node.classList.add('fanyi-missing');
      node.title = '翻译响应中缺少该段落，点击扩展图标重新翻译';
    }
  }
  if (missingIds.length > 0) {
    console.warn(
      `[ContentScript] ${missingIds.length} block(s) had no translation in the API response:`,
      missingIds,
    );
  }
  return missingIds;
}

// ============================================================
// 状态工具
// ============================================================

function isPageTranslated(): boolean {
  return document.querySelector('.fanyi-translated') !== null;
}

function warnOnNodeMapMismatch(blocks: TextBlock[], nodeMap: Map<string, Node>): void {
  if (nodeMap.size === blocks.length) return;
  console.warn('[ContentScript] Mismatch: some blocks not found in DOM!');

  const blockIds = new Set(blocks.map((b) => b.id));
  const nodeMapIds = new Set(nodeMap.keys());
  const missingIds = [...blockIds].filter((id) => !nodeMapIds.has(id));
  console.warn('[ContentScript] Missing block IDs:', missingIds);
  for (const id of missingIds) {
    const block = blocks.find((b) => b.id === id);
    if (block) {
      console.warn(
        '[ContentScript] Missing block detail:',
        id,
        'tag:',
        block.tag,
        'xpath:',
        block.xpath,
        'text:',
        block.text.substring(0, 60),
      );
    }
  }
  console.log(
    '[ContentScript] All blocks summary:',
    blocks.map((b) => `${b.id}(${b.tag}): ${b.text.substring(0, 50)}`).join(' | '),
  );
}

function saveOriginalTexts(
  blocks: TextBlock[],
  nodeMap: Map<string, Node>,
  state: TranslationState,
): void {
  let saved = 0;
  for (const block of blocks) {
    const node = nodeMap.get(block.id);
    if (node && node instanceof HTMLElement) {
      state.originalTexts.set(block.id, node.textContent || '');
      saved++;
    }
  }
  console.log('[ContentScript] saveOriginalTexts saved:', saved, '/', blocks.length);
}

function applyTranslations(
  translationMap: Map<string, string>,
  nodeMap: Map<string, Node>,
  mode: 'bilingual' | 'target',
): void {
  console.log(
    '[ContentScript] applyTranslations called, translationMap size:',
    translationMap.size,
    'nodeMap size:',
    nodeMap.size,
  );
  for (const [blockId, translatedText] of translationMap) {
    const node = nodeMap.get(blockId);
    if (!node || !(node instanceof HTMLElement)) {
      console.warn('[ContentScript] applyTranslations SKIP:', blockId, 'node not found in nodeMap or not HTMLElement');
      continue;
    }
    console.log(
      '[ContentScript] applyTranslations APPLY:',
      blockId,
      'tag:',
      node.tagName?.toLowerCase(),
      'text:',
      node.textContent?.substring(0, 40),
    );
    applyBlockTranslation(node, translatedText, mode);
  }
}

function cleanupTempAttrs(): void {
  const tempAttrNodes = document.querySelectorAll('[data-fanyi-block-id]');
  for (const node of Array.from(tempAttrNodes)) {
    const el = node as HTMLElement;
    delete el.dataset.fanyiBlockId;
  }
}

function restoreOriginal(): void {
  // 1) 清理 .fanyi-translated 节点
  for (const node of Array.from(document.querySelectorAll('.fanyi-translated'))) {
    restoreBlock(node as HTMLElement);
  }
  // 2) 清理 .fanyi-missing 节点（去掉黄底 + 提示）
  for (const node of Array.from(document.querySelectorAll('.fanyi-missing'))) {
    const el = node as HTMLElement;
    el.classList.remove('fanyi-missing');
    el.removeAttribute('title');
  }
  // 3) 清理临时 data 属性
  cleanupTempAttrs();
  // 4) 按钮回退到"译"
  updateButtonState(false);
  showStatus('已恢复原文', 'success');
  setTimeout(hideStatus, 2000);
}

function toggleTranslation(): void {
  for (const node of Array.from(document.querySelectorAll('.fanyi-translated'))) {
    toggleBlockTranslation(node as HTMLElement);
  }
}

// ============================================================
// 动态内容：监听 DOM 变化 → 单块翻译
// ============================================================

function setupDynamicContentObserver(
  state: TranslationState,
): DOMObserverManager {
  const observer = new DOMObserverManager(
    async (newBlocks: TextBlock[]) => {
      console.log('[ContentScript] Dynamic content detected:', newBlocks.length, 'new blocks');
      const config = await getConfig();
      for (const block of newBlocks) {
        if (!block.text || block.text.length <= 10) continue;
        try {
          const response: any = await browser.runtime.sendMessage({
            action: 'translateChunk',
            jsonContent: JSON.stringify([{ id: block.id, text: block.text }]),
            sourceLang: config.sourceLang,
            targetLang: config.targetLang,
            pageUrl: window.location.href,
          });
          if (response.success && response.result?.length > 0) {
            const node = findNodeByText(block.text);
            if (node) {
              applyBlockTranslation(node, response.result[0][1], config.mode);
              state.translatedBlocks.add(block.id);
              console.log('[ContentScript] Dynamic block translated:', block.id);
            }
          }
        } catch (error) {
          console.error('Dynamic content translation failed:', error);
        }
      }
    },
    () => {},
    /* debounceMs */ 1500,
  );
  observer.startMutationObserver();
  return observer;
}

/**
 * 在 DOM 中按文本内容查找节点（用于动态内容的"回写"）。
 * 跳过已翻译节点（避免循环 apply）。
 */
function findNodeByText(text: string): HTMLElement | null {
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node: Node): number => {
        const el = node as Element;
        if (el.classList.contains('fanyi-translated')) return NodeFilter.FILTER_REJECT;
        if (el.textContent?.trim() === text) return NodeFilter.FILTER_ACCEPT;
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

  let current: Element | null;
  while ((current = walker.nextNode() as Element | null)) {
    if (current.textContent?.trim() === text) {
      return current as HTMLElement;
    }
  }
  return null;
}
