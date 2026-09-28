import { describe, it, expect, beforeEach } from 'vitest';
import { rotateSessionId, getSessionId } from '../entrypoints/utils/session';

describe('session id', () => {
  beforeEach(() => {
    // 模块级 currentSessionId 跨用例复用，这里通过 rotate 重置语义由实现保证。
  });

  it('rotateSessionId 生成非空且格式合理的 id', () => {
    const id = rotateSessionId();
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(8);
  });

  it('rotate 后 getSessionId 返回同一个 id（本次会话共享）', () => {
    const id = rotateSessionId();
    expect(getSessionId()).toBe(id);
    expect(getSessionId()).toBe(id); // 不轮换则稳定
  });

  it('每次 rotate 产生不同的 id（不同翻译会话区分）', () => {
    const a = rotateSessionId();
    const b = rotateSessionId();
    expect(a).not.toBe(b);
  });

});
