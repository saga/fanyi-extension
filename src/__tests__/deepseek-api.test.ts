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

      const glossary = [{ term: 'React', translation: 'React' }];
      await service.translate(
        JSON.stringify([{ id: 'b1', text: 'React is great' }]),
        'en',
        'zh',
        glossary
      );

      const fetchCall = globalFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.messages[0].content).toContain('React');
      expect(body.messages[0].content).toContain('Terminology glossary');
    });

    it('should handle HTTP 401 error', async () => {
      const mockResponse = {
        ok: false,
        status: 401,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          error: { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key' },
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', [])
      ).rejects.toThrow('401');
    });

    it('should handle HTTP 429 error', async () => {
      const mockResponse = {
        ok: false,
        status: 429,
        headers: new Map(),
        text: vi.fn().mockResolvedValue('Too many requests'),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', [])
      ).rejects.toThrow('429');
    });

    it('should handle network errors', async () => {
      globalFetch.mockRejectedValue(new TypeError('fetch failed'));

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', [])
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
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', [])
      ).rejects.toThrow('无效响应');
    });

    it('should handle non-JSON error response', async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        headers: new Map(),
        text: vi.fn().mockResolvedValue('Internal Server Error'),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', [])
      ).rejects.toThrow('500');
    });
  });

  describe('extractGlossary', () => {
    it('should extract glossary successfully', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"glossary":[{"term":"React","translation":"React"},{"term":"API","translation":"API"}]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      const result = await service.extractGlossary('React API testing', 'en', 'zh');

      expect(result).toHaveLength(2);
      expect(result[0].term).toBe('React');
      expect(result[1].term).toBe('API');
    });

    it('should handle alternative response format with terms', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"terms":[{"term":"HTTP","translation":"HTTP"}]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      const result = await service.extractGlossary('HTTP protocol', 'en', 'zh');

      expect(result).toHaveLength(1);
      expect(result[0].term).toBe('HTTP');
    });

    it('should return empty array for invalid JSON response', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: 'invalid json' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      const result = await service.extractGlossary('test', 'en', 'zh');

      expect(result).toEqual([]);
    });

    it('should truncate text longer than 5000 chars', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"glossary":[]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      const longText = 'a'.repeat(10000);
      await service.extractGlossary(longText, 'en', 'zh');

      const fetchCall = globalFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.messages[1].content.length).toBeLessThan(longText.length + 100);
    });

    it('should use correct target language name', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        headers: new Map(),
        text: vi.fn().mockResolvedValue(JSON.stringify({
          choices: [{ message: { content: '{"glossary":[]}' } }],
        })),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await service.extractGlossary('test', 'en', 'zh');

      const fetchCall = globalFetch.mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.messages[0].content).toContain('Simplified Chinese');
    });
  });

  describe('analyzeDocument', () => {
    it('should return empty analysis', async () => {
      const result = await service.analyzeDocument('test', 'en', 'zh');
      expect(result).toEqual({ domain: '', tone: '', glossary: [], summary: '' });
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
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', [])
      ).rejects.toThrow('账户余额不足');
    });

    it('should handle 503 error with service hint', async () => {
      const mockResponse = {
        ok: false,
        status: 503,
        headers: new Map(),
        text: vi.fn().mockResolvedValue('Service Unavailable'),
      };
      globalFetch.mockResolvedValue(mockResponse);

      await expect(
        service.translate(JSON.stringify([{ id: 'b1', text: 'hello' }]), 'en', 'zh', [])
      ).rejects.toThrow('暂时不可用');
    });
  });
});
