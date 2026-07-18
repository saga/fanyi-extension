import { prepareDocument } from '../utils/contentHelper';
import { buildNodeMap } from '../utils/blockExtractor';
import { getConfig } from '../utils/config';
import { DOMObserverManager } from '../utils/domObserver';
import { extractGlossaryLocal } from '../utils/glossaryExtractor';
import { matchSiteRule } from '../../rules';
import { showStatus, hideStatus } from './statusOverlay';
import { translateChunksViaBackground } from './chunkTranslation';
import { translateViaServer, checkServerCache, applyServerTranslatedHtml, ServerTranslationError } from './serverTranslation';
import {
  isPdfJsViewer,
  translatePdfJsViewer,
  restorePdfJsViewer,
  togglePdfJsViewer,
} from './pdfjs';
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

import { logger } from '../../utils/logger';
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
 *   - 服务端翻译失败降级：5xx/网络错误时降级到本地 DeepSeek，避免直接抛错中断用户翻译
 */

// 防止服务端翻译反复失败导致无限降级循环：每次成功或非降级错误后重置。
// 模块级标志，在同一个 content script 生命周期内只允许降级一次。
let fallbackAttempted = false;

/**
 * 显示降级通知（不阻塞用户）。
 * 服务端翻译失败并降级到本地模式时，在页面右上角短暂提示。
 */
function showFallbackNotification(): void {
  const banner = document.createElement('div');
  banner.style.cssText =
    'position:fixed;top:10px;right:10px;background:#fff3cd;color:#856404;' +
    'padding:8px 16px;border-radius:4px;z-index:999999;font-size:14px;' +
    'box-shadow:0 2px 8px rgba(0,0,0,0.1);';
  banner.textContent = '服务端翻译失败,已临时降级到本地模式';
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), 5000);
}

// ============================================================
// 顶层 Controller：暴露给 index.ts 的三个动作
// ============================================================

