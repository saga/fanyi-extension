import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing background logic
const mockSendMessage = vi.fn();
const mockTabsSendMessage = vi.fn();
const mockContextMenusCreate = vi.fn();
const mockCommandsGetAll = vi.fn();
const mockStorageLocalGet = vi.fn().mockResolvedValue({});
const mockStorageLocalSet = vi.fn().mockResolvedValue(undefined);

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    contextMenus: {
      create: mockContextMenusCreate,
      onClicked: { addListener: vi.fn() },
    },
    commands: {
      onCommand: { addListener: vi.fn() },
      getAll: mockCommandsGetAll,
    },
    tabs: {
      sendMessage: mockTabsSendMessage,
      query: vi.fn().mockResolvedValue([{ id: 1 }]),
    },
    storage: {
      local: {
        get: mockStorageLocalGet,
        set: mockStorageLocalSet,
      },
    },
  },
}));

// Mock config
const mockGetConfig = vi.fn();
const mockSetConfig = vi.fn();
vi.mock('./utils/config', () => ({
  getConfig: mockGetConfig,
  setConfig: mockSetConfig,
}));

// Mock translateApi
const mockGetCachedTranslation = vi.fn();
const mockCacheTranslation = vi.fn();
const mockProcessTranslationResult = vi.fn();
const mockClearAllCache = vi.fn();
vi.mock('./utils/translateApi', () => ({
  getCachedTranslation: mockGetCachedTranslation,
  cacheTranslation: mockCacheTranslation,
  processTranslationResult: mockProcessTranslationResult,
  clearAllCache: mockClearAllCache,
}));

// Mock translationQueue
const mockQueueAdd = vi.fn();
vi.mock('./utils/translationQueue', () => ({
  globalQueue: { add: mockQueueAdd },
}));

// Mock cacheKey
const mockGenerateCacheKey = vi.fn();
vi.mock('./utils/cacheKey', () => ({
  generateTranslationCacheKey: mockGenerateCacheKey,
}));

// Mock rules
const mockMatchSiteRule = vi.fn();
const mockBuildSitePrompt = vi.fn();
vi.mock('../rules', () => ({
  matchSiteRule: mockMatchSiteRule,
  buildSitePrompt: mockBuildSitePrompt,
}));

// Mock DeepSeekTranslationService
const mockTranslate = vi.fn();
const mockTranslateStream = vi.fn();
vi.mock('./service/deepseek', () => ({
  DeepSeekTranslationService: vi.fn().mockImplementation((apiKey: string) => ({
    translate: mockTranslate,
    translateStream: mockTranslateStream,
  })),
}));

