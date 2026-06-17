import { prepareDocument } from '../utils/contentHelper';
import { buildNodeMap } from '../utils/blockExtractor';
import { getConfig } from '../utils/config';
import { DOMObserverManager } from '../utils/domObserver';
import { extractGlossaryLocal } from '../utils/glossaryExtractor';
import { showStatus, hideStatus } from './statusOverlay';
import { updateButtonState } from './floatingButton';
import { translateChunksViaBackground } from './chunkTranslation';
import { translateViaServer } from './serverTranslation';
import {
  retryGlobalMissing,
  markMissingBlocks,
  isPageTranslated,
  warnOnNodeMapMismatch,
  saveOriginalTexts,
  restoreOriginal,
  toggleTranslation,
  setupDynamicContentObserver,
} from './translationUtils';
import type { TranslationState } from './translationTypes';

export type { TranslationState };

/**
 * 翻译流程控制：把页面上所有可翻译文本块 → 调 API → 写回 DOM。
 *
 * 这是 content script 的核心模块，分三层：
 *   1. handleFullTranslation()        — 整页翻译编排（提取→术语→分块→批量翻译→重试→标记）
 *   2. translateChunksViaBackground() — 串行/并行发送 chunk（chunkTranslation.ts）
 *   3. translateChunkPayload()        — 单个 chunk 全流程（chunkTranslation.ts）
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
      // 使用服务端翻译时不需要本地 API Key
      if (!config.useServerTranslation && !config.deepseekApiKey) {
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
  config: import('../utils/config').Config,
  isMobile: boolean,
  state: TranslationState,
  setObserver: (obs: DOMObserverManager | null) => void,
): Promise<TranslationResult> {
  const { blocks, chunks, fullText } = prepareDocument(document);

  if (blocks.length === 0) {
    throw new Error('没有找到可翻译的内容');
  }

  showStatus(`共 ${blocks.length} 个文本块`, 'loading');

  const nodeMap = buildNodeMap(blocks, document);
  warnOnNodeMapMismatch(blocks, nodeMap);
  saveOriginalTexts(blocks, nodeMap, state);

  // 使用服务端翻译
  if (config.useServerTranslation) {
    showStatus('正在发送到服务端翻译...', 'loading');
    const translatedIds = await translateViaServer(config, blocks, nodeMap);
    const missingIds = markMissingBlocks(nodeMap, translatedIds);
    updateButtonState(true);
    cleanupTempAttrs();
    console.log(
      `[ContentScript] Server translation end: ${nodeMap.size} blocks total, ${translatedIds.size} translated, ${missingIds.length} missing`,
    );
    const statusMsg =
      missingIds.length > 0
        ? `翻译完成（${missingIds.length} 段未返回）`
        : '翻译完成';
    showStatus(statusMsg, 'success');
    setTimeout(hideStatus, 3000);
    return { translated: true, observer: null };
  }

  const glossary = await extractGlossary(fullText);

  showStatus(`翻译进度: 0/${chunks.length}`, 'loading');
  const { translatedIds } = await translateChunksViaBackground(
    chunks,
    config.sourceLang,
    config.targetLang,
    nodeMap,
    glossary,
    (current, total) => showStatus(`翻译进度: ${current}/${total}`, 'loading'),
    isMobile,
  );

  await retryGlobalMissing(blocks, nodeMap, translatedIds, config, isMobile);

  const missingIds = markMissingBlocks(nodeMap, translatedIds);
  updateButtonState(true);

  const observer = setupDynamicContentObserver(state);
  setObserver(observer);

  cleanupTempAttrs();

  console.log(
    `[ContentScript] Session end: ${nodeMap.size} blocks total, ${translatedIds.size} translated, ${missingIds.length} missing`,
  );

  const statusMsg =
    missingIds.length > 0
      ? `翻译完成（${missingIds.length} 段未返回，可重试）`
      : '翻译完成';
  showStatus(statusMsg, 'success');
  setTimeout(hideStatus, 3000);

  return { translated: true, observer };
}

async function extractGlossary(
  fullText: string,
): Promise<import('../service/_service').Glossary> {
  if (fullText.length < 50) return {};

  showStatus('正在提取术语表...', 'loading');
  try {
    const emphasizedTerms: string[] = [];
    for (const tag of ['em', 'strong', 'code']) {
      for (const el of document.querySelectorAll(tag)) {
        const text = el.textContent?.trim();
        if (text && text.length > 1 && text.length < 80) {
          emphasizedTerms.push(text);
        }
      }
    }

    const sample = fullText.substring(0, 4000);
    return extractGlossaryLocal(sample, emphasizedTerms);
  } catch {
    return {};
  }
}


function cleanupTempAttrs(): void {
  const tempAttrNodes = document.querySelectorAll('[data-fanyi-block-id]');
  for (const node of Array.from(tempAttrNodes)) {
    const el = node as HTMLElement;
    delete el.dataset.fanyiBlockId;
  }
}
