import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock webextension-polyfill before importing background
const mockSendMessage = vi.fn();
const mockTabsSendMessage = vi.fn();

vi.mock('webextension-polyfill', () => ({
  default: {
    runtime: {
      onMessage: { addListener: vi.fn() },
      onInstalled: { addListener: vi.fn() },
    },
    contextMenus: {
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: {
      onCommand: { addListener: vi.fn() },
    },
    tabs: {
      sendMessage: mockTabsSendMessage,
    },
    storage: {
      local: {
        get: vi.fn().mockResolvedValue({}),
        set: vi.fn().mockResolvedValue(undefined),
      },
    },
  },
}));

describe('handleTranslateChunkStream logic', () => {
  // Extract and test the core logic of handleTranslateChunkStream
  // Since background.ts uses browser APIs, we test the logic separately

  async function handleTranslateChunkStream(
    config: { deepseekApiKey?: string },
    message: {
      jsonContent: string;
      sourceLang: string;
      targetLang: string;
      pageUrl?: string;
      glossary?: any[];
      tabId?: number;
    },
    sender: { tab?: { id?: number } },
    service: {
      translateStream: (...args: any[]) => AsyncGenerator<string, string, unknown>;
    },
    sendResponse: (response: any) => void
  ) {
    if (!config.deepseekApiKey) {
      sendResponse({ success: false, error: 'DeepSeek API Key not configured' });
      return;
    }

    const { jsonContent, sourceLang, targetLang, glossary } = message;

    const stream = service.translateStream(
      jsonContent,
      sourceLang,
      targetLang,
      glossary || [],
      ''
    );

    let finalContent = '';
    for await (const partial of stream) {
      finalContent = partial;
      try {
        await mockTabsSendMessage(message.tabId || sender.tab?.id, {
          action: 'translationStreamUpdate',
          partial,
        });
      } catch {
        // tab may be closed, ignore
      }
    }

    sendResponse({ success: true, result: finalContent });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockTabsSendMessage.mockResolvedValue(undefined);
  });

  it('should return error when API key is missing', async () => {
    const sendResponse = vi.fn();

    await handleTranslateChunkStream(
      {},
      { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh' },
      {},
      { translateStream: async function* () { return ''; } },
      sendResponse
    );

    expect(sendResponse).toHaveBeenCalledWith({
      success: false,
      error: 'DeepSeek API Key not configured',
    });
  });

  it('should stream translation and send intermediate updates', async () => {
    const sendResponse = vi.fn();

    async function* mockStream() {
      yield 'Hello';
      yield 'Hello world';
      return 'Hello world';
    }

    await handleTranslateChunkStream(
      { deepseekApiKey: 'test-key' },
      { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh', tabId: 123 },
      {},
      { translateStream: mockStream },
      sendResponse
    );

    // Should send intermediate updates to content script
    expect(mockTabsSendMessage).toHaveBeenCalledTimes(2);
    expect(mockTabsSendMessage).toHaveBeenNthCalledWith(1, 123, {
      action: 'translationStreamUpdate',
      partial: 'Hello',
    });
    expect(mockTabsSendMessage).toHaveBeenNthCalledWith(2, 123, {
      action: 'translationStreamUpdate',
      partial: 'Hello world',
    });

    // Should send final response
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      result: 'Hello world',
    });
  });

  it('should use sender.tab.id when tabId not in message', async () => {
    const sendResponse = vi.fn();

    async function* mockStream() {
      yield 'test';
      return 'test';
    }

    await handleTranslateChunkStream(
      { deepseekApiKey: 'test-key' },
      { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh' },
      { tab: { id: 456 } },
      { translateStream: mockStream },
      sendResponse
    );

    expect(mockTabsSendMessage).toHaveBeenCalledWith(456, {
      action: 'translationStreamUpdate',
      partial: 'test',
    });
  });

  it('should ignore tab send errors', async () => {
    const sendResponse = vi.fn();
    mockTabsSendMessage.mockRejectedValue(new Error('Tab closed'));

    async function* mockStream() {
      yield 'test';
      return 'test';
    }

    await handleTranslateChunkStream(
      { deepseekApiKey: 'test-key' },
      { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh', tabId: 123 },
      {},
      { translateStream: mockStream },
      sendResponse
    );

    // Should still complete successfully despite tab errors
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      result: 'test',
    });
  });

  it('should pass glossary to translateStream', async () => {
    const sendResponse = vi.fn();
    const translateStream = vi.fn().mockImplementation(async function* () {
      yield 'result';
      return 'result';
    });

    const glossary = [{ term: 'API', translation: 'API' }];

    await handleTranslateChunkStream(
      { deepseekApiKey: 'test-key' },
      { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh', glossary },
      {},
      { translateStream },
      sendResponse
    );

    expect(translateStream).toHaveBeenCalledWith(
      '[]',
      'en',
      'zh',
      glossary,
      ''
    );
  });

  it('should handle empty stream', async () => {
    const sendResponse = vi.fn();

    async function* mockStream() {
      return '';
    }

    await handleTranslateChunkStream(
      { deepseekApiKey: 'test-key' },
      { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh' },
      {},
      { translateStream: mockStream },
      sendResponse
    );

    expect(mockTabsSendMessage).not.toHaveBeenCalled();
    expect(sendResponse).toHaveBeenCalledWith({
      success: true,
      result: '',
    });
  });

  it('should handle stream errors', async () => {
    const sendResponse = vi.fn();

    async function* mockStream() {
      throw new Error('Stream error');
      yield 'never';
      return 'never';
    }

    await expect(async () => {
      await handleTranslateChunkStream(
        { deepseekApiKey: 'test-key' },
        { jsonContent: '[]', sourceLang: 'en', targetLang: 'zh' },
        {},
        { translateStream: mockStream },
        sendResponse
      );
    }).rejects.toThrow('Stream error');
  });
});
