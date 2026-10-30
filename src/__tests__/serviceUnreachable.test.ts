import { describe, expect, it } from 'vitest';
import { isServiceUnreachableError, WorkspaceApiError } from '@/entrypoints/document/documentWorkspaceClient';

/**
 * 重连判定必须只看 status=0（传输层失败），不能匹配错误文案。
 *
 * 这条规则决定了「服务重启期间要不要继续轮询」：判错一次，要么把 404 当成断线无限重连，
 * 要么把真正的断线当成业务错误直接放弃——后者正是「服务早就恢复了，界面还显示无法连接」的成因。
 */
describe('isServiceUnreachableError', () => {
  it('treats transport failures as reconnectable', () => {
    expect(isServiceUnreachableError(new WorkspaceApiError('无法连接本机服务 http://127.0.0.1:8789', 0))).toBe(true);
    expect(isServiceUnreachableError(new WorkspaceApiError('本机服务在 20 秒内没有响应', 0))).toBe(true);
  });

  it('treats answered requests as terminal, whatever the message says', () => {
    expect(isServiceUnreachableError(new WorkspaceApiError('找不到文档项目或项目已归档', 404))).toBe(false);
    expect(isServiceUnreachableError(new WorkspaceApiError('运行仍包含待处理或执行中的片段', 409))).toBe(false);
    expect(isServiceUnreachableError(new WorkspaceApiError('本机服务返回 HTTP 500', 500))).toBe(false);
  });

  it('does not mistake unrelated errors for a connection failure', () => {
    expect(isServiceUnreachableError(new Error('Failed to fetch'))).toBe(false);
    expect(isServiceUnreachableError(new TypeError('Failed to fetch'))).toBe(false);
    expect(isServiceUnreachableError(null)).toBe(false);
    expect(isServiceUnreachableError('无法连接本机服务')).toBe(false);
  });
});
