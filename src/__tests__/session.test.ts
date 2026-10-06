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



});
