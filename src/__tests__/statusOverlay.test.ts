/**
 * statusOverlay 模块的纯函数 + DOM 行为测试。
 *
 * 测什么：
 *   - escapeHtml：HTML 实体转义（XSS 防御）
 *   - showStatus / hideStatus：DOM 单例行为（复用 vs 重建 + class 切换）
 *
 * 不测什么：
 *   - CSS 样式（依赖浏览器引擎，E2E 才合理）
 *   - 自动消失的 setTimeout（外部调用方控制时机，不属于本模块契约）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  showStatus,
  hideStatus,
  escapeHtml,
  __resetStatusOverlayForTesting,
} from '../entrypoints/content/statusOverlay';

describe('escapeHtml', () => {
  it('escapes <, >, and & (the chars that need it in text content)', () => {
    // 浏览器/JSdom 的 textContent→innerHTML 只转义 < > &，
    // 因为 " 和 ' 在文本节点中不需要转义（不是 attribute）。
    // 本函数就是把文本塞进 textContent 再取 innerHTML，行为与之一致。
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;',
    );
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });


  it('returns plain text unchanged (no double-encoding)', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
    expect(escapeHtml('plain-text_123')).toBe('plain-text_123');
  });

  it('handles empty string', () => {
    expect(escapeHtml('')).toBe('');
  });


  it('preserves unicode characters', () => {
    expect(escapeHtml('中文 😀 emoji')).toBe('中文 😀 emoji');
  });
});

describe('showStatus', () => {
  beforeEach(() => {
    // showStatus 用模块级单例 + document.body 挂载。
    // 单测每个 case 之间需要：清 DOM + 清模块缓存（否则会指向已被 remove 的节点）。
    __resetStatusOverlayForTesting();
  });

  afterEach(() => {
    __resetStatusOverlayForTesting();
  });

  it('creates and appends an overlay on first call', () => {
    expect(document.querySelector('.fanyi-status-overlay')).toBeNull();

    showStatus('正在翻译...', 'loading');

    const overlay = document.querySelector('.fanyi-status-overlay') as HTMLElement;
    expect(overlay).not.toBeNull();
    expect(overlay.textContent).toBe('正在翻译...');
    expect(overlay.style.display).toBe('flex');
    expect(overlay.classList.contains('fanyi-loading')).toBe(true);
    // 基类 + 类型 class 都在
    expect(overlay.classList.contains('fanyi-status-overlay')).toBe(true);
  });

  it('reuses the same overlay element on subsequent calls (no duplicates)', () => {
    showStatus('First', 'loading');
    const first = document.querySelector('.fanyi-status-overlay');

    showStatus('Second', 'success');
    const second = document.querySelector('.fanyi-status-overlay');

    expect(second).toBe(first);
    expect(document.querySelectorAll('.fanyi-status-overlay').length).toBe(1);
  });


});

describe('hideStatus', () => {
  beforeEach(() => {
    __resetStatusOverlayForTesting();
  });

  afterEach(() => {
    __resetStatusOverlayForTesting();
  });

  it('hides (display: none) a previously-shown overlay', () => {
    showStatus('Hello', 'loading');
    const overlay = document.querySelector('.fanyi-status-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('flex');

    hideStatus();

    expect(overlay.style.display).toBe('none');
  });

  it('is a no-op when overlay was never created (does not throw)', () => {
    expect(document.querySelector('.fanyi-status-overlay')).toBeNull();
    expect(() => hideStatus()).not.toThrow();
  });

});
