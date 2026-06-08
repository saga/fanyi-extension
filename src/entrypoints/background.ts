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
import { generateTranslationCacheKey } from './utils/cacheKey';
import { matchSiteRule, buildSitePrompt } from '../rules';
import type { SiteRule } from '../rules/types';

export default defineBackground({
  persistent: {
    safari: false,
  },
  main() {
    console.log('Background script loaded');

    // Check which APIs are supported
    const isContextMenuSupported = !!browser.contextMenus;
    const isCommandsSupported = !!browser.commands;

    // Service cache is in-memory; Firefox may suspend background scripts.
    // Recreate service instances as needed; don't rely on persistence.
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

    // Only register command listener if commands API is supported
    if (isCommandsSupported) {
      try {
        browser.commands.onCommand.addListener(async (command) => {
          try {
            const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
            if (!tab?.id) return;

            switch (command) {
              case 'translate-page':
                browser.tabs.sendMessage(tab.id, { action: 'translatePage' }).catch(() => {});
                break;
              case 'restore-original':
                browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' }).catch(() => {});
                break;
              case 'toggle-translation':
                browser.tabs.sendMessage(tab.id, { action: 'toggleTranslation' }).catch(() => {});
                break;
            }
          } catch (error) {
            console.warn('Command handling failed:', error);
          }
        });
      } catch (error) {
        console.warn('Commands API not available:', error);
      }
    }

    if (isContextMenuSupported) {
      try {
        browser.contextMenus.onClicked.addListener(async (info, tab) => {
          if (!tab?.id) return;

          switch (info.menuItemId) {
            case 'translate-page':
              browser.tabs.sendMessage(tab.id, { action: 'translatePage' }).catch(() => {});
              break;
            case 'restore-original':
              browser.tabs.sendMessage(tab.id, { action: 'restoreOriginal' }).catch(() => {});
              break;
            case 'toggle-translation':
              browser.tabs.sendMessage(tab.id, { action: 'toggleTranslation' }).catch(() => {});
              break;
          }
        });
      } catch (error) {
        console.warn('Context menu click listener failed:', error);
      }
    }

    browser.runtime.onMessage.addListener((message: any, sender: any, sendResponse: (response: any) => void) => {
      // Handle messages asynchronously, ensuring config is loaded first
      (async () => {
        try {
          if (message.action === 'translateChunk') {
            await handleTranslateChunk(message, sendResponse);
          } else if (message.action === 'translateChunkStream') {
            await handleTranslateChunkStream(message, sender, sendResponse);
          } else if (message.action === 'validateApiKey') {
            await handleValidateApiKey(message, sendResponse);
          } else if (message.action === 'clearCache') {
            await handleClearCache(sendResponse);
          } else if (message.action === 'checkConfig') {
            await handleCheckConfig(sendResponse);
          } else {
            // Unknown action, don't keep port open
            sendResponse({ success: false, error: 'Unknown action' });
          }
        } catch (error) {
          console.error('[Background] Message handler error:', error);
          sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      })();
      // Return true to keep the message channel open for async response
      return true;
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

        const { jsonContent, sourceLang, targetLang, cacheKey: providedCacheKey, pageUrl, glossary } = message;

        const matchedRule = pageUrl ? matchSiteRule(pageUrl) : null;
        const sitePrompt = matchedRule ? buildSitePrompt(matchedRule.siteRule) : '';

        const cacheKey = providedCacheKey || generateTranslationCacheKey(jsonContent, sourceLang, targetLang);

        const cached = await getCachedTranslation(cacheKey);
        const hasValidCache = cached && cached.size > 0;
        
        console.log('[Background] translateChunk cache check:', { cacheKey, hasCache: !!cached, hasValidCache });

        if (hasValidCache) {
          const resultArray = Array.from(cached.entries());
          console.log('[Background] Using cached translation:', resultArray.length, 'blocks');
          sendResponse({ success: true, result: resultArray });
          return;
        }

        console.log('[Background] Calling DeepSeek API for translation...');
        const service = getService(config.deepseekApiKey);

        // [ChunkTrace] 入参快照：记录每个 chunk 的输入 ids、估算 token、
        // max_tokens 预算。出现 missing 时直接定位是哪个 chunk / 哪几个 id。
        let inputBlocks: Array<{ id: string }> = [];
        try {
          inputBlocks = JSON.parse(jsonContent);
        } catch {
          /* jsonContent 异常时 processTranslationResult 会抛错 */
        }
        const inputIds = inputBlocks.map((b) => b.id);
        const inputBytes = jsonContent.length;
        const estInputTokens = Math.ceil(inputBytes / 4);
        const reservedMaxTokens = Math.max(256, Math.ceil(estInputTokens * 2 * 1.2));
        console.log(
          '[Background][ChunkTrace] INPUT',
          `inputBlocks=${inputBlocks.length}`,
          `inputIds=[${inputIds.join(',')}]`,
          `inputBytes=${inputBytes}`,
          `estInputTokens=${estInputTokens}`,
          `reservedMaxTokens=${reservedMaxTokens}`,
          `sourceLang=${sourceLang}`,
          `targetLang=${targetLang}`,
        );

        const jsonResult = await globalQueue.add(() =>
          service.translate(jsonContent, sourceLang, targetLang, glossary || [], sitePrompt)
        );
        console.log('[Background] Translation API response length:', jsonResult?.length || 0);

        // [ChunkTrace] 出参快照：成功解析 → 对比 inputIds 找出 response 里
        // 缺哪些 id；如果 parse 失败 → 拿到截断的尾巴判断是不是触顶。
        let outputIds: string[] = [];
        let outputBytes = 0;
        try {
          const parsed = JSON.parse(jsonResult);
          const translations = parsed.translations || parsed;
          if (Array.isArray(translations)) {
            outputIds = translations
              .map((t: { id?: string }) => (typeof t?.id === 'string' ? t.id : null))
              .filter((id: string | null): id is string => !!id);
          }
          outputBytes = jsonResult.length;
        } catch (parseErr) {
          console.error(
            '[Background][ChunkTrace] OUTPUT NOT VALID JSON — likely truncated at max_tokens ceiling',
            {
              inputBlocks: inputBlocks.length,
              outputBytes: jsonResult.length,
              reservedMaxTokens,
              outputTail: jsonResult.slice(-200),
              parseError: parseErr instanceof Error ? parseErr.message : String(parseErr),
            },
          );
        }
        const missingInResponse = inputIds.filter((id) => !outputIds.includes(id));
        console.log(
          '[Background][ChunkTrace] OUTPUT',
          `outputBlocks=${outputIds.length}`,
          `outputBytes=${outputBytes}`,
          `missingInResponse=${JSON.stringify(missingInResponse)}`,
        );
        if (missingInResponse.length > 0) {
          console.warn(
            '[Background][ChunkTrace] MISSING — model did not return entries for:',
            missingInResponse,
            'reservedMaxTokens was',
            reservedMaxTokens,
            '(try increasing estimateMaxTokens or split chunk smaller)',
          );
        }

        const result = processTranslationResult(jsonResult);
        console.log('[Background] Parsed translation blocks:', result.size);
        await cacheTranslation(cacheKey, result);

        sendResponse({ success: true, result: Array.from(result.entries()) });
      } catch (error) {
        console.error('[Background] translateChunk error:', error);
        console.error('[Background] Full error details:', {
          name: error instanceof Error ? error.name : 'unknown',
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack?.substring(0, 500) : null,
        });
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

    async function handleTranslateChunkStream(
      message: any,
      sender: any,
      sendResponse: (response: any) => void
    ) {
      try {
        const config = await getConfig();
        if (!config.deepseekApiKey) {
          sendResponse({ success: false, error: 'DeepSeek API Key not configured' });
          return;
        }

        const { jsonContent, sourceLang, targetLang, pageUrl, glossary } = message;

        const matchedRule = pageUrl ? matchSiteRule(pageUrl) : null;
        const sitePrompt = matchedRule ? buildSitePrompt(matchedRule.siteRule) : '';

        console.log('[Background] Calling DeepSeek streaming API for translation...');
        const service = getService(config.deepseekApiKey);

        const stream = service.translateStream(
          jsonContent,
          sourceLang,
          targetLang,
          glossary || [],
          sitePrompt
        );

        let finalContent = '';
        for await (const partial of stream) {
          finalContent = partial;
          // 发送中间结果到 content script
          try {
            await browser.tabs.sendMessage(message.tabId || sender.tab?.id, {
              action: 'translationStreamUpdate',
              partial,
            });
          } catch {
            // tab 可能已关闭，忽略
          }
        }

        const result = processTranslationResult(finalContent);
        console.log('[Background] Stream translation parsed blocks:', result.size);

        sendResponse({ success: true, result: Array.from(result.entries()) });
      } catch (error) {
        console.error('[Background] translateChunkStream error:', error);
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

        console.log('[Background] Validating API Key, length:', apiKey.length);
        console.log('[Background] API Key prefix:', apiKey.substring(0, 10));

        const service = new DeepSeekTranslationService(apiKey);
        const testContent = JSON.stringify([{ id: 'test', text: 'Hello' }]);
        
        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('请求超时（10秒）')), 10000);
        });

        const result = await Promise.race([
          service.translate(testContent, 'en', 'zh', []),
          timeout
        ]);
        
        console.log('[Background] API Key validation successful, response length:', (result as string)?.length || 0);
        sendResponse({ success: true });
      } catch (error) {
        console.error('[Background] API Key validation failed:', error);
        const errorMsg = error instanceof Error ? error.message : '验证失败';
        console.error('[Background] Full error stack:', error);
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

    async function handleClearCache(sendResponse: (response: any) => void) {
      try {
        await clearAllCache();
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
        sendResponse({ success: hasKey, config });
      } catch (error) {
        console.error('[Background] checkConfig error:', error);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    async function registerCommands() {
      if (!isCommandsSupported) return;
      try {
        const commands = await browser.commands.getAll();
        console.log('Registered commands:', commands);
      } catch (error) {
        console.warn('Commands API not available:', error);
      }
    }
  },
});
