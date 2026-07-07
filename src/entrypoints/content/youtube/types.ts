/**
 * YouTube 字幕翻译模块的共享类型。
 *
 * 模块结构（见 ./youtube/ 目录）：
 *   types.ts       共享类型
 *   provider.ts    字幕获取（MAIN world 注入 + playerResponse + POT/timedtext）
 *   translator.ts  增量翻译 + Ahead Buffer + AbortSignal
 *   overlay.ts     CaptionOverlay 渲染（支持动态更新）
 *   manager.ts     YouTubeCaptionManager 生命周期 / 缓存 / SPA 导航
 *   index.ts       公共 API
 */

/** 一条字幕事件 */
export interface CaptionEvent {
  /** 唯一标识（Manager 内部用于匹配翻译结果） */
  id?: string;
  /** 开始时间（毫秒） */
  startMs: number;
  /** 持续时间（毫秒） */
  durationMs: number;
  /** 原文字幕文本 */
  text: string;
  /** 译文字幕文本（翻译完成后填充） */
  translatedText?: string;
  /**
   * 翻译状态。
   * - pending: 未翻译
   * - translating: 正在翻译
   * - done: 翻译完成
   * - failed: 翻译失败（可重试）
   */
  status?: 'pending' | 'translating' | 'done' | 'failed';
}

/** 翻译进度回调 */
export type ProgressCallback = (done: number, total: number) => void;

/** 状态回调（用于 UI 显示进度） */
export type StatusCallback = (
  msg: string,
  type: 'loading' | 'success' | 'error',
) => void;
