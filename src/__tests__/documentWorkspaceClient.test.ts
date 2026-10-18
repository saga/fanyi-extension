/**
 * workspaceApi 的错误文案解析。
 *
 * 回归背景：本机服务的 401/404 返回 OpenAI 风格嵌套错误
 * `{ error: { message, type } }`，而其余端点返回扁平 `{ error: '...' }`。
 * 旧实现直接把 payload.error 交给 Error 构造函数，嵌套对象被字符串化成
 * "[object Object]"，用户在「无法准备文档 workspace：…」里看不到真实原因。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@wxt-dev/storage', () => ({
  storage: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) },
}));

import { resolveWorkspaceProject, workspaceApi, WorkspaceApiError } from '../entrypoints/document/documentWorkspaceClient';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function respond(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe('resolveWorkspaceProject', () => {
  it('queries the service catalog with the parsed source and returns authoritative matches', async () => {
    const input = {
      title: 'Example Book',
      format: 'epub',
      sourceFileName: 'example.epub',
      segments: [{ id: 'p1', text: 'The door was open.' }],
    };
    const resolution = {
      exactProject: { projectId: 'server-project', sourceFingerprint: 'sha256:source' },
      relatedProject: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(respond(200, resolution));
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveWorkspaceProject('http://127.0.0.1:8789', 'secret', input))
      .resolves.toEqual(resolution);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8789/api/documents/projects/resolve');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer secret');
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it('propagates service unavailability instead of interpreting it as an empty catalog', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(503, { error: 'service unavailable' })));

    await expect(resolveWorkspaceProject('http://127.0.0.1:8789', '', {
      title: 'Example Book', format: 'epub', sourceFileName: 'example.epub',
      segments: [{ id: 'p1', text: 'The door was open.' }],
    })).rejects.toMatchObject({ status: 503 });
  });
});

describe('workspaceApi 错误文案', () => {
  it('嵌套 error.message 原样呈现（401 token 错误）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, {
      error: { message: '本机服务 Token 不正确或未提供', type: 'authentication_error' },
    })));

    await expect(workspaceApi('http://127.0.0.1:8789', '', '/api/documents/projects'))
      .rejects.toThrow('本机服务 Token 不正确或未提供');
  });

  it('嵌套错误不会退化成 [object Object]', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(404, {
      error: { message: '未知端点：GET /api/nope' },
    })));

    const error = await workspaceApi('http://127.0.0.1:8789', '', '/api/nope').catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('未知端点：GET /api/nope');
    expect(error.message).not.toContain('[object Object]');
  });

  it('扁平字符串 error 照常呈现', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(413, {
      error: '请求体超过 100 MiB 上限',
    })));

    await expect(workspaceApi('http://127.0.0.1:8789', '', '/api/documents/projects'))
      .rejects.toThrow('请求体超过 100 MiB 上限');
  });

  it('没有 error 字段时回退到 HTTP 状态', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(500, {})));

    await expect(workspaceApi('http://127.0.0.1:8789', '', '/api/documents/projects'))
      .rejects.toThrow('本机服务返回 HTTP 500');
  });

  it('成功响应直接返回 payload', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(200, { projects: [] })));

    await expect(workspaceApi('http://127.0.0.1:8789', '', '/api/documents/projects'))
      .resolves.toEqual({ projects: [] });
  });
});

describe('workspaceApi 传输层失败', () => {
  /**
   * 回归背景：本机服务被重启（或没启动）时，进行中的 fetch 被切断，浏览器只抛
   * TypeError: Failed to fetch。旧实现把 error.message 原样显示，阅读页顶部就
   * 只剩一句 "Failed to fetch"，看不出是哪个服务、什么原因。
   */
  it('把 Failed to fetch 换成带地址的可读文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const error = await workspaceApi('http://127.0.0.1:8789', '', '/api/documents/projects')
      .catch((e: unknown) => e as WorkspaceApiError);

    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect(error.status).toBe(0);
    expect(error.message).toContain('http://127.0.0.1:8789');
    expect(error.message).toContain('服务可能未启动或正在重启');
    // 原始错误保留，便于排查是连接被拒还是被拦截
    expect(error.message).toContain('Failed to fetch');
  });

  it('传输层失败不会被当成 404 而触发“新建项目”', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));

    const error = await workspaceApi('http://127.0.0.1:8789', '', '/api/documents/projects/gone')
      .catch((e: unknown) => e as WorkspaceApiError);

    expect(error.status).not.toBe(404);
  });
});

describe('WorkspaceApiError 携带 HTTP 状态', () => {
  /**
   * 回归背景：App.vue 曾用 /HTTP 404/ 匹配错误文案来判断「项目已不存在」。
   * 服务端 404 的文案是「找不到文档项目或项目已归档」，不含状态码，匹配永远不命中，
   * 于是「映射指向已删项目」被当成未知故障抛出，本应新建项目的路径直接报错。
   */
  it('404 即使文案是中文说明，也能通过 status 判定', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(404, {
      error: '找不到文档项目或项目已归档',
    })));

    const error = await workspaceApi('http://127.0.0.1:8789', '', '/api/documents/projects/gone')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect((error as WorkspaceApiError).status).toBe(404);
    // 旧判据在真实响应上必然为 false —— 这就是 bug 的成因
    expect(/HTTP 404/.test((error as Error).message)).toBe(false);
  });

  it('401 的 status 不会和 404 混淆', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(respond(401, {
      error: { message: '本机服务 Token 不正确或未提供', type: 'authentication_error' },
    })));

    const error = await workspaceApi('http://127.0.0.1:8789', '', '/api/documents/projects')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(WorkspaceApiError);
    expect((error as WorkspaceApiError).status).toBe(401);
  });
});