export interface TranslationController {
  /** 启动/恢复整页翻译（防重入：翻译中再次调用直接返回）。 */
  start(): Promise<void>;
  /** 恢复原文，清理 .fanyi-translated / .fanyi-missing 标记。
   * @param silent 为 true 时不显示状态提示（用于 SPA 自动导航清理状态）。
   */
  restore(silent?: boolean): void;
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
        setTimeout(hideStatus, 4000);
        return;
      }

      const config = await getConfig();
      // 使用服务端翻译且 provider 不是 deepseek 时，才不需要本地 API Key；
      // 其他情况（本地翻译、或服务端翻译但 provider=deepseek）都需要 API Key。
      const needApiKey = !config.useServerTranslation || config.provider === 'deepseek';
      if (needApiKey && !config.deepseekApiKey) {
        showStatus('API Key 没有配置', 'error');
        setTimeout(hideStatus, 5000);
        return;
      }

      // PDF.js viewer：走独立的 canvas 覆盖层翻译流程。
      // PDF.js 把 PDF 内容渲染为 canvas 位图，.textLayer span 是透明的文字选择层，
      // 普通的 inline 双语翻译对它无效（译文继承 color: transparent，用户看不到）。
      // 这里改为在每段下方渲染可见的 div.fanyi-pdfjs-translation 覆盖层。
      if (isPdfJsViewer(document)) {
        isTranslating = true;
        showStatus('正在提取文本...', 'loading');
        try {
          const result = await translatePdfJsViewer(
            config,
            state,
            (msg, type) => {
              showStatus(msg, type);
            },
          );
          isTranslatedState = result.translated;
          if (result.translated) {
            showStatus(
              result.skippedCount > 0
                ? `翻译完成（${result.paragraphCount} 段，${result.skippedCount} 段过短已跳过）`
                : `翻译完成（${result.paragraphCount} 段）`,
              'success',
            );
            setTimeout(hideStatus, 5000);
          } else {
            showStatus('翻译失败：没有段落被翻译', 'error');
            setTimeout(hideStatus, 5000);
          }
        } catch (error) {
          logger.error('[PdfJs] Translation failed:', error);
          showStatus(error instanceof Error ? error.message : '翻译失败', 'error');
        } finally {
          isTranslating = false;
        }
        return;
      }

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
        logger.error('Translation failed:', error);
        showStatus(error instanceof Error ? error.message : '翻译失败', 'error');
      } finally {
        isTranslating = false;
      }
    },

    restore(silent = false) {
      isTranslatedState = false;
      // PDF.js viewer：移除覆盖层 div（不需要恢复 span 文本，原文 span 始终未修改）
      if (isPdfJsViewer(document)) {
        restorePdfJsViewer(document);
        state.originalTexts.clear();
        state.translatedBlocks.clear();
        state.translatedTexts.clear();
        if (!silent) {
          showStatus('已恢复原文', 'success');
          setTimeout(hideStatus, 4000);
        }
        return;
      }
      restoreOriginal(state, silent);
    },

    toggle() {
      // PDF.js viewer：toggle 覆盖层 div 的 display
      if (isPdfJsViewer(document)) {
        togglePdfJsViewer(document);
        return;
      }
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
  // 防御性检查：即使 start() 已经判断过，在真正发送请求前再确认一次，
  // 防止 content script 重新注入、或多入口同时触发导致重复翻译。
  if (isPageTranslated()) {
    logger.debug('[ContentScript] Page already translated, skip sending request.');
    return { translated: true, observer: null };
  }

  // 站点规则：forceDirectTranslation 强制走 direct deepseek，跳过服务端翻译。
  // YouTube 等重 SPA 站点 clone 整页 HTML 又慢又容易抓到动态内容。
  const siteRule = matchSiteRule(window.location.href)?.siteRule;
  const forceDirect = siteRule?.forceDirectTranslation === true;
  const skipGlossary = siteRule?.skipGlossary === true;
  const useServer = config.useServerTranslation && !forceDirect;

  // 服务端翻译模式下，先查询服务端缓存，命中即可跳过 prepareHtmlForServer 等重计算。
  let cachedHtml: string | null = null;
  if (useServer) {
    showStatus('正在检查服务端缓存...', 'loading');
    try {
      cachedHtml = await checkServerCache(config);
      if (cachedHtml) {
        logger.debug('[ContentScript] Server cache hit, skip heavy HTML preparation.');
      }
    } catch (e) {
      logger.error('[ContentScript] Server cache check failed:', e);
      // 缓存检查失败不阻塞，继续走正常翻译流程
    }
  }

  const { blocks, chunks, fullText } = prepareDocument(document);

  if (blocks.length === 0) {
    throw new Error('没有找到可翻译的内容');
  }

  showStatus(`共 ${blocks.length} 个文本块`, 'loading');

  const nodeMap = buildNodeMap(blocks, document);
  warnOnNodeMapMismatch(blocks, nodeMap);
  saveOriginalTexts(blocks, nodeMap, state);

  // 使用服务端翻译
  if (useServer) {
    // translatedIds 为 null 表示服务端翻译失败并已降级，需继续走本地翻译流程。
    let translatedIds: Set<string> | null = null;
    if (cachedHtml) {
      showStatus('正在应用服务端缓存...', 'loading');
      translatedIds = applyServerTranslatedHtml(cachedHtml, blocks, nodeMap);
    } else {
      showStatus('正在发送到服务端翻译...', 'loading');
      try {
        translatedIds = await translateViaServer(config, blocks, nodeMap);
        fallbackAttempted = false; // 成功后重置，允许下次再次降级
      } catch (err) {
        if (err instanceof ServerTranslationError && err.suggestFallback && !fallbackAttempted) {
          // 服务端 5xx / 网络错误：降级到本地 DeepSeek 模式，避免直接抛错中断翻译。
          fallbackAttempted = true;
          logger.warn(`服务端翻译失败(${err.statusCode}),降级到本地模式`);
          config.useServerTranslation = false;
          showFallbackNotification();
          // translatedIds 保持 null，跳出 if 块进入下方本地翻译流程
        } else {
          // 4xx 等不可降级错误，或已经降级过一次，直接抛出避免无限循环
          fallbackAttempted = false;
          throw err;
        }
      }
    }

    if (translatedIds) {
      const missingIds = markMissingBlocks(nodeMap, translatedIds);
      cleanupTempAttrs();
      logger.debug(
        `[ContentScript] Server translation end: ${nodeMap.size} blocks total, ${translatedIds.size} translated, ${missingIds.length} missing`,
      );
      const statusMsg =
        missingIds.length > 0
          ? `翻译完成（${missingIds.length} 段未返回）`
          : '翻译完成';
      showStatus(statusMsg, 'success');
      setTimeout(hideStatus, 5000);
      if (document.body) {
        document.body.dataset.fanyiTranslated = 'true';
      }
      return { translated: true, observer: null };
    }
    // 降级路径：translatedIds === null，继续执行下方本地翻译
  }

  const glossary = skipGlossary ? {} : await extractGlossary(fullText);

  showStatus(`翻译进度: 0/${chunks.length}`, 'loading');
  const { translatedIds } = await translateChunksViaBackground(
    chunks,
    config.sourceLang,
    config.targetLang,
    nodeMap,
    glossary,
    (current, total) => showStatus(`翻译进度: ${current}/${total}`, 'loading'),
    isMobile,
    state,
  );

  await retryGlobalMissing(blocks, nodeMap, translatedIds, config, isMobile);

  const missingIds = markMissingBlocks(nodeMap, translatedIds);

  const observer = setupDynamicContentObserver(state);
  setObserver(observer);

  cleanupTempAttrs();

  logger.debug(
    `[ContentScript] Session end: ${nodeMap.size} blocks total, ${translatedIds.size} translated, ${missingIds.length} missing`,
  );

  const statusMsg =
    missingIds.length > 0
      ? `翻译完成（${missingIds.length} 段未返回，可重试）`
      : '翻译完成';
  showStatus(statusMsg, 'success');
  setTimeout(hideStatus, 5000);

  if (document.body) {
    document.body.dataset.fanyiTranslated = 'true';
  }
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
