/**
 * 浮动按钮模块测试。
 *
 * 测什么：
 *   - loadButtonPosition：localStorage 命中/未命中/损坏 三种情况
 *   - saveButtonPosition：JSON 序列化、覆盖写入
 *
 * 不测什么：
 *   - setupFloatingButton：依赖 mousedown/touchstart 事件 + getConfig + showConfigPanel，
 *     写成单测需要 mock 整个 UI 层，性价比低；它的位置保存/恢复逻辑是这套测试覆盖的
 *   - setupTouchEvents：同理
 *   - updateButtonState：纯 DOM 副作用，E2E 验证更合适
 *
 * 注意事项：
 *   floatingButton.ts → configPanel.ts → webextension-polyfill，而 polyfill
 *   在 jsdom 下加载会抛 "This script should only be loaded in a browser
 *   extension"。所以在顶部用 vi.mock 替换成空实现。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('webextension-polyfill', () => ({ default: {} }));
vi.mock('../entrypoints/content/configPanel', () => ({
  showConfigPanel: vi.fn(),
}));

import {
  loadButtonPosition,
  saveButtonPosition,
} from '../entrypoints/content/floatingButton';

const STORAGE_KEY = 'fanyi-btn-position';

describe('loadButtonPosition', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  describe('when localStorage is empty', () => {
    it('returns mobile defaults (right: 12, bottom: 100)', () => {
      expect(loadButtonPosition(true)).toEqual({ right: 12, bottom: 100 });
    });

    it('returns desktop defaults (right: 20, bottom: 100)', () => {
      expect(loadButtonPosition(false)).toEqual({ right: 20, bottom: 100 });
    });
  });

  describe('when localStorage has valid JSON', () => {
    it('parses and returns the saved position', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ right: 50, bottom: 200 }));
      expect(loadButtonPosition(true)).toEqual({ right: 50, bottom: 200 });
      expect(loadButtonPosition(false)).toEqual({ right: 50, bottom: 200 });
    });

    it('fills in missing fields from defaults (right missing → 20)', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ bottom: 200 }));
      expect(loadButtonPosition(false)).toEqual({ right: 20, bottom: 200 });
    });

    it('fills in missing fields from defaults (bottom missing → 100)', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ right: 5 }));
      expect(loadButtonPosition(true)).toEqual({ right: 5, bottom: 100 });
    });

    it('ignores extra unknown fields (forward-compat)', () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ right: 5, bottom: 10, futureField: 'whatever' }),
      );
      expect(loadButtonPosition(true)).toEqual({ right: 5, bottom: 10 });
    });
  });

  describe('when localStorage has invalid JSON', () => {
    it('falls back to defaults instead of throwing', () => {
      localStorage.setItem(STORAGE_KEY, 'not-json{');
      expect(loadButtonPosition(true)).toEqual({ right: 12, bottom: 100 });
      expect(loadButtonPosition(false)).toEqual({ right: 20, bottom: 100 });
    });
  });

  describe('isMobile flag affects defaults only', () => {
    it('mobile default right (12) is smaller than desktop (20)', () => {
      localStorage.removeItem(STORAGE_KEY);
      expect(loadButtonPosition(true).right).toBeLessThan(loadButtonPosition(false).right);
    });

    it('saved values override isMobile flag (read back whatever was saved)', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ right: 7, bottom: 7 }));
      // 即使 isMobile=true，返回的是保存值
      expect(loadButtonPosition(true)).toEqual({ right: 7, bottom: 7 });
    });
  });
});

describe('saveButtonPosition', () => {
  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  it('writes JSON-serialized position to localStorage', () => {
    saveButtonPosition({ right: 33, bottom: 44 });
    expect(localStorage.getItem(STORAGE_KEY)).toBe('{"right":33,"bottom":44}');
  });

  it('overwrites prior saved value', () => {
    saveButtonPosition({ right: 1, bottom: 1 });
    saveButtonPosition({ right: 2, bottom: 2 });
    expect(loadButtonPosition(true)).toEqual({ right: 2, bottom: 2 });
  });

  it('round-trips through loadButtonPosition', () => {
    const original = { right: 99, bottom: 199 };
    saveButtonPosition(original);
    expect(loadButtonPosition(true)).toEqual(original);
  });

  it('handles zero values (boundary case)', () => {
    saveButtonPosition({ right: 0, bottom: 0 });
    // 注意：0 是合法值（按钮贴边），loadButtonPosition 不应回退到默认值
    expect(loadButtonPosition(true)).toEqual({ right: 0, bottom: 0 });
  });
});
