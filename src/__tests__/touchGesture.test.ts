/**
 * touchGesture 模块测试（Pointer Events 版）。
 *
 * 覆盖：
 *   - 三击触发翻译；单击/双击不触发
 *   - 每击独立计时：前两击间隔较长仍可命中
 *   - 超过窗口/按下过久/滚动位移 不触发
 *   - 多指触控不触发
 *   - 扩展自身 UI（悬浮按钮 / 配置面板 / 状态条）不触发
 *   - 命中后拦掉随后的 click，并清空文本选区
 *   - 返回清理函数，卸载后不再响应
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { setupTouchEvents } from '../entrypoints/content/touchGesture';

type TranslateHandler = () => Promise<void>;

function pointerEvent(
  type: string,
  options: { target?: Element; x?: number; y?: number; pointerId?: number; pointerType?: string; button?: number } = {},
): PointerEvent {
  const target = options.target ?? document.body;
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: options.x ?? 0,
    clientY: options.y ?? 0,
    button: options.button ?? 0,
  });
  Object.defineProperty(event, 'pointerId', { value: options.pointerId ?? 1 });
  Object.defineProperty(event, 'pointerType', { value: options.pointerType ?? 'touch' });
  Object.defineProperty(event, 'target', { value: target });
  target.dispatchEvent(event);
  return event as unknown as PointerEvent;
}

/** 一次完整点击 = down + up。 */
function tap(options: Parameters<typeof pointerEvent>[1] = {}): void {
  pointerEvent('pointerdown', options);
  pointerEvent('pointerup', options);
}

describe('setupTouchEvents', () => {
  let onTranslate: TranslateHandler;
  let cleanup: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    onTranslate = vi.fn().mockResolvedValue(undefined) as unknown as TranslateHandler;
    cleanup = setupTouchEvents(onTranslate);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('triggers translation on three taps', () => {
    tap();
    tap();
    tap();
    expect(onTranslate).toHaveBeenCalledTimes(1);
  });

  it('does not trigger on single or double tap', () => {
    tap();
    tap();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('resets tap count after the 600ms window expires', () => {
    tap();
    tap();
    vi.advanceTimersByTime(601);
    tap();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('counts each tap from its own timestamp (not the first tap)', () => {
    // 旧实现只在第一击启动 500ms 计时：0ms / 400ms / 800ms 三击会失败。
    tap();
    vi.advanceTimersByTime(400);
    tap();
    vi.advanceTimersByTime(400);
    tap();
    expect(onTranslate).toHaveBeenCalledTimes(1);
  });

  it('can trigger again after firing', () => {
    tap(); tap(); tap();
    tap(); tap(); tap();
    expect(onTranslate).toHaveBeenCalledTimes(2);
  });

  it('ignores a tap that moved more than the tolerance (scroll)', () => {
    pointerEvent('pointerdown', { x: 0, y: 0 });
    pointerEvent('pointermove', { x: 40, y: 0 });
    pointerEvent('pointerup', { x: 40, y: 0 });
    tap(); tap();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('ignores a press held too long', () => {
    pointerEvent('pointerdown');
    vi.advanceTimersByTime(701);
    pointerEvent('pointerup');
    tap(); tap();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('ignores multi-touch', () => {
    pointerEvent('pointerdown', { pointerId: 1, x: 0 });
    pointerEvent('pointerdown', { pointerId: 2, x: 10 });
    pointerEvent('pointerup', { pointerId: 2, x: 10 });
    pointerEvent('pointerup', { pointerId: 1, x: 0 });
    tap(); tap();
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('ignores taps on extension UI', () => {
    for (const className of ['fanyi-config-panel', 'fanyi-status-overlay', 'fanyi-floating-btn']) {
      const el = document.createElement('div');
      el.className = className;
      document.body.appendChild(el);
      tap({ target: el });
      tap({ target: el });
      tap({ target: el });
    }
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('suppresses the following click and clears selection on hit', () => {
    const selection = window.getSelection();
    selection?.removeAllRanges();
    const text = document.createTextNode('hello');
    document.body.appendChild(text);
    const range = document.createRange();
    range.selectNodeContents(text);
    selection?.addRange(range);
    expect(selection?.isCollapsed).toBe(false);

    tap(); tap();
    pointerEvent('pointerdown');
    const thirdUp = pointerEvent('pointerup');
    expect(thirdUp.defaultPrevented).toBe(true);
    expect(selection?.isCollapsed).toBe(true);

    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(click, 'target', { value: document.body });
    document.body.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
  });

  it('stops responding after cleanup', () => {
    cleanup();
    tap(); tap(); tap();
    expect(onTranslate).not.toHaveBeenCalled();
  });
});
