import browser from 'webextension-polyfill';
import { DeepSeekTranslationService, type PromptStyle } from './service/deepseek';
import { getConfig } from './utils/config';
import {
  getCachedTranslation,
  cacheTranslation,
  processTranslationResult,
  hasCompleteTranslationSet,
  clearAllCache,
} from './utils/translateApi';
import { translationCache } from './utils/cacheManager';
import { globalQueue } from './utils/translationQueue';
import { generateTranslationCacheKey } from './utils/cacheKey';
import { translateSingleflight } from './utils/singleflight';
import { matchSiteRule, buildSitePrompt } from '../rules';
import type { SiteRule } from '../rules/types';
import type {
  BackgroundMessage,
  BackgroundResponse,
  TranslateChunkMessage,
  TranslateChunkStreamMessage,
  TranslateChunkResponse,
  TranslateChunkStreamResponse,
  ValidateApiKeyMessage,
  ValidateApiKeyResponse,
  ClearCacheResponse,
  CheckConfigResponse,
  GetPageContextMessage,
  GetPageContextResponse,
  RelayToContentMessage,
  RelayToContentResponse,
  PageContext,
} from '../types/messages';
import { chatStream, buildChatSystem, type ChatMessage, type ChatUsage } from './service/chat';
import { openSidePanel } from './utils/sidePanel';
import { parseHtmlViaOffscreen, getPageHtmlViaScripting } from './utils/offscreen';

