import browser from 'webextension-polyfill';
import { DeepSeekTranslationService } from './service/deepseek';
import { getConfig, setConfig } from './utils/config';
import {
  getCachedTranslation,
  cacheTranslation,
  processTranslationResult,
  clearAllCache,
} from './utils/translateApi';
import { globalQueue } from './utils/translationQueue';
import { matchSiteRule, buildSitePrompt } from '../rules';
import type { SiteRule } from '../rules/types';

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

export default defineBackground({
  persistent: {
    safari: false,
  },
  main() {
    console.log('Background script loaded');

    const isContextMenuSupported = !!browser.contextMenus;

    const serviceCache = new Map<string, DeepSeekTranslationService>();

    function getService(apiKey: string): DeepSeekTranslationService {
      if (!serviceCache.has(apiKey)) {
        serviceCache.set(apiKey, new DeepSeekTranslationService(apiKey));
      }
      return serviceCache.get(apiKey)!;
    }

    browser.runtime.onInstalled.addListener(() => {
      console.log('Extension installed');

      if (isContextMenuSupported) {
        try {
          browser.contextMenus.create({
            id: 'translate-page',
            title: '翻译此页面',
            contexts: ['page'],
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
        } catch (error) {
          console.warn('Context menu creation failed:', error);
        }
      }

      registerCommands();
    });

    browser.commands.onCommand.addListener(async (command) => {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;

      switch (command) {
        case 'translate-page':
          browser.tabs.sendMessage(tab.id, { action: 'translatePage' });
          break;
        case 'restore-original':
          browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' });
          break;
        case 'toggle-translation':
          browser.tabs.sendMessage(tab.id, { action: 'toggleTranslation' });
          break;
      }
    });

    if (isContextMenuSupported) {
      browser.contextMenus.onClicked.addListener(async (info, tab) => {
        if (!tab?.id) return;

        switch (info.menuItemId) {
          case 'translate-page':
            browser.tabs.sendMessage(tab.id, { action: 'translatePage' });
            break;
          case 'restore-original':
            browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' });
            break;
          case 'toggle-translation':
            browser.tabs.sendMessage(tab.id, { action: 'toggleTranslation' });
            break;
        }
      });
    }

    browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message.action === 'translateChunk') {
        handleTranslateChunk(message, sendResponse);
        return true;
      }

      if (message.action === 'validateApiKey') {
        handleValidateApiKey(message, sendResponse);
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

        const { jsonContent, sourceLang, targetLang, cacheKey: providedCacheKey, pageUrl } = message;

        const matchedRule = pageUrl ? matchSiteRule(pageUrl) : null;
        const sitePrompt = matchedRule ? buildSitePrompt(matchedRule.siteRule) : '';

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
          service.translate(jsonContent, sourceLang, targetLang, [], sitePrompt)
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

        const service = new DeepSeekTranslationService(apiKey);
        const testContent = JSON.stringify([{ id: 'test', text: 'Hello' }]);
        
        await service.translate(testContent, 'en', 'zh', []);
        
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : '验证失败',
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
  },
});
