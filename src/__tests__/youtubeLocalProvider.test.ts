import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getConfig: vi.fn(),
}));

vi.mock('../entrypoints/utils/config', () => ({
  getConfig: mocks.getConfig,
}));

import { translateBatch } from '../entrypoints/content/youtube/translator';

describe('YouTube captions with the local Agent provider', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getConfig.mockResolvedValue({
      useLocalAgent: true,
      localAgentProvider: 'opencode',
      localAgentUrl: 'http://127.0.0.1:8789/',
      localAgentModel: 'openai/gpt-5.4',
      localAgentToken: '',
    });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{
          message: {
            content: JSON.stringify({
              translations: [{ id: 'caption-1', translated_text: '你好' }],
            }),
          },
        }],
      }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  it('sends caption prompts only to localhost and does not require a remote API key', async () => {
    const result = await translateBatch('', [{ id: 'caption-1', text: 'Hello' }]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:8789/v1/chat/completions');
    expect(url).not.toContain('api.deepseek.com');
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();

    const body = JSON.parse(String(init.body));
    expect(body.model).toBe('opencode:openai/gpt-5.4');
    expect(body.messages[0].content).toContain('Translate English subtitles');
    expect(result.get('caption-1')).toBe('你好');
  });

  it('reports local HTTP failures with provider and request ID and never contacts a remote API', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      text: async () => JSON.stringify({
        error: {
          message: '本机 Agent 返回内容不是有效 JSON',
          type: 'local_agent_error',
          request_id: 'yt-local-req-502',
          provider: 'opencode',
        },
      }),
    });

    await expect(translateBatch('', [{ id: 'caption-1', text: 'Hello' }]))
      .rejects.toThrow(/本机 Agent 字幕翻译失败：HTTP 502.*yt-local-req-502.*不会回退到远程 API/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8789/v1/chat/completions');
  });

  it('surfaces invalid JSON from the local model instead of silently marking captions failed', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: 'this is not JSON' } }],
      }),
    });

    await expect(translateBatch('', [{ id: 'caption-1', text: 'Hello' }]))
      .rejects.toThrow(/本机 Agent 字幕翻译返回了无效 JSON/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8789/v1/chat/completions');
  });

  it('adds the local token only when one was configured', async () => {
    mocks.getConfig.mockResolvedValue({
      useLocalAgent: true,
      localAgentProvider: 'workbuddy',
      localAgentUrl: 'http://localhost:8789',
      localAgentModel: 'auto',
      localAgentToken: 'local-test-token',
    });

    await translateBatch('this-remote-key-must-not-be-used', [{ id: '0', text: 'Hello' }]);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer local-test-token');
    expect(JSON.parse(String(init.body)).model).toBe('workbuddy');
  });
});
