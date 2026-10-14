import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DeepSeekTranslationService } from '../entrypoints/service/deepseek';

// Mock global fetch
const globalFetch = vi.fn();
Object.defineProperty(globalThis, 'fetch', { value: globalFetch, writable: true });

describe('DeepSeekTranslationService API methods', () => {
  let service: DeepSeekTranslationService;

  beforeEach(() => {
    service = new DeepSeekTranslationService('test-api-key');
    vi.clearAllMocks();
  });

  describe('translate', () => {
    it('should translate content successfully', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map([['content-type', 'application/json']]),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"translations":[{"id":"b1","translated_text":"你好"}]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      const result = await service.translate(
        JSON.stringify([{ id: 'b1', text: 'hello' }]),
        'en',
        'zh',
        []
      );

      expect(result).toBe('{"translations":[{"id":"b1","translated_text":"你好"}]}');
      expect(globalFetch).toHaveBeenCalledTimes(1);
      const fetchCall = globalFetch.mock.calls[0];
      expect(fetchCall[1].headers.Authorization).toBe('Bearer test-api-key');
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body.stream).toBe(false);
    });

    it('defaults to json_object and passes through a strict json_schema on escalation', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"translations":[]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined);
      expect(JSON.parse(globalFetch.mock.calls[0][1].body).response_format).toEqual({ type: 'json_object' });

      const schema = { type: 'array', items: { type: 'object' } };
      await service.translate(
        JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined, undefined,
        { type: 'json_schema', json_schema: schema },
      );
      expect(JSON.parse(globalFetch.mock.calls[1][1].body).response_format).toEqual({
        type: 'json_schema', json_schema: schema,
      });
    });

    it('should include glossary in translation request', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"translations":[]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      const glossary = { document_terms: ['React', 'API'] };
      await service.translate(
        JSON.stringify([{ id: 'b1', text: 'React is great' }]),
        'en',
        'zh',
        glossary
      );

      const fetchCall = globalFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.messages[0].content).toContain('React');
      expect(body.messages[0].content).toContain('<术语表>');
      expect(body.messages[0].content).toContain('以下专有名词需要保留原文，不要翻译：');
    });

    it('omits Named entities section when glossary is empty', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"translations":[]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await service.translate(
        JSON.stringify([{ id: 'b1', text: 'hello' }]),
        'en',
        'zh',
        { document_terms: [] }
      );

      const fetchCall = globalFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.messages[0].content).not.toContain('<术语表>');
    });



    it('reports local-agent 502 errors as local failures and preserves the request ID', async () => {
      const localService = new DeepSeekTranslationService('', undefined, {
        endpoint: 'http://127.0.0.1:8789/v1/chat/completions',
        model: 'opencode',
      });
      globalFetch.mockResolvedValue({
        ok: false,
        status: 502,
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: {
            message: '本机 Agent 返回内容不是有效 JSON',
            type: 'local_agent_error',
            request_id: 'local-req-502',
            provider: 'opencode',
            duration_ms: 1234,
            output_chars: 42,
          },
        })),
      });

      await expect(
        localService.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined),
      ).rejects.toThrow(/本机 Agent 服务 error: HTTP 502.*local-req-502.*opencode.*42 chars/s);
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8789/v1/chat/completions');
    });

    it('turns a stalled fetch into a loud timeout error instead of hanging forever', async () => {
      globalFetch.mockRejectedValue(new DOMException('The operation timed out', 'TimeoutError'));

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined),
      ).rejects.toThrow(/请求超时/);
    });

    it('never rewrites a local-service connection failure as a remote API failure', async () => {
      const localService = new DeepSeekTranslationService('', undefined, {
        endpoint: 'http://127.0.0.1:8789/v1/chat/completions',
        model: 'opencode',
      });
      globalFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        localService.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined),
      ).rejects.toThrow(/本机 Agent 服务连接失败[\s\S]*不会回退到远程 API/);
      expect(globalFetch).toHaveBeenCalledTimes(1);
      expect(globalFetch.mock.calls[0][0]).toBe('http://127.0.0.1:8789/v1/chat/completions');
    });

    it('should handle network errors', async () => {
      globalFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('网络请求失败');
    });

    it('should handle invalid response structure', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: {} }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('无效响应');
    });

  });

  describe('error handling', () => {
    it('should handle 403 error with balance hint', async () => {
      const mockResponse = {
        ok: false,
        status: 403,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: { message: 'Forbidden' },
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', undefined)
      ).rejects.toThrow('账户余额不足');
    });

  });
});
