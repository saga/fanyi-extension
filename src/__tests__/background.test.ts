import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock dependencies before importing background logic
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
vi.mock('../entrypoints/utils/config', () => ({
  getConfig: mockGetConfig,
  setConfig: mockSetConfig,
}));

// Mock translateApi
const mockGetCachedTranslation = vi.fn();
const mockCacheTranslation = vi.fn();
const mockProcessTranslationResult = vi.fn();
const mockClearAllCache = vi.fn();
vi.mock('../entrypoints/utils/translateApi', () => ({
  getCachedTranslation: mockGetCachedTranslation,
  cacheTranslation: mockCacheTranslation,
  processTranslationResult: mockProcessTranslationResult,
  clearAllCache: mockClearAllCache,
}));

// Mock translationQueue
const mockQueueAdd = vi.fn();
vi.mock('../entrypoints/utils/translationQueue', () => ({
  globalQueue: { add: mockQueueAdd },
}));

// Mock cacheKey
const mockGenerateCacheKey = vi.fn();
vi.mock('../entrypoints/utils/cacheKey', () => ({
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
vi.mock('../entrypoints/service/deepseek', () => ({
  DeepSeekTranslationService: vi.fn().mockImplementation(() => ({
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
      mockGetConfig.mockResolvedValue({ deepseekApiKey: '', provider: 'deepseek' });
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
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key', provider: 'deepseek' });
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
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key', provider: 'deepseek' });
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


    it('should handle API errors', async () => {
      mockGetConfig.mockResolvedValue({ deepseekApiKey: 'test-key', provider: 'deepseek' });
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

  });

});
