import { describe, expect, it } from 'vitest';
import {
  isServiceConnectivityMessage,
  isServiceUnreachableError,
  WorkspaceApiError,
} from '@/entrypoints/document/documentWorkspaceClient';

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

/**
 * 回归背景：阅读会话快照把 `state.error` 一起存进了 SQLite，于是某次服务重启产生的
 * 「无法连接本机服务…」被永久保存，并在每次打开文档时恢复。用户看到的是一条"刚刚发生"
 * 的故障，而服务其实早已恢复，刷新页面也没用——错误跟着快照一起回来了。
 */
describe('isServiceConnectivityMessage', () => {
  const reported =
    '读取 workspace 运行状态失败：无法连接本机服务 http://127.0.0.1:8789：' +
    '服务可能未启动或正在重启，请确认服务运行后重试（原始错误：Failed to fetch）';

  it('recognises connection failures that must not be persisted or restored', () => {
    expect(isServiceConnectivityMessage(reported)).toBe(true);
    expect(isServiceConnectivityMessage('无法连接本机服务 http://127.0.0.1:8789')).toBe(true);
    expect(isServiceConnectivityMessage('本机服务 http://127.0.0.1:8789 在 20 秒内没有响应')).toBe(true);
    expect(isServiceConnectivityMessage('TypeError: Failed to fetch')).toBe(true);
  });

  it('keeps run-result errors, which are still meaningful after a reload', () => {
    expect(isServiceConnectivityMessage('部分片段尚未完成，可在“翻译 Agent”中继续或重试失败项。')).toBe(false);
    expect(isServiceConnectivityMessage('运行仍包含待处理或执行中的片段，拒绝结束采纳事务。')).toBe(false);
    expect(isServiceConnectivityMessage('找不到文档项目或项目已归档')).toBe(false);
    expect(isServiceConnectivityMessage('')).toBe(false);
    expect(isServiceConnectivityMessage(undefined)).toBe(false);
    expect(isServiceConnectivityMessage(null)).toBe(false);
  });
});
