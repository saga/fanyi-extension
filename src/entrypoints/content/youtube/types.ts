/**
 * YouTube 字幕翻译模块的共享类型。
 *
 * 重构后的模块结构（见 ./youtube/ 目录）：
 *   types.ts       共享类型
 *   provider.ts    字幕获取（ytInitialPlayerResponse + timedtext）
 *   translator.ts  增量翻译 + Ahead Buffer + AbortSignal
 *   overlay.ts     CaptionOverlay 渲染（支持动态更新）
 *   manager.ts     YouTubeCaptionManager 生命周期 / 缓存 / SPA 导航
 *   index.ts       公共 API
 *
 * 设计目标（本轮重构聚焦四个核心问题）：
 *   1. 增量翻译（Ahead Buffer）：只翻译当前播放位置之后 90 秒的字幕，避免一次性翻译整集
 *   2. 生命周期管理：Manager 跟随 YouTube SPA 导航，切换视频时清理旧 overlay/listener
 *   6. 内存缓存：按 videoId 缓存已翻译字幕，刷新页面内切回同一视频 0 API 调用
 *   7. 取消机制：AbortController，切视频时立即停止后台翻译任务
 *
 * 其他问题（timeupdate→rAF、二分查找、Overlay 拆分、Pipeline、Prompt 增强、page script
 * 注入）保留为后续迭代，本轮不动以控制工作量。
 */

/** 一条字幕事件 */
export interface CaptionEvent {
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
