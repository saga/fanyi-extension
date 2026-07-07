/**
 * Content Script 入口
 *
 * 职责（精简后只做"接线"，业务逻辑已拆分到 ./content/*）：
 *   1. 注入样式（getStyles）
 *   2. 创建浮动按钮 + 触屏手势
 *   3. 创建翻译控制器（lazily，首次 translate 动作时实例化）
 *   4. 路由来自 background / popup / keyboard shortcut 的消息
 *   5. 维护"是否已翻译"的小型状态（originalTexts / translatedBlocks / isTranslated）
 *
 * 文件结构（见 ./content/）：
 *   styles.ts        CSS 模板字符串
 *   statusOverlay.ts 状态条 + HTML 转义
 *   floatingButton.ts 浮动按钮 + 触屏手势
 *   configPanel.ts   配置面板（API Key / 语言 / 模式 / 手势）
 *   translation.ts   翻译编排（核心：handleFullTranslation / translateChunkPayload / 动态监听）
 */
import browser from 'webextension-polyfill';
import { getConfig } from './utils/config';
import { getStyles } from './content/styles';
import { showStatus, hideStatus } from './content/statusOverlay';
import {
  setupFloatingButton,
  updateButtonState,
  setupTouchEvents,
} from './content/floatingButton';
import { showConfigPanel } from './content/configPanel';
import {
  createTranslationController,
  type TranslationController,
  type TranslationState,
} from './content/translation';
import {
  isYouTubeWatchPage,
  startYouTubeCaptionTranslation,
  stopYouTubeCaptionTranslation,
  YouTubeCaptionManager,
  extractVideoId,
} from './content/youtube';

// ============================================================
// 设备检测
// ============================================================

/**
 * 仅在 Android 上启用移动端布局（iOS 没浏览器扩展所以不考虑）。
 * iPad 用 desktop UA 也走 desktop 分支。
 */
const isAndroid = /Android/i.test(navigator.userAgent);
const isMobile = isAndroid || /iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);

// ============================================================
// 入口
// ============================================================

export default defineContentScript({
  matches: ['*://*/*'],
  main() {
    console.log('[ContentScript] Initializing on:', window.location.href, 'isMobile:', isMobile);

    // === 共享状态 ===
    // - originalTexts: 块 id → 原文（恢复时用）
    // - translatedBlocks: 动态内容已翻译的 block id 集合
    // - translatedTexts: 块 id → 译文（React/Next.js 重新渲染后恢复翻译）
    const state: TranslationState = {
      originalTexts: new Map<string, string>(),
      translatedBlocks: new Set<string>(),
      translatedTexts: new Map<string, string>(),
    };
    // 翻译控制器懒加载：第一次收到翻译消息才创建
    let translation: TranslationController | null = null;

    // === 注入样式 ===
    const style = document.createElement('style');
    style.textContent = getStyles(isMobile);
    (document.head || document.documentElement).appendChild(style);

    // === 浮动按钮 + 触屏手势 ===
    setupFloatingButton(
      isMobile,
      () => translation?.isTranslated() ?? false,
      () => handleAction('translate'),
      () => handleAction('restore'),
    );
    setupTouchEvents(() => handleAction('translate'));

    // === YouTube 字幕翻译：改为与整页翻译一致，需要点击翻译按钮才启动 ===
    const youTubeStatusCallback = (msg: string, type: string) => {
      if (type === 'error') {
        console.warn('[YouTubeCaptions]', msg);
      }
    };

    // YouTube SPA 导航：切视频时停止旧翻译，需要用户重新点击翻译按钮
    document.addEventListener('yt-navigate-finish', () => {
      if (!isYouTubeWatchPage()) {
        stopYouTubeCaptionTranslation();
        return;
      }
      // 检测 videoId 是否变化，变化则停止旧翻译
      const runningVideoId = YouTubeCaptionManager.getInstance().runningVideoId;
      if (runningVideoId) {
        const newVideoId = extractVideoId();
        if (newVideoId && newVideoId !== runningVideoId) {
          stopYouTubeCaptionTranslation();
        }
      }
    }, true);

    // === 消息路由：来自 background、popup、keyboard shortcut ===
    browser.runtime.onMessage.addListener((message: any) => {
      switch (message.action) {
        case 'translatePage':
          void handleAction('translate');
          return undefined;
        case 'restoreOriginal':
          handleAction('restore');
          return undefined;
        case 'toggleTranslation':
          handleAction('toggle');
          return undefined;
        case 'translationStreamUpdate':
          // 预留：流式翻译当前未启用，保留接口以便后续接入
          return undefined;
      }
    });

    /**
     * 统一处理三种动作（translate / restore / toggle）。
     *
     * translate 用 start()（异步），restore/toggle 同步即可。
     * 第一次调用会懒加载控制器。
     *
     * 注意：YouTube 字幕翻译也需要用户点击翻译按钮才会启动，
     * 与整页翻译保持一致。
     */
    async function handleAction(action: 'translate' | 'restore' | 'toggle'): Promise<void> {
      const ctrl = await ensureController();
      if (action === 'translate') {
        await ctrl.start();

        if (isYouTubeWatchPage()) {
          const config = await getConfig();
          if (config.deepseekApiKey) {
            void startYouTubeCaptionTranslation(config.deepseekApiKey, youTubeStatusCallback);
          }
        }
      } else if (action === 'restore') {
        ctrl.restore();
        stopYouTubeCaptionTranslation();
        updateButtonState(false);
      } else {
        ctrl.toggle();
      }
    }

    /** 懒加载控制器。 */
    async function ensureController(): Promise<TranslationController> {
      if (translation) return translation;
      translation = createTranslationController(isMobile, state);
      return translation;
    }
  },
});
