/**
 * Logger 模块测试
 *
 * 测什么：
 *   - 前缀拼接：首参是字符串 → 拼到字符串里；首参不是字符串 → 作为独立参数前置
 *   - debug/warn/error/info 都正确路由到底层 console 方法
 *
 * 不测什么：
 *   - localStorage / window.__fanyiDebug 运行时切换（属于集成层，jsdom 模拟成本高）
 *   - 不输出到远程（logger 暂未实现）
 *
 * 注意：vitest 默认 `import.meta.env.DEV === true`，所以 logger.debug 会输出。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { logger } from '../utils/logger';

describe('logger', () => {
  let log: ReturnType<typeof vi.spyOn>;
  let warn: ReturnType<typeof vi.spyOn>;
  let err: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.restoreAllMocks();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    err = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('prefix behavior', () => {
    it('logger.warn prepends [fanyi:warn] to first string argument', () => {
      logger.warn('NodeMap mismatch: 1/2');
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toBe('[fanyi:warn] NodeMap mismatch: 1/2');
    });

    it('logger.error prepends [fanyi:error] to first string argument', () => {
      const errorObj = new Error('boom');
      logger.error('Translation failed:', errorObj);
      expect(err).toHaveBeenCalledOnce();
      expect(err.mock.calls[0][0]).toBe('[fanyi:error] Translation failed:');
      // 后续参数透传
      expect(err.mock.calls[0][1]).toBe(errorObj);
    });

    it('logger.debug prepends [fanyi:debug] to first string argument (DEV mode)', () => {
      // vitest 默认 DEV=true，所以 debug 会输出
      logger.debug('Page already translated, skip sending request.');
      expect(log).toHaveBeenCalled();
      const debugCall = log.mock.calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('[fanyi:debug]'),
      );
      expect(debugCall?.[0]).toBe(
        '[fanyi:debug] Page already translated, skip sending request.',
      );
    });

    it('logger.info prepends [fanyi:info] to first string argument', () => {
      logger.info('Background script loaded');
      expect(log).toHaveBeenCalled();
      const infoCall = log.mock.calls.find((c: unknown[]) =>
        typeof c[0] === 'string' && (c[0] as string).startsWith('[fanyi:info]'),
      );
      expect(infoCall?.[0]).toBe('[fanyi:info] Background script loaded');
    });
  });

  describe('non-string first argument', () => {
    it('prepends prefix as separate argument when first arg is not a string', () => {
      const errorObj = new Error('something');
      logger.warn(errorObj);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toBe('[fanyi:warn]');
      expect(warn.mock.calls[0][1]).toBe(errorObj);
    });

    it('handles empty argument list', () => {
      logger.error();
      expect(err).toHaveBeenCalledOnce();
      expect(err.mock.calls[0][0]).toBe('[fanyi:error]');
    });
  });

  describe('preserves additional arguments', () => {
    it('passes through all args after the first string', () => {
      const extra1 = { id: 'b1' };
      const extra2 = 42;
      logger.error('Chunk failed', extra1, extra2);
      expect(err).toHaveBeenCalledOnce();
      expect(err.mock.calls[0][0]).toBe('[fanyi:error] Chunk failed');
      expect(err.mock.calls[0][1]).toBe(extra1);
      expect(err.mock.calls[0][2]).toBe(extra2);
    });
  });

  describe('backward compat with existing tests', () => {
    /**
     * 这条测试对应 translationUtils.test.ts 里的断言：
     *   expect(warn.mock.calls[0][0]).toContain('NodeMap mismatch');
     * 验证添加 [fanyi:warn] 前缀后，原有断言仍然通过。
     */
    it('preserves substring matching on first argument', () => {
      logger.warn('[ContentScript] NodeMap mismatch: 1/2 blocks mapped to DOM');
      expect(warn.mock.calls[0][0]).toContain('NodeMap mismatch');
      // 也能匹配整体前缀
      expect(warn.mock.calls[0][0]).toContain('[fanyi:warn]');
    });
  });

  describe('routes to correct console method', () => {
    it('logger.warn calls console.warn (not console.error)', () => {
      logger.warn('test');
      expect(warn).toHaveBeenCalledOnce();
      expect(err).not.toHaveBeenCalled();
    });

    it('logger.error calls console.error (not console.warn)', () => {
      logger.error('test');
      expect(err).toHaveBeenCalledOnce();
      expect(warn).not.toHaveBeenCalled();
    });

    it('logger.debug and logger.info both call console.log', () => {
      logger.debug('debug msg');
      logger.info('info msg');
      // 两次都路由到 console.log
      expect(log).toHaveBeenCalledTimes(2);
    });
  });
});
