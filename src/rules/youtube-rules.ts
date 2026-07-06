import type { SiteRule } from './types';

/**
 * YouTube 站点规则。
 *
 * 核心需求：
 * 1. 强制 direct DeepSeek 翻译 — YouTube 是重 SPA，prepareHtmlForServer
 *    clone 整页 HTML 又慢又容易抓到动态内容。分块翻译更适合。
 * 2. 跳过 glossary 提取 — YouTube 内容（标题/描述/评论）简单，术语表
 *    价值低，跳过省一次本地计算 + 减少 prompt tokens。
 * 3. promptInstructions — YouTube 内容偏口语化、短文本，给模型简短
 *    指令即可，不需要通用页面的复杂规则。
 *
 * 字幕翻译由 youtubeCaptions.ts 独立模块处理，不走整页翻译流程
 * （字幕是动态 DOM，需要实时监听视频时间轴）。
 */
export const youtubeRule: SiteRule = {
  hostPattern: 'www.youtube.com',
  forceDirectTranslation: true,
  skipGlossary: true,
  promptInstructions:
    'This is a YouTube page (title, description, comments). Translate concisely and naturally. Keep video IDs, channel names, and timestamps unchanged.',
};
