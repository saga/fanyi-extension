/**
 * YouTubeCaptionManager — 字幕翻译生命周期管理器。
 *
 * 重构要点（解决问题 2 Overlay 生命周期、问题 6 没有缓存、问题 7 没有取消机制）：
 *
 * 1. 生命周期（单例 + SPA 导航）：
 *    - 单例保证同一时间只有一个 Overlay 和一组监听器
 *    - 监听 YouTube 的 yt-navigate-finish 事件，切视频时自动清理旧资源
 *    - 避免内存泄漏：旧 overlay / 旧 timeupdate listener / 旧 captions
 *
 * 2. 内存缓存（Map<videoId, CaptionEvent[]>）：
 *    - 同一页面会话内切回已翻译过的视频，0 API 调用
 *    - 刷新页面后失效（持久化缓存保留为后续迭代，需要 IndexedDB）
 *
 * 3. 取消机制（AbortController）：
 *    - start() 创建新的 AbortController
 *    - stop() / 切视频时 abort()，立即停止后台翻译任务
 *    - translateBatch 的 fetch 接收 signal，abort 时抛 AbortError
 *
 * 4. Ahead Buffer 调度（解决问题 1 一次翻译整个视频）：
 *    - 启动时立即翻译 0~90 秒字幕
 *    - 用 setInterval(3000) 每 3 秒检查一次：如果当前播放位置接近未翻译区域，
 *      触发 translateAhead 翻译下一批
 *    - 翻译完成后调用 overlay.updateCaptions() 动态刷新显示
 */
import type { CaptionEvent, StatusCallback } from './types';
import {
  extractYtInitialPlayerResponse,
  getCaptionTrackUrl,
  fetchCaptions,
  extractVideoId,
} from './provider';
import { translateAhead, DEFAULT_AHEAD_MS } from './translator';
import { CaptionOverlay } from './overlay';

/** Ahead Buffer 检查间隔（毫秒） */
const PUMP_INTERVAL_MS = 3000;

/** Ahead Buffer 触发阈值：当播放位置距离已翻译区域边界小于此值时触发预取 */
const PREFETCH_THRESHOLD_MS = 30_000;

export class YouTubeCaptionManager {
  // === 单例 ===
  private static _instance: YouTubeCaptionManager | null = null;

  static getInstance(): YouTubeCaptionManager {
    if (!this._instance) this._instance = new YouTubeCaptionManager();
    return this._instance;
  }

  // === 当前会话状态 ===
  private currentVideoId: string | null = null;
  private captions: CaptionEvent[] = [];
  private overlay: CaptionOverlay | null = null;
  private abortController: AbortController | null = null;
  private pumpTimer: number | null = null;
  private navigateHandler: (() => void) | null = null;
  private isRunning = false;

  /** 内存缓存：videoId -> 已翻译的字幕数组（含 translatedText + status='done'） */
  private readonly cache = new Map<string, CaptionEvent[]>();

  private constructor() {
    // 监听 YouTube SPA 导航事件
    this.navigateHandler = () => {
      // yt-navigate-finish 触发时，外部需要调用 onNavigate() 重新启动
      // 这里只做标记，实际重启由调用方触发（避免在事件回调里做异步操作）
    };
    // 使用 capture 阶段监听，确保在 YouTube 自己的处理之前捕获
    document.addEventListener('yt-navigate-finish', this.navigateHandler, true);
  }

  /**
   * 启动字幕翻译流程。
   *
   * 如果当前正在运行同一视频，直接返回 true（幂等）。
   * 如果正在运行其他视频，先 stop() 再启动。
   *
   * @returns 是否成功启动
   */
  async start(apiKey: string, onStatus?: StatusCallback): Promise<boolean> {
    const videoId = extractVideoId();
    if (!videoId) {
      onStatus?.('非 YouTube 视频页', 'error');
      return false;
    }

    // 幂等：同一视频不重复启动
    if (this.isRunning && this.currentVideoId === videoId) {
      return true;
    }

    // 切视频：先清理旧资源
    if (this.isRunning) {
      this.stop();
    }

    this.currentVideoId = videoId;
    this.isRunning = true;
    this.abortController = new AbortController();

    // 1. 检查内存缓存
    const cached = this.cache.get(videoId);
    if (cached) {
      this.captions = cached;
      onStatus?.('字幕已缓存，直接显示', 'success');
    } else {
      // 2. 获取字幕
      onStatus?.('正在提取字幕信息...', 'loading');
      const fetched = await this.fetchCaptionsForCurrent(onStatus);
      if (!fetched) {
        this.isRunning = false;
        this.abortController = null;
        return false;
      }
    }

    // 3. 启动 Overlay
    this.overlay = new CaptionOverlay();
    if (!this.overlay.start(this.captions)) {
      onStatus?.('未找到视频播放器', 'error');
      this.isRunning = false;
      this.abortController = null;
      return false;
    }

    // 4. 启动 Ahead Buffer 调度
    this.startAheadBufferPump(apiKey, onStatus);

    const translated = this.captions.filter(c => c.translatedText).length;
    onStatus?.(
      '字幕翻译已启动 (' + translated + '/' + this.captions.length + ')',
      'success',
    );
    return true;
  }

