/**
 * YouTube 字幕翻译模块入口。
 *
 * 公共 API：
 *   - isYouTubeWatchPage(url?)            检测是否是 YouTube 视频页
 *   - startYouTubeCaptionTranslation(...) 启动字幕翻译（内部走 Manager 单例）
 *   - stopYouTubeCaptionTranslation()     停止字幕翻译
 *   - onYouTubeNavigate(...)              SPA 导航时调用
 *
 * 内部模块（./youtube/）：
 *   types.ts       共享类型
 *   provider.ts    字幕获取
 *   translator.ts  增量翻译 + Ahead Buffer + AbortSignal
 *   overlay.ts     CaptionOverlay
 *   manager.ts     YouTubeCaptionManager 生命周期 / 缓存 / SPA 导航
 */
import { YouTubeCaptionManager } from './manager';
import { extractVideoId } from './provider';
import type { StatusCallback } from './types';

export type { CaptionEvent, StatusCallback, ProgressCallback } from './types';
export { CaptionOverlay } from './overlay';
export { YouTubeCaptionManager } from './manager';
export {
  extractYtInitialPlayerResponse,
  extractJSONObject,
  getCaptionTrackUrl,
  fetchCaptions,
  fetchPlayerResponse,
  extractVideoId,
} from './provider';
export {
  translateBatch,
  translateAhead,
  translateCaptions,
  DEFAULT_AHEAD_MS,
  BATCH_SIZE,
} from './translator';

// =============================================================================
// 公共 API
// =============================================================================

/**
 * 检测当前页面是否是 YouTube 视频播放页（/watch?v=...）。
 *
 * 用于决定是否启动字幕翻译。YouTube 首页、搜索页、频道页不启动。
 *
 * @param url 可选 URL，默认用 window.location.href（测试时可传入 mock URL）
 */
export function isYouTubeWatchPage(
  url: string = typeof window !== 'undefined' ? window.location.href : '',
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.hostname !== 'www.youtube.com') return false;
  return parsed.searchParams.has('v');
}

/**
 * 启动 YouTube 字幕翻译完整流程。
 *
 * 内部使用 YouTubeCaptionManager 单例：
 *   - 幂等：同一视频不重复启动
 *   - 切视频：自动清理旧资源（AbortController + Overlay + pumpTimer）
 *   - 内存缓存：切回已翻译视频 0 API 调用
 *   - Ahead Buffer：只翻译当前播放位置后 90 秒的字幕，不一次性翻译整集
 *
 * @param apiKey DeepSeek API Key
 * @param onStatus 状态回调（用于 UI 显示进度）
 * @returns 是否成功启动
 */
export async function startYouTubeCaptionTranslation(
  apiKey: string,
  onStatus?: StatusCallback,
): Promise<boolean> {
  const manager = YouTubeCaptionManager.getInstance();
  return manager.start(apiKey, onStatus);
}

/**
 * 停止 YouTube 字幕翻译。
 *
 * 取消正在进行的翻译任务，移除 Overlay，清理定时器。
 * 缓存不清空（切回同一视频仍可命中缓存）。
 */
export function stopYouTubeCaptionTranslation(): void {
  const manager = YouTubeCaptionManager.getInstance();
  manager.stop();
}

/**
 * YouTube SPA 导航时调用（监听 yt-navigate-finish 事件）。
 *
 * 检测 videoId 是否变化，如果变化则重新启动字幕翻译。
 *
 * @param apiKey DeepSeek API Key
 * @param onStatus 状态回调
 */
export async function onYouTubeNavigate(
  apiKey: string,
  onStatus?: StatusCallback,
): Promise<void> {
  const manager = YouTubeCaptionManager.getInstance();
  await manager.onNavigate(apiKey, onStatus);
}
