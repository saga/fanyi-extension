import { DeepSeekTranslationService } from './service/deepseek';
import { getConfig } from './utils/config';
import {
  getCachedTranslation,
  cacheTranslation,
  processTranslationResult,
  prepareSelectionTask,
  clearAllCache,
} from './utils/translateApi';
import { globalQueue } from './utils/translationQueue';

function generateTranslationCacheKey(
  jsonContent: string,
  sourceLang: string,
  targetLang: string
): string {
  let hash = 0;
  const combined = `${jsonContent}_${sourceLang}_${targetLang}`;
  for (let i = 0; i < combined.length; i++) {
    const char = combined.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `translation_${Math.abs(hash)}`;
}

export default defineBackground(() => {
  console.log('Background script loaded');

  const serviceCache = new Map<string, DeepSeekTranslationService>();

  function getService(apiKey: string): DeepSeekTranslationService {
    if (!serviceCache.has(apiKey)) {
      serviceCache.set(apiKey, new DeepSeekTranslationService(apiKey));
    }
    return serviceCache.get(apiKey)!;
  }

  browser.runtime.onInstalled.addListener(() => {
    console.log('Extension installed');

    browser.contextMenus.create({
      id: 'translate-page',
      title: '翻译此页面',
      contexts: ['page'],
    });

    browser.contextMenus.create({
      id: 'translate-selection',
      title: '翻译选中内容',
      contexts: ['selection'],
    });

    browser.contextMenus.create({
      id: 'restore-original',
      title: '恢复原文',
      contexts: ['page'],
    });

    browser.contextMenus.create({
      id: 'toggle-translation',
      title: '切换译文显示',
      contexts: ['page'],
    });

    registerCommands();
  });

  browser.commands.onCommand.addListener(async (command) => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return;

    switch (command) {
      case 'translate-page':
        browser.tabs.sendMessage(tab.id, { action: 'translatePage' });
        break;
      case 'translate-selection':
        browser.tabs.sendMessage(tab.id, { action: 'translateSelection' });
        break;
      case 'restore-original':
        browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' });
        break;
      case 'toggle-translation':
        browser.tabs.sendMessage(tab.id, { action: 'toggleTranslation' });
        break;
    }
  });

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab?.id) return;

    switch (info.menuItemId) {
      case 'translate-page':
        browser.tabs.sendMessage(tab.id, { action: 'translatePage' });
        break;
      case 'translate-selection':
        browser.tabs.sendMessage(tab.id, {
          action: 'translateSelection',
          text: info.selectionText,
        });
        break;
      case 'restore-original':
        browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' });
        break;
      case 'toggle-translation':
        browser.tabs.sendMessage(tab.id, { action: 'toggleTranslation' });
        break;
    }
  });

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'translateChunk') {
      handleTranslateChunk(message, sendResponse);
      return true;
    }

    if (message.action === 'translateSelection') {
      handleTranslateSelection(message, sendResponse);
      return true;
    }

    if (message.action === 'clearCache') {
      handleClearCache(sendResponse);
      return true;
    }

    if (message.action === 'checkConfig') {
      handleCheckConfig(sendResponse);
      return true;
    }
  });

  async function handleTranslateChunk(
    message: any,
    sendResponse: (response: any) => void
  ) {
    try {
      const config = await getConfig();
      if (!config.deepseekApiKey) {
        sendResponse({ success: false, error: 'DeepSeek API Key not configured' });
        return;
      }

      const { jsonContent, sourceLang, targetLang, cacheKey: providedCacheKey } = message;

      const cacheKey = providedCacheKey || generateTranslationCacheKey(jsonContent, sourceLang, targetLang);

      const cached = await getCachedTranslation(cacheKey);
      const hasValidCache = cached && (cached instanceof Map ? cached.size > 0 : Object.keys(cached).length > 0);
      
      console.log('[Background] translateChunk cache check:', { cacheKey, hasCache: !!cached, hasValidCache });

      if (hasValidCache) {
        const resultArray = cached instanceof Map 
          ? Array.from(cached.entries()) 
          : Object.entries(cached);
        console.log('[Background] Using cached translation:', resultArray.length, 'blocks');
        sendResponse({ success: true, result: resultArray });
        return;
      }

      console.log('[Background] Calling DeepSeek API for translation...');
      const service = getService(config.deepseekApiKey);
      const jsonResult = await globalQueue.add(() =>
        service.translate(jsonContent, sourceLang, targetLang, [])
      );
      console.log('[Background] Translation API response length:', jsonResult?.length || 0);

      const result = processTranslationResult(jsonResult);
      console.log('[Background] Parsed translation blocks:', result.size);
      await cacheTranslation(cacheKey, result);

      sendResponse({ success: true, result: Array.from(result.entries()) });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleTranslateSelection(
    message: any,
    sendResponse: (response: any) => void
  ) {
    try {
      const config = await getConfig();
      if (!config.deepseekApiKey) {
        sendResponse({ success: false, error: 'DeepSeek API Key not configured' });
        return;
      }

      const { text, sourceLang, targetLang } = message;
      const jsonContent = prepareSelectionTask(text);
      const cacheKey = `selection_${text.length}_${sourceLang}_${targetLang}`;

      const cached = await getCachedTranslation(cacheKey);
      if (cached) {
        sendResponse({ success: true, translated: cached.get('b1') || text });
        return;
      }

      const service = getService(config.deepseekApiKey);
      const jsonResult = await globalQueue.add(() =>
        service.translate(jsonContent, sourceLang, targetLang, [])
      );

      const result = processTranslationResult(jsonResult);
      const translated = result.get('b1') || text;

      await cacheTranslation(cacheKey, new Map([['b1', translated]]));

      sendResponse({ success: true, translated });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleClearCache(sendResponse: (response: any) => void) {
    try {
      clearAllCache();
      sendResponse({ success: true });
    } catch (error) {
      sendResponse({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  async function handleCheckConfig(sendResponse: (response: any) => void) {
    try {
      const config = await getConfig();
      const hasKey = !!config.deepseekApiKey;
      console.log('[Background] checkConfig: hasApiKey =', hasKey, ', key length =', config.deepseekApiKey?.length || 0);
      sendResponse({ success: hasKey });
    } catch (error) {
      console.error('[Background] checkConfig error:', error);
      sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  async function registerCommands() {
    try {
      const commands = await browser.commands.getAll();
      console.log('Registered commands:', commands);
    } catch (error) {
      console.warn('Commands API not available:', error);
    }
  }
});