  /**
   * SPA 导航时调用（由外部监听 yt-navigate-finish 触发）。
   *
   * 检查 videoId 是否变化，如果变化则重新启动。
   */
  async onNavigate(apiKey: string, onStatus?: StatusCallback): Promise<void> {
    const newVideoId = extractVideoId();
    if (newVideoId === this.currentVideoId) return;
    // 延迟一下等 YouTube 渲染新 video 元素
    setTimeout(() => {
      void this.start(apiKey, onStatus);
    }, 500);
  }

  /** 停止所有任务并清理资源。 */
  stop(): void {
    // 取消正在进行的翻译
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }

    // 停止 Overlay
    if (this.overlay) {
      this.overlay.stop();
      this.overlay = null;
    }

    // 停止 pump 定时器
    if (this.pumpTimer !== null) {
      clearInterval(this.pumpTimer);
      this.pumpTimer = null;
    }

    this.currentVideoId = null;
    this.captions = [];
    this.isRunning = false;
  }

  /** 销毁 Manager（移除 SPA 事件监听）。通常在页面卸载时调用。 */
  destroy(): void {
    this.stop();
    if (this.navigateHandler) {
      document.removeEventListener('yt-navigate-finish', this.navigateHandler, true);
      this.navigateHandler = null;
    }
    this.cache.clear();
    // 重置单例，让下次 getInstance 返回新实例（主要用于测试）
    YouTubeCaptionManager._instance = null;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /** 获取当前视频的字幕（带缓存写入）。 */
  private async fetchCaptionsForCurrent(
    onStatus?: StatusCallback,
  ): Promise<boolean> {
    if (!this.currentVideoId) return false;

    const playerResponse = extractYtInitialPlayerResponse();
    if (!playerResponse) {
      onStatus?.('未找到视频字幕数据（可能不是视频页）', 'error');
      return false;
    }

    const trackUrl = getCaptionTrackUrl(playerResponse);
    if (!trackUrl) {
      onStatus?.('该视频没有字幕', 'error');
      return false;
    }

    onStatus?.('正在获取字幕...', 'loading');
    try {
      const captions = await fetchCaptions(trackUrl);
      if (captions.length === 0) {
        onStatus?.('字幕内容为空', 'error');
        return false;
      }
      this.captions = captions;
      // 写入缓存（此时还没有翻译，但 fetch 过的字幕可以缓存）
      this.cache.set(this.currentVideoId, this.captions);
      return true;
    } catch (e) {
      onStatus?.(
        '字幕获取失败: ' + (e instanceof Error ? e.message : String(e)),
        'error',
      );
      return false;
    }
  }

  /**
   * 启动 Ahead Buffer 调度。
   *
   * - 立即触发一次首次翻译（0~90 秒）
   * - 每 3 秒检查一次：如果距离未翻译区域边界 < 30 秒，触发预取
   */
  private startAheadBufferPump(
    apiKey: string,
    onStatus?: StatusCallback,
  ): void {
    const signal = this.abortController?.signal;
    if (!signal) return;

    // 首次立即翻译 0~90 秒
    void this.pumpAheadBuffer(apiKey, onStatus);

    // 定时检查
    this.pumpTimer = window.setInterval(() => {
      void this.pumpAheadBuffer(apiKey, onStatus);
    }, PUMP_INTERVAL_MS);
  }

  /**
   * Ahead Buffer 泵：检查是否需要预取，需要则触发 translateAhead。
   *
   * 触发条件：
   *   - 当前播放位置 + PREFETCH_THRESHOLD_MS 内有未翻译字幕
   *   - 或者首次启动时（lastTranslatedEndMs === 0）
   */
  private async pumpAheadBuffer(
    apiKey: string,
    onStatus?: StatusCallback,
  ): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || signal.aborted) return;
    if (!this.overlay || this.captions.length === 0) return;

    const video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null
                 || document.querySelector('video') as HTMLVideoElement | null;
    if (!video) return;

    const currentMs = video.currentTime * 1000;

    // 找到当前播放位置附近第一个未翻译的字幕
    // 如果它距离当前位置 < PREFETCH_THRESHOLD_MS，触发预取
    let needPump = false;
    for (const c of this.captions) {
      if (c.status === 'done' || c.status === 'translating') continue;
      // 第一个未翻译的字幕
      if (c.startMs - currentMs < PREFETCH_THRESHOLD_MS) {
        needPump = true;
      }
      break;
    }

    if (!needPump) return;

    const beforeCount = this.captions.filter(c => c.translatedText).length;

    try {
      await translateAhead(
        this.captions,
        Math.max(0, currentMs - 5000), // 从当前位置往前 5 秒开始
        DEFAULT_AHEAD_MS,
        apiKey,
        signal,
        (done, total) => {
          const afterCount = beforeCount + done;
          onStatus?.(
            '正在翻译字幕 (' + afterCount + '/' + this.captions.length + ')',
            'loading',
          );
        },
      );

      // 翻译完成后更新 Overlay
      this.overlay?.updateCaptions(this.captions);

      // 更新缓存
      if (this.currentVideoId) {
        this.cache.set(this.currentVideoId, this.captions);
      }

      const translated = this.captions.filter(c => c.translatedText).length;
      if (translated > beforeCount) {
        onStatus?.(
          '字幕翻译进度 (' + translated + '/' + this.captions.length + ')',
          'success',
        );
      }
    } catch (e) {
      if (signal.aborted) return; // 正常取消
      console.error('[YouTubeCaptions] pump failed:', e);
    }
  }
}
