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
  onYouTubeNavigate,
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
    const state: TranslationState = {
      originalTexts: new Map<string, string>(),
      translatedBlocks: new Set<string>(),
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

    // === YouTube SPA 导航监听 ===
    // YouTube 是 SPA，切视频不会刷新页面。监听 yt-navigate-finish 事件，
    // 在用户切换视频时自动重新启动字幕翻译（仅当之前已经启动过）。
    // 使用 capture 阶段确保在 YouTube 自己的处理之前捕获。
    let youTubeStarted = false;
    document.addEventListener('yt-navigate-finish', () => {
      if (!youTubeStarted) return;
      if (!isYouTubeWatchPage()) return;
      void getConfig().then((config) => {
        if (config.deepseekApiKey) {
          void onYouTubeNavigate(config.deepseekApiKey, (msg, type) => {
            if (type === 'error') console.log('[YouTubeCaptions]', msg);
          });
        }
      });
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
     * YouTube 视频页：translate 同时启动整页翻译 + 字幕翻译。
     */
    function handleAction(action: 'translate' | 'restore' | 'toggle'): void {
      void ensureController().then((ctrl) => {
        if (action === 'translate') {
          void ctrl.start();
          // YouTube 视频页：同时启动字幕翻译（独立于整页翻译流程）
          if (isYouTubeWatchPage()) {
            youTubeStarted = true;
            void getConfig().then((config) => {
              if (config.deepseekApiKey) {
                void startYouTubeCaptionTranslation(
                  config.deepseekApiKey,
                  (msg, type) => {
                    if (type === 'error') {
                      console.log('[YouTubeCaptions]', msg);
                    }
                  },
                );
              }
            });
          }
        } else if (action === 'restore') {
          ctrl.restore();
          updateButtonState(false);
        } else {
          ctrl.toggle();
        }
      });
    }

    /** 懒加载控制器。 */
    async function ensureController(): Promise<TranslationController> {
      if (translation) return translation;
      translation = createTranslationController(isMobile, state);
      return translation;
    }
  },
});
