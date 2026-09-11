import { prepareDocument, createOverlayHider, type OverlayHider } from '../utils/contentHelper';
import { buildNodeMap } from '../utils/blockExtractor';
import { getConfig } from '../utils/config';
import { detectLanguage, shouldUseJapaneseSource } from '../utils/languageDetector';
import { DOMObserverManager } from '../utils/domObserver';
import { extractGlossaryLocal } from '../utils/glossaryExtractor';
import { matchSiteRule } from '../../rules';
import { showStatus, hideStatus } from './statusOverlay';
import { translateChunksViaBackground } from './chunkTranslation';
import { translateViaServer, checkServerCache, applyServerTranslatedHtml } from './serverTranslation';
import { rotateSessionId } from '../utils/session';
import type { PromptStyle } from '../service/deepseek';
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
 *   - 服务端翻译失败直接抛错：由 start() 的 catch 展示给用户，不再静默降级到本地翻译
 */

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
  let overlayHider: OverlayHider | null = null;
  const ctx = { isMobile };

  return {
    async start() {
      if (isTranslating) return;
      if (isTranslatedState || isPageTranslated()) {
        showStatus('页面已翻译（如需重新翻译请先恢复原文）', 'success');
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

      // 清理上一次翻译遗留的弹层猎手，避免重复 MutationObserver 泄漏。
      overlayHider?.stop();
      overlayHider = null;

      try {
        const result = await handleFullTranslation(
          config,
          ctx.isMobile,
          state,
          (observer) => { domObserver = observer; },
          (h) => { overlayHider = h; },
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
      // 停止动态弹层猎手（Poptins 等弹层不再需要隐藏）。
      overlayHider?.stop();
      overlayHider = null;
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
  setOverlayHider: (h: OverlayHider | null) => void,
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
    // 轮换新的翻译会话 id，让本次翻译的 check 与 page 两次请求共享同一 sid。
    rotateSessionId();
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

  // 启动动态弹层猎手：持续隐藏翻译开始后（如 Poptins 的
  // initiatePullPoptinsRequest 动态注入）才出现的全屏营销弹窗 / 通知层，
  // 避免其盖住整页造成"白屏"。restore 时停止。
  // 传入正文根，让猎手跳过正文根的祖先（如 Drupal 的 dialog-off-canvas-main-canvas），
  // 避免误藏整页容器 → 白屏。
  const articleRoot = document.querySelector('main, article, [role="main"]');
  const overlayHider = createOverlayHider(articleRoot);
  overlayHider.start();
  setOverlayHider(overlayHider);

  if (blocks.length === 0) {
    throw new Error('没有找到可翻译的内容');
  }

  showStatus(`共 ${blocks.length} 个文本块`, 'loading');

  const nodeMap = buildNodeMap(blocks, document);
  warnOnNodeMapMismatch(blocks, nodeMap);
  saveOriginalTexts(blocks, nodeMap, state);

  // 使用服务端翻译
  if (useServer) {
    let translatedIds: Set<string>;
    if (cachedHtml) {
      showStatus('正在应用服务端缓存...', 'loading');
      translatedIds = applyServerTranslatedHtml(cachedHtml, blocks, nodeMap);
    } else {
      showStatus('正在发送到服务端翻译...', 'loading');
      // 服务端翻译失败直接抛错（由 start() 的 catch 展示给用户），不再降级到本地翻译，
      // 避免静默切换翻译通道导致用户困惑、且本地翻译同样会失败却更慢。
      translatedIds = await translateViaServer(config, blocks, nodeMap);
    }

    const missingIds = markMissingBlocks(nodeMap, translatedIds);
    cleanupTempAttrs();
    logger.debug(
      `[ContentScript] Server translation end: ${nodeMap.size} blocks total, ${translatedIds.size} translated, ${missingIds.length} missing`,
    );

    // 守卫：0 块实际翻译时不标记"已翻译"，避免后续尝试被 isPageTranslated() 短路。
    // 典型触发场景：LLM 对技术内容返回 identity 翻译（译文=原文），
    // applyServerTranslatedHtml 内部跳过所有块（translatedText === block.text），
    // 但若仍设置 fanyiTranslated=true，用户再点翻译只会看到"页面已翻译"然后退出。
    if (translatedIds.size === 0) {
      showStatus('翻译未生效（译文与原文相同），请重试', 'error');
      setTimeout(hideStatus, 6000);
      return { translated: false, observer: null };
    }

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

  const glossary = skipGlossary ? {} : await extractGlossary(fullText);

  // ── 页级语言检测（整页只做一次）──
  // 目的：日语原文 → 非日语目标语言时，把 default 文风自动升级为 ja-source-natural
  // （保留原文的克制、论述顺序与限定语气，见 service/japanese-natural-zh-prompt）。
  //
  // 位置说明：只作用于「本地直连 DeepSeek」这条路径。走服务端翻译时，
  // 服务端会基于同一份正文自行检测（lib/translate/pipeline.ts），
  // 这里不重复判断，避免两边结论不一致时难以定位。
  //
  // 只检测一次而不是每 chunk 一次：既避免重复统计，也保证同一页面所有
  // chunk 用同一文风（否则同页会出现文风割裂）。
  // 用户手工选择的文风永远优先 —— 策略集中在 shouldUseJapaneseSource。
  const detected = detectLanguage(fullText, {
    htmlLang: document.documentElement.lang || undefined,
  });
  const effectiveStyle: PromptStyle = shouldUseJapaneseSource(
    config.promptStyle,
    detected.language,
    config.targetLang,
  )
    ? 'ja-source-natural'
    : config.promptStyle;
  if (effectiveStyle !== config.promptStyle) {
    logger.debug(
      `[ContentScript] Source detected as ${detected.language} ` +
        `(kanaRatio=${detected.kanaRatio.toFixed(3)}, confidence=${detected.confidence.toFixed(2)}) ` +
        `→ promptStyle ${config.promptStyle} auto-upgraded to ${effectiveStyle}`,
    );
  }

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
    effectiveStyle,
  );

  await retryGlobalMissing(blocks, nodeMap, translatedIds, config, isMobile, effectiveStyle);

  const missingIds = markMissingBlocks(nodeMap, translatedIds);

  const observer = setupDynamicContentObserver(state, effectiveStyle);
  setObserver(observer);

  cleanupTempAttrs();

  logger.debug(
    `[ContentScript] Session end: ${nodeMap.size} blocks total, ${translatedIds.size} translated, ${missingIds.length} missing`,
  );

  // 守卫：与服务端路径一致，0 块实际翻译时不标记"已翻译"。
  if (translatedIds.size === 0) {
    showStatus('翻译未生效（译文与原文相同），请重试', 'error');
    setTimeout(hideStatus, 6000);
    return { translated: false, observer: null };
  }

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