import { logger } from '../utils/logger';
export default defineBackground({
  persistent: {
    safari: false,
  },
  main() {
    logger.debug('Background script loaded');

    // Check which APIs are supported
    const isContextMenuSupported = !!browser.contextMenus;
    const isCommandsSupported = !!browser.commands;

    // ============================================================
    // 对话 tab：跟踪"当前内容标签页"（Firefox Mobile 安全）
    // ============================================================
    // Firefox Android 不支持 windows API（currentWindow 静默失效），
    // 且对话 tab 自身也是标签页。我们用 onActivated / onUpdated 记录
    // "最后一个非对话页的激活标签"，作为对话上下文的来源。
    const CHAT_PAGE = 'sidepanel.html';

    function isChatUrl(url?: string): boolean {
      return !!url && url.includes(CHAT_PAGE);
    }

    // 只有可注入 content script 的页面才作为对话来源：http(s) 与本地 file://
    // （file:// 需用户在 chrome://extensions 开启"允许访问文件网址"）。
    // chrome://、about:、PDF 查看器、扩展自身页面等都无法接收消息。
    function isWebUrl(url?: string): boolean {
      return !!url && /^(https?|file):\/\//i.test(url);
    }

    let lastContentTabId: number | null = null;

    browser.tabs.onActivated.addListener(({ tabId }) => {
      browser.tabs.get(tabId).then((t) => {
        if (t && !isChatUrl(t.url)) lastContentTabId = tabId;
      }).catch(() => {});
    });

    browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
      if (changeInfo.status === 'complete' && tab.id != null && !isChatUrl(tab.url)) {
        lastContentTabId = tabId;
      }
    });

    /**
     * 解析"对话上下文来自哪个标签页"。
     * 优先级：显式 sourceTabId > 最近记录的内容标签页 > 回退查询。
     * 桌面用 currentWindow；Android 该选项无效，靠 lastContentTabId。
     */
    async function getActiveContentTabId(sourceTabId?: number): Promise<number | null> {
      if (typeof sourceTabId === 'number') {
        try {
          const t = await browser.tabs.get(sourceTabId);
          // 只接受可注入 content script 的普通网页；chat 页 / 非 http(s) 页回退
          if (t && isWebUrl(t.url)) return sourceTabId;
        } catch {
          /* tab 可能已关闭 */
        }
      }
      if (lastContentTabId != null) {
        try {
          const t = await browser.tabs.get(lastContentTabId);
          if (t && isWebUrl(t.url)) return lastContentTabId;
        } catch {
          /* tab 可能已关闭 */
        }
      }
      // 回退：active tab（桌面可用；Android 上 currentWindow 无效但 active 仍可靠）
      try {
        const tabs = await browser.tabs.query({ active: true, currentWindow: true });
        const t = tabs.find((x) => x.id != null && isWebUrl(x.url));
        if (t?.id != null) return t.id;
      } catch {
        /* ignore */
      }
      try {
        const tabs = await browser.tabs.query({ active: true });
        const t = tabs.find((x) => x.id != null && !isChatUrl(x.url)) ?? tabs[0];
        if (t?.id != null) return t.id;
      } catch {
        /* ignore */
      }
      return null;
    }

    // 远程 Provider 继续走原有 API；本机模式把相同翻译 prompt 发给本机 OpenAI-compatible 入口。
    function getService(config: Awaited<ReturnType<typeof getConfig>>, style?: PromptStyle): DeepSeekTranslationService {
      if (config.useLocalAgent) {
        const endpoint = new URL('/v1/chat/completions', getLocalAgentBaseUrl(config)).toString();
        return new DeepSeekTranslationService(config.localAgentToken || '', style, {
          endpoint,
          model: getLocalAgentModelId(config),
        });
      }
      return new DeepSeekTranslationService(config.deepseekApiKey, style);
    }

    function getLocalAgentModelId(config: Awaited<ReturnType<typeof getConfig>>): string {
      const override = (config.localAgentModel || 'auto').trim();
      return override && override.toLowerCase() !== 'auto'
        ? (/^(workbuddy|opencode):/i.test(override) ? override : config.localAgentProvider + ':' + override)
        : config.localAgentProvider;
    }

    function getLocalAgentBaseUrl(config: Awaited<ReturnType<typeof getConfig>>): string {
      let base = config.localAgentUrl || 'http://127.0.0.1:8789';
      while (base.endsWith('/')) base = base.slice(0, -1);
      return base;
    }

    function getLocalAgentHeaders(config: Awaited<ReturnType<typeof getConfig>>): Record<string, string> {
      return {
        'Content-Type': 'application/json',
        ...(config.localAgentToken ? { Authorization: 'Bearer ' + config.localAgentToken } : {}),
      };
    }


    /** SQLite cache lives beside the local model runtime, so webpage and document translations share it. */
    async function getLocalSqliteCache(config: Awaited<ReturnType<typeof getConfig>>, cacheKey: string): Promise<Map<string, string> | null> {
      if (!config.useLocalAgent) return null;
      try {
        const response = await fetch(new URL('/api/cache/translation/get', getLocalAgentBaseUrl(config)).toString(), {
          method: 'POST', headers: getLocalAgentHeaders(config), body: JSON.stringify({ cacheKey }),
        });
        if (!response.ok) return null;
        const result = await response.json() as { hit?: boolean; value?: unknown };
        if (!result.hit || !result.value || typeof result.value !== 'object' || Array.isArray(result.value)) return null;
        const entries = Object.entries(result.value as Record<string, unknown>)
          .filter((item): item is [string, string] => typeof item[1] === 'string');
        return entries.length ? new Map(entries) : null;
      } catch (error) {
        // Cache is an optimization. Service/cache failure must never block local translation.
        logger.debug('[Background] SQLite translation-cache read failed; continuing:', error);
        return null;
      }
    }

    async function setLocalSqliteCache(config: Awaited<ReturnType<typeof getConfig>>, cacheKey: string, translations: Map<string, string>): Promise<void> {
      if (!config.useLocalAgent || !translations.size) return;
      try {
        const value = Object.fromEntries(translations.entries());
        await fetch(new URL('/api/cache/translation/set', getLocalAgentBaseUrl(config)).toString(), {
          method: 'POST', headers: getLocalAgentHeaders(config),
          body: JSON.stringify({ cacheKey, value, ttlMs: 7 * 24 * 60 * 60 * 1000 }),
        });
      } catch (error) {
        logger.debug('[Background] SQLite translation-cache write failed; continuing:', error);
      }
    }

    async function deleteLocalSqliteCache(
      config: Awaited<ReturnType<typeof getConfig>>,
      cacheKey: string,
    ): Promise<void> {
      if (!config.useLocalAgent) return;
      try {
        await fetch(new URL('/api/cache/translation/delete', getLocalAgentBaseUrl(config)).toString(), {
          method: 'POST',
          headers: getLocalAgentHeaders(config),
          body: JSON.stringify({ cacheKey }),
        });
      } catch (error) {
        logger.debug('[Background] SQLite translation-cache delete failed; continuing:', error);
      }
    }

    function getEffectiveProviderKey(config: Awaited<ReturnType<typeof getConfig>>): string {
      return config.useLocalAgent
        ? ['local-agent', config.localAgentProvider, config.localAgentModel || 'auto', config.localAgentUrl || ''].join(':')
        : config.provider;
    }

    browser.runtime.onInstalled.addListener(() => {
      logger.debug('Extension installed');

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

          browser.contextMenus.create({
            id: 'chat-page',
            title: '用本页内容对话',
            contexts: ['page'],
          });
        } catch (error) {
          logger.warn('Context menu creation failed:', error);
        }
      }

      registerCommands();

      // 定时清理过期翻译缓存（alarms API 无需额外权限）。
      // 12h 一次：把长期不访问、已超 7 天 TTL 但仍残留在 storage 的条目清掉。
      try {
        if (browser.alarms) {
          browser.alarms.create('translation-cache-cleanup', { periodInMinutes: 12 * 60 });
        }
      } catch {
        /* ignore */
      }
    });

    // 定时任务：清理过期缓存
    if (browser.alarms) {
      browser.alarms.onAlarm.addListener((alarm) => {
        if (alarm.name === 'translation-cache-cleanup') {
          translationCache
            .pruneExpired()
            .then((n) => logger.debug('[Background] pruned', n, 'expired translation cache entries'))
            .catch(() => {});
        }
      });
    }

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
          case 'chat-page': {
            // 打开浏览器级对话侧栏（Chrome sidePanel / Firefox sidebarAction）。
            // 面板自身向 background 取该页正文，不再用 iframe 注入网页 DOM。
            void openSidePanel(tab.id);
            break;
          }
            }
          } catch (error) {
            logger.warn('Command handling failed:', error);
          }
        });
      } catch (error) {
        logger.warn('Commands API not available:', error);
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
            case 'chat-page':
              // 右键菜单"用本页内容对话"：打开浏览器级侧栏对话这一页
              void openSidePanel(tab.id);
              break;
          }
        });
      } catch (error) {
        logger.warn('Context menu click listener failed:', error);
      }
    }

    browser.runtime.onMessage.addListener(((message: BackgroundMessage, sender: browser.Runtime.MessageSender, sendResponse: (response: BackgroundResponse) => void) => {
      // Handle messages asynchronously, ensuring config is loaded first
      (async () => {
        try {
          if (message.action === 'translateChunk') {
            await handleTranslateChunk(message, sendResponse as (r: TranslateChunkResponse) => void);
          } else if (message.action === 'translateChunkStream') {
            await handleTranslateChunkStream(message, sender, sendResponse as (r: TranslateChunkStreamResponse) => void);
          } else if (message.action === 'validateApiKey') {
            await handleValidateApiKey(message, sendResponse as (r: ValidateApiKeyResponse) => void);
          } else if (message.action === 'clearCache') {
            await handleClearCache(sendResponse as (r: ClearCacheResponse) => void);
          } else if (message.action === 'checkConfig') {
            await handleCheckConfig(sendResponse as (r: CheckConfigResponse) => void);
          } else if (message.action === 'getPageContext') {
            await handleGetPageContext(message, sendResponse as (r: GetPageContextResponse) => void);
          } else if (message.action === 'relayToContent') {
            await handleRelayToContent(message, sendResponse as (r: RelayToContentResponse) => void);
          } else {
            // Unknown action, don't keep port open
            sendResponse({ success: false, error: 'Unknown action' });
          }
        } catch (error) {
          logger.error('[Background] Message handler error:', error);
          sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
        }
      })();
      // Return true to keep the message channel open for async response
      return true;
    }) as browser.Runtime.OnMessageListener);

    async function handleTranslateChunk(
      message: TranslateChunkMessage,
      sendResponse: (response: TranslateChunkResponse) => void
    ) {
      try {
        const config = await getConfig();
        if (!config.useLocalAgent && !config.deepseekApiKey) {
          sendResponse({ success: false, error: 'DeepSeek API Key not configured' });
          return;
        }

        const { jsonContent, sourceLang, targetLang, cacheKey: providedCacheKey, pageUrl, glossary, literaryContext } = message;

        // Cache is keyed per request, but older entries may contain a syntactically valid partial LLM response.
        // Parse IDs before cache lookup so such entries can never masquerade as a full translation.
        let inputBlocks: Array<{ id: string; text?: string }> = [];
        let inputIds: string[] = [];
        let validInputIds = false;
        try {
          const parsedInput: unknown = JSON.parse(jsonContent);
          if (Array.isArray(parsedInput)) {
            inputBlocks = parsedInput.filter((block): block is { id: string; text?: string } =>
              !!block && typeof block === 'object' && typeof block.id === 'string' && !!block.id,
            );
            inputIds = inputBlocks.map((block) => block.id);
            validInputIds = inputBlocks.length === parsedInput.length &&
              inputIds.length > 0 &&
              new Set(inputIds).size === inputIds.length;
          }
        } catch {
          // Preserve the normal translation error path for invalid JSON; cache reuse is disabled.
        }

        const matchedRule = pageUrl ? matchSiteRule(pageUrl) : null;
        const sitePrompt = matchedRule ? buildSitePrompt(matchedRule.siteRule) : '';
        // 仅书籍文档请求会传 literaryContext。合并到 service prompt 与 cache fingerprint，
        // 普通网页不传该字段，因此网页翻译行为和既有缓存 key 保持不变。
        const effectivePrompt = [sitePrompt, literaryContext?.trim()]
          .filter((value): value is string => !!value)
          .join('\n\n');

        // 文风：优先使用 content script 页级语言检测后的结果（message.promptStyle）。
        // 缺省回退 config.promptStyle —— 兼容旧调用方，以及无页面上下文的调用点。
        // 必须与 cacheKey 用同一个值：否则 ja-source-natural 的译文会被写进 default 的
        // 缓存条目，后续同页面翻译命中脏缓存、文风来回跳。
        const promptStyle = message.promptStyle ?? config.promptStyle;

        // 缓存 key 纳入 glossary + sitePrompt：改术语表/站点规则后不再命中旧脏缓存（分析报告 P0）。
        // glossary/sitePrompt 为空时 key 与改动前一致，旧缓存不无谓失效。
        const cacheKey =
          providedCacheKey ||
          generateTranslationCacheKey(
            jsonContent,
            sourceLang,
            targetLang,
            getEffectiveProviderKey(config),
            promptStyle,
            glossary,
            effectivePrompt,
          );

        // Local mode checks the shared SQLite cache first, then the existing extension cache.
        // The remote-service path is intentionally unchanged.
        const localCached = await getLocalSqliteCache(config, cacheKey);
        if (localCached?.size) {
          if (validInputIds && hasCompleteTranslationSet(localCached, inputIds)) {
            sendResponse({ success: true, result: inputIds.map((id) => [id, localCached.get(id)!]) });
            return;
          }
          logger.warn('[Background] Ignoring incomplete/invalid SQLite translation cache entry:', cacheKey);
          await deleteLocalSqliteCache(config, cacheKey);
        }
        const cached = await getCachedTranslation(cacheKey);
        if (cached?.size) {
          if (validInputIds && hasCompleteTranslationSet(cached, inputIds)) {
            if (config.useLocalAgent) await setLocalSqliteCache(config, cacheKey, cached);
            sendResponse({ success: true, result: inputIds.map((id) => [id, cached.get(id)!]) });
            return;
          }
          logger.warn('[Background] Ignoring incomplete/invalid extension translation cache entry:', cacheKey);
          await translationCache.remove(cacheKey);
          await deleteLocalSqliteCache(config, cacheKey);
        }

        const service = getService(config, promptStyle);

        // [ChunkTrace] 入参快照：记录每个 chunk 的输入 ids、估算 token、
        // max_tokens 预算。出现 missing 时直接定位是哪个 chunk / 哪几个 id。
        const inputBytes = jsonContent.length;
        const estInputTokens = Math.ceil(inputBytes / 4);
        const reservedMaxTokens = Math.max(256, Math.ceil(estInputTokens * 2 * 1.2));
        logger.debug(
          '[Background][ChunkTrace] INPUT',
          `inputBlocks=${inputBlocks.length}`,
          `inputIds=[${inputIds.join(',')}]`,
          `inputBytes=${inputBytes}`,
          `estInputTokens=${estInputTokens}`,
          `reservedMaxTokens=${reservedMaxTokens}`,
          `sourceLang=${sourceLang}`,
          `targetLang=${targetLang}`,
        );

        const jsonResult = await translateSingleflight(cacheKey, () =>
          globalQueue.add(() =>
            service.translate(jsonContent, sourceLang, targetLang, glossary, effectivePrompt)
          )
        );

        // [ChunkTrace] 出参快照：成功解析 → 对比 inputIds 找出 response 里
        // 缺哪些 id；如果 parse 失败 → 拿到截断的尾巴判断是不是触顶。
        // 把这些字段打包成 `trace` 一起 sendResponse 回去，让 content 端
        // 不用再翻 background 的 console 也能看到根因。
        let outputIds: string[] = [];
        let outputBytes = 0;
        let jsonParseFailed = false;
        let outputTail = '';
        let parseErrorMsg = '';
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
          jsonParseFailed = true;
          outputBytes = jsonResult.length;
          outputTail = jsonResult.slice(-200);
          parseErrorMsg = parseErr instanceof Error ? parseErr.message : String(parseErr);
          logger.error(
            '[Background][ChunkTrace] OUTPUT NOT VALID JSON — likely truncated at max_tokens ceiling',
            {
              inputBlocks: inputBlocks.length,
              outputBytes,
              reservedMaxTokens,
              outputTail,
              parseError: parseErrorMsg,
            },
          );
        }
        const missingInResponse = inputIds.filter((id) => !outputIds.includes(id));
        logger.debug(
          '[Background][ChunkTrace] OUTPUT',
          `outputBlocks=${outputIds.length}`,
          `outputBytes=${outputBytes}`,
          `missingInResponse=${JSON.stringify(missingInResponse)}`,
        );
        if (missingInResponse.length > 0) {
          logger.warn(
            '[Background][ChunkTrace] MISSING — model did not return entries for:',
            missingInResponse,
            'reservedMaxTokens was',
            reservedMaxTokens,
            '(try increasing estimateMaxTokens or split chunk smaller)',
          );
        }

        const result = processTranslationResult(jsonResult);
        if (validInputIds && hasCompleteTranslationSet(result, inputIds)) {
          await cacheTranslation(cacheKey, result);
          await setLocalSqliteCache(config, cacheKey, result);
        } else {
          // 不缓存部分结果，否则下一次同一请求会永久命中缺译文的旧缓存。
          logger.warn('[Background] Translation result is incomplete; skipping cache write:', {
            cacheKey,
            inputCount: inputIds.length,
            outputCount: result.size,
            missingIds: inputIds.filter((id) => !result.has(id)).slice(0, 20),
          });
          await translationCache.remove(cacheKey);
          await deleteLocalSqliteCache(config, cacheKey);
        }

        // 传给 content 端的诊断包：把上面 [ChunkTrace] 的关键字段集中
        // 起来，content 收到 missing 时直接 console.log 出来，定位根因
        // 不用再翻 background console。
        const trace = {
          inputBytes,
          estInputTokens,
          reservedMaxTokens,
          outputBytes,
          outputBlocks: outputIds.length,
          // 模型实际返回的 id 列表——如果跟 inputIds 不重合（即 background
          // log 里 missingInResponse=inputIds），看这个就知道模型用了什
          // 么奇怪的 id（数字/英文/截断）。也帮助区分"id 不匹配"和"id 缺
          // 失"两种情况。
          outputIds: outputIds.slice(0, 30),
          // input vs output 交集=0 时，看 response 头 200 字判断是哪种情况：
          // 1) 返了 JSON 但 ids 错（id 字段名不对、用了数字/英文）
          // 2) 返了 text 而不是 JSON（prompt 失效）
          // 3) 返了截断的 JSON（max_tokens 触顶）
          outputPreview: jsonResult.substring(0, 200),
          missingInResponse,
          jsonParseFailed,
          outputTail: jsonParseFailed ? outputTail : '',
          parseError: parseErrorMsg,
        };
        sendResponse({ success: true, result: Array.from(result.entries()), trace });
      } catch (error) {
        logger.error('[Background] translateChunk error:', error);
        logger.error('[Background] Full error details:', {
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
      message: TranslateChunkStreamMessage,
      sender: browser.Runtime.MessageSender,
      sendResponse: (response: TranslateChunkStreamResponse) => void
    ) {
      try {
        const config = await getConfig();
        if (!config.useLocalAgent && !config.deepseekApiKey) {
          sendResponse({ success: false, error: 'DeepSeek API Key not configured' });
          return;
        }

        const { jsonContent, sourceLang, targetLang, pageUrl, glossary } = message;

        const matchedRule = pageUrl ? matchSiteRule(pageUrl) : null;
        const sitePrompt = matchedRule ? buildSitePrompt(matchedRule.siteRule) : '';

        // 文风：同 handleTranslateChunk，优先用页级检测结果，缺省回退配置。
        const promptStyle = message.promptStyle ?? config.promptStyle;

        const service = getService(config, promptStyle);

        const stream = service.translateStream(
          jsonContent,
          sourceLang,
          targetLang,
          glossary,
          sitePrompt
        );

        let finalContent = '';
        const streamTabId = message.tabId ?? sender.tab?.id;
        for await (const partial of stream) {
          finalContent = partial;
          // 发送中间结果到 content script
          if (streamTabId === undefined) continue;
          try {
            await browser.tabs.sendMessage(streamTabId, {
              action: 'translationStreamUpdate',
              partial,
            });
          } catch {
            // tab 可能已关闭，忽略
          }
        }

        const result = processTranslationResult(finalContent);

        // [StreamTrace] 诊断：把模型返回的前 3 条译文贴出来，确认是否 no-op
        try {
          const parsed = JSON.parse(finalContent);
          const translations = parsed.translations || parsed;
          if (Array.isArray(translations)) {
            const streamInputIds = (() => {
              try { return (JSON.parse(message.jsonContent) as Array<{ id: string; text: string }>).map((b) => b); }
              catch { return []; }
            })();
            const sample = translations.slice(0, 3).map((t: { id?: string; translated_text?: string }) => ({
              id: t.id,
              text: typeof t.translated_text === 'string' ? t.translated_text.substring(0, 80) : 'N/A',
            }));
            const noOpCount = translations.filter((t: { translated_text?: string }, i: number) => {
              const inputBlock = streamInputIds[i];
              return inputBlock && t.translated_text === inputBlock.text;
            }).length;
            logger.debug(
              '[Background][StreamTrace] sample=',
              JSON.stringify(sample),
              `noOpCount=${noOpCount}/${translations.length}`,
            );
          }
        } catch {
          /* 不是有效 JSON 时下面的 processTranslationResult 会抛 */
        }

        sendResponse({ success: true, result: Array.from(result.entries()) });
      } catch (error) {
        logger.error('[Background] translateChunkStream error:', error);
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    async function handleValidateApiKey(
      message: ValidateApiKeyMessage,
      sendResponse: (response: ValidateApiKeyResponse) => void
    ) {
      try {
        const { apiKey } = message;
        if (!apiKey) {
          sendResponse({ success: false, error: 'API Key 不能为空' });
          return;
        }

        const config = await getConfig();
        logger.debug('[Background] Validating API Key, length:', apiKey.length);

        const service = new DeepSeekTranslationService(apiKey, config.promptStyle);
        const testContent = JSON.stringify([{ id: 'test', text: 'Hello' }]);

        const timeout = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('请求超时（10秒）')), 10000);
        });

        await Promise.race([
          service.translate(testContent, 'en', 'zh', undefined),
          timeout,
        ]);
        
        sendResponse({ success: true });
      } catch (error) {
        logger.error('[Background] API Key validation failed:', error);
        const errorMsg = error instanceof Error ? error.message : '验证失败';
        logger.error('[Background] Full error stack:', error);
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

    async function handleClearCache(sendResponse: (response: ClearCacheResponse) => void) {
      try {
        // 清理浏览器缓存和本机 SQLite 是两个独立操作；不能把本机请求失败也报告成整体成功。
        await clearAllCache();
        const config = await getConfig();
        if (config.useLocalAgent) {
          let response: Response;
          try {
            response = await fetch(new URL('/api/cache/translation', getLocalAgentBaseUrl(config)).toString(), {
              method: 'DELETE', headers: getLocalAgentHeaders(config),
            });
          } catch (error) {
            logger.warn('[Background] SQLite cache clear request failed:', error);
            sendResponse({
              success: false,
              error: '浏览器扩展缓存已尝试清理，但本机 SQLite 缓存未能连接清除。请确认本机服务正在运行、地址正确且 Token 一致，然后重试。',
            });
            return;
          }
          if (!response.ok) {
            logger.warn('[Background] SQLite cache clear returned HTTP ' + response.status);
            sendResponse({
              success: false,
              error: '浏览器扩展缓存已尝试清理，但本机 SQLite 缓存清理失败（HTTP ' + response.status + '）。请检查服务地址和 Token 后重试。',
            });
            return;
          }
        }
        sendResponse({ success: true });
      } catch (error) {
        sendResponse({
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    async function handleCheckConfig(sendResponse: (response: CheckConfigResponse) => void) {
      try {
        const config = await getConfig();
        if (config.useLocalAgent) {
        let base = config.localAgentUrl || 'http://127.0.0.1:8789';
        while (base.endsWith('/')) base = base.slice(0, -1);
          const headers: Record<string, string> = { 'Content-Type': 'application/json' };
          if (config.localAgentToken) headers.Authorization = 'Bearer ' + config.localAgentToken;
          // /v1/models checks that the service is online and that the shared token is valid.
          const response = await fetch(new URL('/v1/models', base).toString(), { headers });
          if (!response.ok) throw new Error('本机服务返回 HTTP ' + response.status);
          sendResponse({ success: true, config });
        } else if (config.deepseekApiKey) {
          sendResponse({ success: true, config });
        } else {
          sendResponse({ success: false, error: 'API Key 未配置' });
        }
      } catch (error) {
        logger.error('[Background] checkConfig error:', error);
        sendResponse({ success: false, error: error instanceof Error ? error.message : 'Unknown error' });
      }
    }

    async function handleGetPageContext(
      message: GetPageContextMessage,
      sendResponse: (response: GetPageContextResponse) => void
    ) {
      let tabId: number | null = null;
      try {
        tabId = await getActiveContentTabId(message.sourceTabId);
        if (tabId == null) {
          sendResponse({ success: false, error: '找不到可读取内容的标签页' });
          return;
        }

        // 1) 主路径：让该页的 content script 提取正文作为上下文。
        let ctx: PageContext | null = null;
        try {
          ctx = (await browser.tabs.sendMessage(tabId, {
            action: 'extractChatContext',
          })) as PageContext | null;
        } catch {
          // 连接失败（无 content script）：走下方 offscreen 兜底
          ctx = null;
        }

        // 2) 兜底路径：content script 取不到（无脚本 / 返回空）时，
        //    用 offscreen 文档的 DOMParser 解析页面 HTML 抽正文。
        if (!ctx || !ctx.text) {
          const offscreenCtx = await getPageContextViaOffscreen(tabId);
          if (offscreenCtx?.text) {
            sendResponse({ success: true, context: offscreenCtx });
            return;
          }
        } else {
          sendResponse({ success: true, context: ctx });
          return;
        }

        // 3) 都失败：按页面类型给友好提示（chrome:// 等仍走手动粘贴）。
        let hint = '无法提取该页面的正文内容，请手动复制正文后粘贴到对话框';
        try {
          const t = await browser.tabs.get(tabId);
          if (t?.url?.startsWith('file://')) {
            hint = '无法读取本机文件：请在扩展管理页（chrome://extensions）开启"允许访问文件网址"后重试';
          } else if (t?.url?.startsWith('chrome://') || t?.url?.startsWith('about:')) {
            hint = '该页面（浏览器内部页）无法读取，请手动复制正文后粘贴到对话框';
          }
        } catch {
          /* tab 可能已关闭 */
        }
        sendResponse({ success: false, error: hint });
      } catch (error) {
        const msg = error instanceof Error ? error.message : '提取页面内容失败';
        logger.error('[Background] getPageContext error:', error);
        sendResponse({ success: false, error: msg });
      }
    }

    /**
     * 兜底：用 offscreen 文档解析页面取正文。
     * 流程：scripting.executeScript 拿 HTML → 发 offscreen 用 DOMParser 抽正文。
     * 失败（无 offscreen API / 页面不可注入）返回 null，让 UI 走手动粘贴。
     */
    async function getPageContextViaOffscreen(tabId: number): Promise<PageContext | null> {
      try {
        const html = await getPageHtmlViaScripting(tabId);
        if (!html) return null;
        const text = (await parseHtmlViaOffscreen(html))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 16000);
        if (!text) return null;
        const t = await browser.tabs.get(tabId).catch(() => null);
        return { title: t?.title ?? '', url: t?.url ?? '', text };
      } catch (err) {
        logger.debug('[Background] offscreen 兜底取正文失败:', err instanceof Error ? err.message : err);
        return null;
      }
    }

    // ============================================================
    // 消息中枢：把发给 content script 的消息统一由 background 转发，
    // 失败（无 content script / 页面已导航）时返回统一错误，方便 UI 处理。
    // ============================================================
    async function handleRelayToContent(
      message: RelayToContentMessage,
      sendResponse: (response: RelayToContentResponse) => void
    ) {
      try {
        const response = await browser.tabs.sendMessage(message.tabId, message.message);
        sendResponse({ success: true, response: response ?? null });
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'relay failed';
        const isConnectionLost =
          msg.includes('Could not establish connection') ||
          msg.includes('Receiving end does not exist');
        if (isConnectionLost) {
          logger.debug('[Background] relayToContent: 目标页无 content script:', msg);
        } else {
          logger.error('[Background] relayToContent error:', error);
        }
        sendResponse({ success: false, error: msg });
      }
    }

    // ============================================================
    // 对话流式通道：tab 页通过 runtime.connect({name:'chat'}) 建立长连接，
    // 发送 {type:'chat', context, history}，background 流式回传 partial。
    // 端口方式比一次性 sendMessage 更适合长文本流式输出，且 Android 同样支持。
    // ============================================================
    browser.runtime.onConnect.addListener((port) => {
      if (port.name !== 'chat') return;

      // 用户关闭侧栏 / 导航时端口断开 -> 中断在途请求，避免浪费带宽与配额
      const controller = new AbortController();
      port.onDisconnect.addListener(() => controller.abort());

      port.onMessage.addListener(async (msg: unknown) => {
        const m = msg as { type?: string; context?: PageContext; history?: ChatMessage[]; jsonMode?: boolean };
        if (m.type !== 'chat') return;

        const config = await getConfig();
        if (!config.useLocalAgent && !config.deepseekApiKey) {
          port.postMessage({ type: 'error', message: '未配置 DeepSeek API Key，请在插件设置中填写，或启用本机 Workbuddy/OpenCode Provider' });
          return;
        }

        try {
          const system = buildChatSystem(m.context ?? null, m.jsonMode);
          const llmMessages: ChatMessage[] = [{ role: 'system', content: system }, ...(m.history ?? [])];
          let full = '';
          let usage: ChatUsage | null = null;
          if (config.useLocalAgent) {
            const response = await fetch(new URL('/v1/chat/completions', getLocalAgentBaseUrl(config)).toString(), {
              method: 'POST',
              headers: getLocalAgentHeaders(config),
              signal: controller.signal,
              body: JSON.stringify({
                model: getLocalAgentModelId(config),
                messages: llmMessages,
                ...(m.jsonMode ? { response_format: { type: 'json_object' } } : {}),
              }),
            });
            const data = await response.json().catch(() => ({})) as {
              choices?: Array<{ message?: { content?: unknown } }>;
              error?: { message?: string } | string;
            };
            if (!response.ok) {
              const detail = typeof data.error === 'string' ? data.error : data.error?.message;
              throw new Error(detail || '本机 Agent 服务返回 HTTP ' + response.status);
            }
            const content = data.choices?.[0]?.message?.content;
            if (typeof content !== 'string' || !content.trim()) throw new Error('本机 Agent 未返回对话内容');
            full = content;
            port.postMessage({ type: 'partial', text: full });
            port.postMessage({ type: 'done', text: full, usage: null });
            return;
          }
          for await (const partial of chatStream(config.deepseekApiKey, llmMessages, {
            jsonMode: m.jsonMode,
            signal: controller.signal,
            onUsage: (u) => {
              usage = u;
              // 实时回传，供 UI 即时展示缓存命中率（无需等整段生成完）
              port.postMessage({ type: 'usage', usage: u });
            },
          })) {
            full = partial;
            port.postMessage({ type: 'partial', text: full });
          }
          port.postMessage({ type: 'done', text: full, usage });
        } catch (error) {
          // 端口已断开（用户主动关闭）导致的 abort 属正常流程，静默处理
          if (controller.signal.aborted) return;
          logger.error('[Background] chat stream error:', error);
          port.postMessage({
            type: 'error',
            message: error instanceof Error ? error.message : '对话失败',
          });
        }
      });
    });

    async function registerCommands() {
      if (!isCommandsSupported) return;
      try {
        const commands = await browser.commands.getAll();
        logger.debug('Registered commands:', commands);
      } catch (error) {
        logger.warn('Commands API not available:', error);
      }
    }
  },
});