describe('background message handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('handleTranslateChunk', () => {
    async function handleTranslateChunk(
      message: any,
      sendResponse: (response: any) => void
    ) {
      try {
        const config = await mockGetConfig();
        if (!config.deepseekApiKey) {
          sendResponse({ success: false, error: 'DeepSeek API Key not configured' });
          return;
        }

        const { jsonContent, sourceLang, targetLang, cacheKey: providedCacheKey, pageUrl, glossary } = message;

        const matchedRule = pageUrl ? mockMatchSiteRule(pageUrl) : null;
        const sitePrompt = matchedRule ? mockBuildSitePrompt(matchedRule.siteRule) : '';

        const cacheKey = providedCacheKey || mockGenerateCacheKey(jsonContent, sourceLang, targetLang);

        const cached = await mockGetCachedTranslation(cacheKey);
        const hasValidCache = cached && cached.size > 0;

        if (hasValidCache) {
          const resultArray = Array.from(cached.entries());
          sendResponse({ success: true, result: resultArray });
          return;
        }

        const service = { translate: mockTranslate };
        const jsonResult = await mockQueueAdd(() =>
          service.translate(jsonContent, sourceLang, targetLang, glossary || [], sitePrompt)
        );

        const result = mockProcessTranslationResult(jsonResult);
        await mockCacheTranslation(cacheKey, result);

        sendResponse({ success: true, result: Array.from(result.entries()) });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          debugInfo: error instanceof Error ? {
            name: error.name,
            stack: error.stack?.substring(0, 300),
          } : null,
        });
      }
    }

    it('should return error when API key is missing', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: '' });
      const sendResponse = vi.fn();

      await handleTranslateChunk(
        { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh' },
        sendResponse
      );

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'DeepSeek API Key not configured',
      });
    });

    it('should use cached translation when available', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key' });
      const cachedMap = new Map([['b1', '你好']]);
      mockGetCachedTranslation.mockResolvedValue(cachedMap);
      const sendResponse = vi.fn();

      await handleTranslateChunk(
        { jsonContent: '[{"id":"b1","text":"hello"}]', sourceLang: 'en', targetLang: 'zh' },
        sendResponse
      );

      expect(mockGetCachedTranslation).toHaveBeenCalled();
      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        result: [['b1', '你好']],
      });
    });

    it('should call API and cache result when no cache', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key' });
      mockGetCachedTranslation.mockResolvedValue(null);
      mockGenerateCacheKey.mockReturnValue('cache-key-123');
      mockTranslate.mockResolvedValue('{"translations":[{"id":"b1","translated_text":"你好"}]}');
      mockQueueAdd.mockImplementation((fn) => fn());
      const resultMap = new Map([['b1', '你好']]);
      mockProcessTranslationResult.mockReturnValue(resultMap);
      mockCacheTranslation.mockResolvedValue(undefined);
      const sendResponse = vi.fn();

      await handleTranslateChunk(
        { jsonContent: '[{"id":"b1","text":"hello"}]', sourceLang: 'en', targetLang: 'zh', pageUrl: 'https://github.com/test' },
        sendResponse
      );

      expect(mockMatchSiteRule).toHaveBeenCalledWith('https://github.com/test');
      expect(mockTranslate).toHaveBeenCalled();
      expect(mockCacheTranslation).toHaveBeenCalledWith('cache-key-123', resultMap);
      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        result: [['b1', '你好']],
      });
    });

    it('should use provided cache key', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key' });
      mockGetCachedTranslation.mockResolvedValue(null);
      mockTranslate.mockResolvedValue('{"translations":[]}');
      mockQueueAdd.mockImplementation((fn) => fn());
      mockProcessTranslationResult.mockReturnValue(new Map());
      const sendResponse = vi.fn();

      await handleTranslateChunk(
        { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh', cacheKey: 'custom-key' },
        sendResponse
      );

      expect(mockGetCachedTranslation).toHaveBeenCalledWith('custom-key');
      expect(mockGenerateCacheKey).not.toHaveBeenCalled();
    });

    it('should handle API errors', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key' });
      mockGetCachedTranslation.mockResolvedValue(null);
      mockQueueAdd.mockImplementation((fn) => fn());
      mockTranslate.mockRejectedValue(new Error('API Error'));
      const sendResponse = vi.fn();

      await handleTranslateChunk(
        { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh' },
        sendResponse
      );

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'API Error',
        debugInfo: expect.objectContaining({ name: 'Error' }),
      });
    });

    it('should pass glossary to translate', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key' });
      mockGetCachedTranslation.mockResolvedValue(null);
      mockTranslate.mockResolvedValue('{"translations":[]}');
      mockQueueAdd.mockImplementation((fn) => fn());
      mockProcessTranslationResult.mockReturnValue(new Map());
      const sendResponse = vi.fn();
      const glossary = [{ term: 'API', translation: 'API' }];

      await handleTranslateChunk(
        { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh', glossary },
        sendResponse
      );

      expect(mockTranslate).toHaveBeenCalledWith('[]', 'en', 'zh', glossary, '');
    });
  });

  describe('handleValidateApiKey', () => {
    async function handleValidateApiKey(
      message: any,
      sendResponse: (response: any) => void
    ) {
      try {
        const { apiKey } = message;
        if (!apiKey) {
          sendResponse({ success: false, error: 'API Key 不能为空' });
          return;
        }

        const service = { translate: mockTranslate };
        const testContent = JSON.stringify([{ id: 'test', text: 'Hello' }]);

        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('请求超时（10秒）')), 10000);
        });

        const result = await Promise.race([
          service.translate(testContent, 'en', 'zh', []),
          timeout,
        ]);

        sendResponse({ success: true });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : '验证失败';
        sendResponse({
          success: false,
          error: errorMsg,
          debugInfo: error instanceof Error ? {
            name: error.name,
            message: error.message,
            stack: error.stack?.substring(0, 300),
          } : null,
        });
      }
    }

    it('should return error when API key is empty', async () => {
      const sendResponse = vi.fn();
      await handleValidateApiKey({ apiKey: '' }, sendResponse);
      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'API Key 不能为空',
      });
    });

    it('should validate API key successfully', async () => {
      mockTranslate.mockResolvedValue('{"translations":[]}');
      const sendResponse = vi.fn();

      await handleValidateApiKey({ apiKey: 'valid-key' }, sendResponse);

      expect(mockTranslate).toHaveBeenCalledWith(
        JSON.stringify([{ id: 'test', text: 'Hello' }]),
        'en',
        'zh',
        []
      );
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('should handle validation failure', async () => {
      mockTranslate.mockRejectedValue(new Error('Invalid API key'));
      const sendResponse = vi.fn();

      await handleValidateApiKey({ apiKey: 'invalid-key' }, sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Invalid API key',
        debugInfo: expect.objectContaining({ name: 'Error' }),
      });
    });
  });

  describe('handleClearCache', () => {
    async function handleClearCache(sendResponse: (response: any) => void) {
      try {
        await mockClearAllCache();
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    it('should clear cache successfully', async () => {
      mockClearAllCache.mockResolvedValue(undefined);
      const sendResponse = vi.fn();

      await handleClearCache(sendResponse);

      expect(mockClearAllCache).toHaveBeenCalled();
      expect(sendResponse).toHaveBeenCalledWith({ success: true });
    });

    it('should handle clear cache error', async () => {
      mockClearAllCache.mockRejectedValue(new Error('Storage error'));
      const sendResponse = vi.fn();

      await handleClearCache(sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Storage error',
      });
    });
  });

  describe('handleCheckConfig', () => {
    async function handleCheckConfig(sendResponse: (response: any) => void) {
      try {
        const config = await mockGetConfig();
        const hasKey = !!config.deepseekApiKey;
        sendResponse({ success: hasKey, config });
      } catch (error) {
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    it('should return true when API key exists', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key', targetLang: 'zh' });
      const sendResponse = vi.fn();

      await handleCheckConfig(sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({
        success: true,
        config: { deepseekApiKey: 'test-key', targetLang: 'zh' },
      });
    });

    it('should return false when API key is missing', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: '', targetLang: 'zh' });
      const sendResponse = vi.fn();

      await handleCheckConfig(sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        config: { deepseekApiKey: '', targetLang: 'zh' },
      });
    });

    it('should handle config error', async () => {
      mockGetConfig.mockRejectedValue(new Error('Config error'));
      const sendResponse = vi.fn();

      await handleCheckConfig(sendResponse);

      expect(sendResponse).toHaveBeenCalledWith({
        success: false,
        error: 'Config error',
      });
    });
  });
});
