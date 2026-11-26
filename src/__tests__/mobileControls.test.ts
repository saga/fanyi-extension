/**
 * mobileControls 测试：移动端悬浮按钮作为稳定入口。
 *   - 单击未翻译 → 翻译；已翻译 → 恢复
 *   - 长按 → 打开配置面板，且不触发翻译/恢复
 *   - 移动超过阈值取消长按
 *   - 重复 setup 不会创建两个按钮；cleanup 移除按钮
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { showConfigPanel, addStorageListener, removeStorageListener } = vi.hoisted(() => ({
  showConfigPanel: vi.fn(),
  addStorageListener: vi.fn(),
  removeStorageListener: vi.fn(),
}));
vi.mock('../entrypoints/content/configPanel', () => ({ showConfigPanel }));
vi.mock('../entrypoints/utils/config', () => ({
  getConfig: vi.fn().mockResolvedValue({ mobileFloatingButtonEnabled: true }),
}));
vi.mock('webextension-polyfill', () => ({
  default: {
    storage: {
      onChanged: {
        addListener: addStorageListener,
        removeListener: removeStorageListener,
      },
    },
  },
}));

import { setupMobileControls } from '../entrypoints/content/mobileControls';

function pointer(type: string, x = 0, y = 0, pointerId = 1): PointerEvent {
  const button = document.querySelector('.fanyi-floating-btn') as HTMLElement;
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  button.dispatchEvent(event);
  return event as unknown as PointerEvent;
}

describe('setupMobileControls', () => {
  const onTranslate = vi.fn().mockResolvedValue(undefined);
  const onRestore = vi.fn();
  let isTranslated: () => boolean;
  let cleanup: () => void;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    onTranslate.mockClear();
    onRestore.mockClear();
    showConfigPanel.mockClear();
    isTranslated = vi.fn(() => false);
    cleanup = setupMobileControls({ onTranslate, onRestore, isTranslated });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('injects exactly one floating button', () => {
    expect(document.querySelectorAll('.fanyi-floating-btn')).toHaveLength(1);
    const second = setupMobileControls({ onTranslate, onRestore, isTranslated });
    expect(document.querySelectorAll('.fanyi-floating-btn')).toHaveLength(1);
    second();
  });

  it('single tap translates when not translated', () => {
    pointer('pointerdown');
    pointer('pointerup');
    expect(onTranslate).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('single tap restores when already translated', () => {
    isTranslated = vi.fn(() => true);
    cleanup();
    cleanup = setupMobileControls({ onTranslate, onRestore, isTranslated });
    pointer('pointerdown');
    pointer('pointerup');
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onTranslate).not.toHaveBeenCalled();
  });

  it('long press opens config panel without translating', () => {
    pointer('pointerdown');
    vi.advanceTimersByTime(551);
    expect(showConfigPanel).toHaveBeenCalledTimes(1);
    pointer('pointerup');
    expect(onTranslate).not.toHaveBeenCalled();
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('movement cancels the long press but keeps the tap', () => {
    pointer('pointerdown', 0, 0);
    pointer('pointermove', 40, 0);
    vi.advanceTimersByTime(600);
    expect(showConfigPanel).not.toHaveBeenCalled();
    pointer('pointerup', 40, 0);
    expect(onTranslate).toHaveBeenCalledTimes(1);
  });

  it('cleanup removes the button', () => {
    cleanup();
    expect(document.querySelector('.fanyi-floating-btn')).toBeNull();
  });
});
