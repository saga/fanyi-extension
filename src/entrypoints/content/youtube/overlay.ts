/**
 * CaptionOverlay — 字幕 Overlay 渲染器。
 *
 * 监听 <video> 的 timeupdate 事件，按当前播放时间找到对应字幕，
 * 在视频底部显示双语字幕（原文 + 译文）。
 *
 * 重构要点（解决问题 1 的显示侧）：
 *   - 新增 updateCaptions(captions) 方法：当 Ahead Buffer 翻译了新字幕后，
 *     Manager 调用此方法让 Overlay 拿到最新字幕（含 translatedText）
 *   - lastShownIdx 重置：updateCaptions 后清空缓存，下次 timeupdate 会重新查找
 *
 * 未改动（保留为后续迭代）：
 *   - timeupdate 监听（问题 3：可改为 requestVideoFrameCallback / rAF）
 *   - 线性查找字幕（问题 4：可改为二分查找）
 *   - Overlay 单类职责（问题 5：可拆为 Player + Renderer）
 *
 * 定位：absolute，挂在视频的父容器上（.html5-video-player）。
 * 样式：半透明黑底白字，居中底部，不遮挡 YouTube 原生字幕。
 */
import type { CaptionEvent } from './types';

const OVERLAY_ID = 'fanyi-caption-overlay';

export class CaptionOverlay {
  private video: HTMLVideoElement | null = null;
  private captions: CaptionEvent[] = [];
  private overlayEl: HTMLElement | null = null;
  private timeUpdateHandler: (() => void) | null = null;
  private lastShownIdx = -1;

  /**
   * 初始化字幕 Overlay。
   *
   * @returns 是否成功找到视频元素并初始化
   */
  start(captions: CaptionEvent[]): boolean {
    this.captions = captions;
    this.video = document.querySelector('video.html5-main-video') ||
                  document.querySelector('video');

    if (!this.video) {
      console.log('[YouTubeCaptions] No <video> element found');
      return false;
    }

    this.createOverlay();

    this.timeUpdateHandler = () => this.update();
    this.video.addEventListener('timeupdate', this.timeUpdateHandler);
    // 立即触发一次更新，让 Overlay 显示初始字幕（不用等第一个 timeupdate 事件）
    this.update();
    return true;
  }

  /**
   * 动态更新字幕数据（Ahead Buffer 翻译新字幕后调用）。
   *
   * 不重新创建 Overlay DOM，只更新内部 captions 引用。
   * 重置 lastShownIdx 让下次 timeupdate 重新查找当前字幕。
   */
  updateCaptions(captions: CaptionEvent[]): void {
    this.captions = captions;
    // 不重置 lastShownIdx=-1：如果当前正在显示某条字幕，且它的 translatedText
    // 刚刚被填充，下次 timeupdate 会自然刷新（idx 相同会触发 return 早退，
    // 但 translatedText 已经在 caption 对象上，下次切换到新字幕时自然会显示）
    // 但为了让"刚翻译好的当前字幕"立即显示译文，这里需要强制刷新一次
    this.lastShownIdx = -1;
    this.update();
  }

  /** 停止监听并移除 Overlay。 */
  stop(): void {
    if (this.timeUpdateHandler && this.video) {
      this.video.removeEventListener('timeupdate', this.timeUpdateHandler);
    }
    this.timeUpdateHandler = null;
    this.overlayEl?.remove();
    this.overlayEl = null;
    this.video = null;
    this.captions = [];
    this.lastShownIdx = -1;
  }

  /** 是否已翻译完成（至少有一条字幕有 translatedText）。 */
  isReady(): boolean {
    return this.captions.length > 0 && this.captions.some(c => c.translatedText);
  }

  private createOverlay(): void {
    // 移除已有 overlay
    document.getElementById(OVERLAY_ID)?.remove();

    const el = document.createElement('div');
    el.id = OVERLAY_ID;
    el.style.cssText = [
      'position: absolute',
      'bottom: 60px',
      'left: 50%',
      'transform: translateX(-50%)',
      'max-width: 90%',
      'padding: 6px 12px',
      'background: rgba(0, 0, 0, 0.75)',
      'color: #fff',
      'font-size: 16px',
      'line-height: 1.4',
      'text-align: center',
      'border-radius: 4px',
      'pointer-events: none',
      'z-index: 9999',
      'display: none',
    ].join('; ');

    // 挂到视频播放器容器上
    const player = document.querySelector('.html5-video-player');
    (player || document.body).appendChild(el);
    this.overlayEl = el;
  }

  private update(): void {
    if (!this.video || !this.overlayEl) return;

    const currentMs = this.video.currentTime * 1000;

    // 找当前时间的字幕（用 lastShownIdx 优化：大部分时候是连续的）
    let idx = -1;
    // 先检查上次附近的位置（优化：字幕是按时间排序的）
    if (
      this.lastShownIdx >= 0 &&
      this.lastShownIdx < this.captions.length
    ) {
      const c = this.captions[this.lastShownIdx];
      if (currentMs >= c.startMs && currentMs < c.startMs + c.durationMs) {
        idx = this.lastShownIdx;
      }
    }

    if (idx < 0) {
      // 线性查找（字幕不多，通常 < 1000 条）
      for (let i = 0; i < this.captions.length; i++) {
        const c = this.captions[i];
        if (currentMs >= c.startMs && currentMs < c.startMs + c.durationMs) {
          idx = i;
          break;
        }
      }
    }

    if (idx < 0) {
      this.overlayEl.style.display = 'none';
      this.lastShownIdx = -1;
      return;
    }

    // 如果 idx 相同但 translatedText 刚被填充，也要刷新显示
    const caption = this.captions[idx];
    const needRefresh = idx !== this.lastShownIdx || this.shouldShowTranslated(caption);

    if (!needRefresh) return; // 同一条字幕，状态未变化，不更新 DOM

    this.lastShownIdx = idx;

    if (caption.translatedText) {
      // 双语显示：原文 + 译文
      this.overlayEl.innerHTML = '';
      const orig = document.createElement('div');
      orig.textContent = caption.text;
      orig.style.opacity = '0.7';
      orig.style.fontSize = '14px';
      const trans = document.createElement('div');
      trans.textContent = caption.translatedText;
      this.overlayEl.appendChild(orig);
      this.overlayEl.appendChild(trans);
      this.overlayEl.style.display = 'block';
    } else {
      // 译文还没翻好，只显示原文
      this.overlayEl.textContent = caption.text;
      this.overlayEl.style.display = 'block';
    }
  }

  /**
   * 判断当前字幕是否应该显示译文（已翻译但 Overlay 还没显示译文时返回 true）。
   *
   * 用一个简单的标记：如果 overlayEl 当前只显示原文（textContent，没有子 div），
   * 但 caption 已经有 translatedText，则需要刷新。
   */
  private shouldShowTranslated(caption: CaptionEvent): boolean {
    if (!caption.translatedText) return false;
    // 如果 overlay 当前没有子元素（说明只显示了原文 textContent），
    // 但 caption 已有译文，需要刷新
    return this.overlayEl !== null && this.overlayEl.children.length === 0;
  }
}
