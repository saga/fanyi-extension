/**
 * YouTubeCaptionManager — 字幕翻译生命周期管理器。
 *
 * 参考 read-frog 的抓取策略：
 *   - 通过 MAIN world 注入脚本拿到 playerResponse + captionTracks
 *   - 用 POT/timedtext 抓取完整字幕时间轴
 *   - 本 Manager 负责 Ahead Buffer 增量翻译、缓存、Overlay 渲染、SPA 导航
 *
 * 设计要点：
 *   1. 单例：同一时间只管理一个视频的翻译
 *   2. 内存缓存：按 videoId 缓存已翻译字幕，切回同一视频 0 API 调用
 *   3. Ahead Buffer：跟随 video.timeupdate，只翻译当前播放位置之后 90 秒
 *   4. AbortController：切视频时立即停止后台翻译任务
 *   5. pumping 标志：防止并发 translateAhead
 */
import type { CaptionEvent, StatusCallback } from './types';
import { extractVideoId, fetchCaptions, disableNativeCaptions } from './provider';
import { translateAhead, DEFAULT_AHEAD_MS } from './translator';
import { CaptionOverlay } from './overlay';

/** timeupdate 轮询节流间隔（毫秒） */
const TIMEUPDATE_THROTTLE_MS = 1000;

export class YouTubeCaptionManager {
  // === 单例 ===
  private static _instance: YouTubeCaptionManager | null = null;

  static getInstance(): YouTubeCaptionManager {
    if (!this._instance) this._instance = new YouTubeCaptionManager();
    return this._instance;
  }

  // === 内存缓存（videoId -> 已翻译字幕）===
  private cache: Map<string, CaptionEvent[]> = new Map();

  // === 当前会话状态 ===
  private currentVideoId: string | null = null;
  private captions: CaptionEvent[] = [];
  private overlay: CaptionOverlay | null = null;
  private video: HTMLVideoElement | null = null;
  private abortController: AbortController | null = null;
  private navigateHandler: (() => void) | null = null;
  private timeUpdateHandler: (() => void) | null = null;
  private lastTranslateTimeMs = 0;
  private pumping = false;
  private isRunning = false;

  private constructor() {
    // 监听 YouTube SPA 导航事件
    this.navigateHandler = () => {
      // 由外部调用 onNavigate 实际重启
    };
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

    // 1. 尝试命中缓存
    const cached = this.cache.get(videoId);
    if (cached && cached.length > 0) {
      this.captions = cached;
      onStatus?.('已命中字幕缓存', 'success');
    } else {
      // 2. 抓取字幕
      onStatus?.('正在获取 YouTube 字幕...', 'loading');
      try {
        this.captions = await fetchCaptions(videoId);
        if (this.captions.length === 0) {
          onStatus?.('未找到字幕', 'error');
          this.isRunning = false;
          this.abortController = null;
          return false;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        onStatus?.('字幕获取失败: ' + msg, 'error');
        console.error('[YouTubeCaptions] fetchCaptions failed:', e);
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

    this.video = document.querySelector('video.html5-main-video') as HTMLVideoElement | null
              || document.querySelector('video') as HTMLVideoElement | null;

    // 关闭 YouTube 原生英文字幕，避免与翻译字幕重复显示
    void disableNativeCaptions().then((success) => {
      if (success) {
        console.log('[YouTubeCaptions] Native captions disabled');
      }
    });

    // 4. 挂载 timeupdate 监听，驱动 Ahead Buffer 翻译
    this.timeUpdateHandler = () => {
      void this.onTimeUpdate(apiKey, onStatus);
    };
    this.video?.addEventListener('timeupdate', this.timeUpdateHandler);

    // 5. 立即触发一次 Ahead Buffer（从 0 秒开始）
    void this.onTimeUpdate(apiKey, onStatus);

    onStatus?.('字幕翻译已启动', 'success');
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

  /** 停止所有任务并清理资源（保留缓存）。 */
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

    // 移除 timeupdate 监听
    if (this.timeUpdateHandler && this.video) {
      this.video.removeEventListener('timeupdate', this.timeUpdateHandler);
    }
    this.timeUpdateHandler = null;

    // 保存当前字幕到缓存（深拷贝，避免后续修改污染缓存）
    if (this.currentVideoId && this.captions.length > 0) {
      this.cache.set(this.currentVideoId, deepCloneCaptions(this.captions));
    }

    this.currentVideoId = null;
    this.captions = [];
    this.video = null;
    this.lastTranslateTimeMs = 0;
    this.pumping = false;
    this.isRunning = false;
  }

  /** 销毁 Manager（移除 SPA 事件监听）。通常在页面卸载时调用。 */
  destroy(): void {
    this.stop();
    this.cache.clear();
    if (this.navigateHandler) {
      document.removeEventListener('yt-navigate-finish', this.navigateHandler, true);
      this.navigateHandler = null;
    }
    // 重置单例，让下次 getInstance 返回新实例（主要用于测试）
    YouTubeCaptionManager._instance = null;
  }

  // ============================================================
  // 内部方法
  // ============================================================

  /**
   * 视频 timeupdate 回调：节流 + 防止并发 + 触发 Ahead Buffer。
   */
  private async onTimeUpdate(apiKey: string, onStatus?: StatusCallback): Promise<void> {
    const signal = this.abortController?.signal;
    if (!signal || signal.aborted) return;
    if (this.pumping) return;

    const now = Date.now();
    if (now - this.lastTranslateTimeMs < TIMEUPDATE_THROTTLE_MS) return;
    this.lastTranslateTimeMs = now;

    const currentMs = this.video ? Math.round(this.video.currentTime * 1000) : 0;

    this.pumping = true;
    try {
      await translateAhead(this.captions, currentMs, DEFAULT_AHEAD_MS, apiKey, signal);
      // 翻译完成后刷新 Overlay
      this.overlay?.updateCaptions(this.captions);

      const doneCount = this.captions.filter((c) => c.status === 'done').length;
      const total = this.captions.length;
      if (doneCount > 0 && doneCount < total) {
        onStatus?.('字幕翻译进度 (' + doneCount + '/' + total + ')', 'success');
      }
    } catch (e) {
      if (signal?.aborted) return;
      console.warn('[YouTubeCaptions] translateAhead failed:', e);
    } finally {
      // stop() 后 signal.aborted，但仍要重置 pumping，避免死锁
      this.pumping = false;
    }
  }
}

function deepCloneCaptions(captions: CaptionEvent[]): CaptionEvent[] {
  return captions.map((c) => ({ ...c }));
}
