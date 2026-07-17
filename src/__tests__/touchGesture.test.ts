/**
 * touchGesture 模块测试。
 *
 * 测什么：
 *   - 三击触发翻译回调（happy path）
 *   - 三击窗口外的不触发（timeout 重置 tapCount）
 *   - 多指触屏（touches.length !== 1）不触发
 *   - 命中扩展自身 UI（配置面板 / 状态条）时不触发
 *   - 单击 / 双击不触发
 *   - 触发后 tapCount 重置，可以再次三击
 *   - preventDefault 被调用（passive: false）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { setupTouchEvents } from '../entrypoints/content/touchGesture';

type TranslateHandler = () => Promise<void>;

/** 派发一个 touchstart 事件到 body。 */
function dispatchTouchStart(target: Element = document.body, touches = 1): TouchEvent {
  const event = new TouchEvent('touchstart', {
    bubbles: true,
    cancelable: true,
    touches: Array.from({ length: touches }, () => ({
      clientX: 0,
      clientY: 0,
      identifier: 0,
      pageX: 0,
      pageY: 0,
      radiusX: 0,
      radiusY: 0,
      rotationAngle: 0,
      screenX: 0,
      screenY: 0,
      target,
      force: 0,
    })) as unknown[] as Touch[],
  });
  Object.defineProperty(event, 'target', { value: target });
  target.dispatchEvent(event);
  return event;
}

describe('setupTouchEvents', () => {
  let onTranslate: TranslateHandler;

  beforeEach(() => {
    vi.useFakeTimers();
    onTranslate = vi.fn().mockResolvedValue(undefined) as unknown as TranslateHandler;
    document.body.innerHTML = '';
    setupTouchEvents(onTranslate);
  });

  it('triggers translation on three taps within the window', () => {
    dispatchTouchStart();
    dispatchTouchStart();
    dispatchTouchStart();

    expect(onTranslate).toHaveBeenCalledTimes(1);
  });

  it('does not trigger on single tap', () => {
    dispatchTouchStart();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('does not trigger on double tap', () => {
    dispatchTouchStart();
    dispatchTouchStart();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('resets tap count after the 500ms window expires', () => {
    dispatchTouchStart();
    dispatchTouchStart();
    // 超过窗口后才第三击，应该重新计数 → 不触发
    vi.advanceTimersByTime(501);
    dispatchTouchStart();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('can trigger again after firing (tapCount resets)', () => {
    dispatchTouchStart();
    dispatchTouchStart();
    dispatchTouchStart();
    expect(onTranslate).toHaveBeenCalledTimes(1);

    // 第二轮三击
    dispatchTouchStart();
    dispatchTouchStart();
    dispatchTouchStart();
    expect(onTranslate).toHaveBeenCalledTimes(2);
  });

  it('ignores multi-touch (touches.length !== 1)', () => {
    dispatchTouchStart(document.body, 2);
    dispatchTouchStart(document.body, 2);
    dispatchTouchStart(document.body, 2);
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('does not trigger when tapping on config panel', () => {
    const panel = document.createElement('div');
    panel.className = 'fanyi-config-panel';
    document.body.appendChild(panel);

    dispatchTouchStart(panel);
    dispatchTouchStart(panel);
    dispatchTouchStart(panel);
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('does not trigger when tapping on status overlay', () => {
    const overlay = document.createElement('div');
    overlay.className = 'fanyi-status-overlay';
    document.body.appendChild(overlay);

    dispatchTouchStart(overlay);
    dispatchTouchStart(overlay);
    dispatchTouchStart(overlay);
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('calls preventDefault on the third tap (passive: false)', () => {
    const event = new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [
        {
          clientX: 0,
          clientY: 0,
          identifier: 0,
          target: document.body,
        } as unknown as Touch,
      ],
    });
    const spy = vi.spyOn(event, 'preventDefault');
    Object.defineProperty(event, 'target', { value: document.body });

    document.body.dispatchEvent(event);
    document.body.dispatchEvent(event);
    document.body.dispatchEvent(event);

    expect(spy).toHaveBeenCalled();
  });

  it('clears pending tap timer when triggering (no stray reset)', () => {
    dispatchTouchStart();
    dispatchTouchStart();
    dispatchTouchStart();
    expect(onTranslate).toHaveBeenCalledTimes(1);

    // 触发后 100ms 再来一击，不应该误触发
    vi.advanceTimersByTime(100);
    dispatchTouchStart();
    expect(onTranslate).toHaveBeenCalledTimes(1);
  });
});
