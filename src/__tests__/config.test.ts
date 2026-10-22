import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @wxt-dev/storage
const store: Record<string, any> = {};
vi.mock('@wxt-dev/storage', () => {
  return {
    storage: {
      getItem: vi.fn(async (key: string) => store[key] ?? null),
      setItem: vi.fn(async (key: string, value: any) => {
        store[key] = value;
      }),
    },
  };
});

import { getConfig, setConfig, resetConfig, hasApiKey, DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES } from '../entrypoints/utils/config';
import type { Config } from '../entrypoints/utils/config';

const defaultConfig: Config = {
  sourceLang: 'auto',
  targetLang: 'zh',
  deepseekApiKey: '',
  provider: 'deepseek',
  promptStyle: 'default',
  translationMode: 'technical',
  documentEnglishFontFamily: 'Georgia',
  documentChineseFontFamily: 'Noto Serif CJK SC',
  documentEnglishFontSize: 17,
  documentChineseFontSize: 18,
  documentSystemPromptOverride: '',
  documentUserPromptTemplate: '',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  useServerTranslation: false,
  serverUrl: 'https://s.sunxiunan.com/fanyi/page',
  useLocalAgent: false,
  localAgentProvider: 'workbuddy',
  localAgentUrl: 'http://127.0.0.1:8789',
  localAgentModel: 'auto',
  localAgentToken: '',
  documentSourceLang: 'auto',
  documentTargetLang: 'zh',
  documentDeepseekApiKey: '',
  documentProvider: 'deepseek',
  documentPromptStyle: 'default',
  documentTranslationMode: 'technical',
  documentUseServerTranslation: false,
  documentServerUrl: 'https://s.sunxiunan.com/fanyi/page',
  documentUseLocalAgent: false,
  documentAutoSelectLocalAgent: true,
  documentLocalAgentProvider: 'workbuddy',
  documentLocalAgentUrl: 'http://127.0.0.1:8789',
  documentLocalAgentModel: 'auto',
  documentLocalAgentToken: '',
  documentBatchMaxSegments: 16,
  documentBatchMaxSourceChars: 8000,
  documentTranslationConcurrency: 4,
  documentReviewConcurrency: 2,
  documentPrecedingContextSegments: 4,
  documentContextBudgetChars: 18000,
  documentMaxModelAttempts: 2,
  documentLiteraryReviewEnabled: true,
  // 任务级模型/思考配置整块来自默认表；这里只引用，不复制一份容易过期的手写副本。
  documentCodeBuddyTaskProfiles: DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES,
};

describe('config', () => {
  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
  });

  describe('getConfig', () => {
    it('returns default config when storage is empty', async () => {
      const config = await getConfig();
      expect(config).toEqual(defaultConfig);
    });


  });


  describe('document-specific translation config', () => {
    it('snapshots legacy global provider values into document settings during migration', async () => {
      store['local:config'] = {
        provider: 'openrouter',
        deepseekApiKey: 'page-key',
        useLocalAgent: true,
        localAgentProvider: 'opencode',
        localAgentUrl: 'http://127.0.0.1:9999',
        translationMode: 'literary',
      };
      const config = await getConfig();
      expect(config.documentProvider).toBe('openrouter');
      expect(config.documentDeepseekApiKey).toBe('page-key');
      expect(config.documentUseLocalAgent).toBe(true);
      expect(config.documentAutoSelectLocalAgent).toBe(true);
      expect(config.documentLocalAgentProvider).toBe('opencode');
      expect(config.documentLocalAgentUrl).toBe('http://127.0.0.1:9999');
      expect(config.documentTranslationMode).toBe('literary');
      expect(store['local:config'].documentProvider).toBe('openrouter');
      expect(store['local:config'].documentLocalAgentUrl).toBe('http://127.0.0.1:9999');
    });

    it('keeps document auto-selection independent of webpage Agent settings', async () => {
      store['local:config'] = { useLocalAgent: false, localAgentUrl: 'http://127.0.0.1:9999' };
      const config = await getConfig();
      expect(config.useLocalAgent).toBe(false);
      expect(config.documentUseLocalAgent).toBe(false);
      expect(config.documentAutoSelectLocalAgent).toBe(true);
      expect(config.documentLocalAgentUrl).toBe('http://127.0.0.1:9999');
    });

    it('keeps the migrated document provider unchanged when saving a global page provider change', async () => {
      store['local:config'] = { provider: 'deepseek', localAgentModel: 'global-model' };
      await setConfig({ provider: 'gemini' });
      expect(store['local:config'].provider).toBe('gemini');
      expect(Object.hasOwn(store['local:config'], 'documentProvider')).toBe(true);
      expect(Object.hasOwn(store['local:config'], 'documentLocalAgentModel')).toBe(true);
      expect((await getConfig()).documentProvider).toBe('deepseek');
    });

    it('keeps document provider independent once a document profile is saved', async () => {
      store['local:config'] = { provider: 'deepseek' };
      const inherited = await getConfig();
      await setConfig({
        documentProvider: 'openrouter',
        documentDeepseekApiKey: inherited.documentDeepseekApiKey,
        documentSourceLang: inherited.documentSourceLang,
        documentTargetLang: inherited.documentTargetLang,
        documentPromptStyle: inherited.documentPromptStyle,
        documentTranslationMode: inherited.documentTranslationMode,
        documentUseServerTranslation: inherited.documentUseServerTranslation,
        documentServerUrl: inherited.documentServerUrl,
        documentUseLocalAgent: inherited.documentUseLocalAgent,
        documentLocalAgentProvider: inherited.documentLocalAgentProvider,
        documentLocalAgentUrl: inherited.documentLocalAgentUrl,
        documentLocalAgentModel: inherited.documentLocalAgentModel,
        documentLocalAgentToken: inherited.documentLocalAgentToken,
      });
      await setConfig({ provider: 'gemini' });
      const config = await getConfig();
      expect(config.provider).toBe('gemini');
      expect(config.documentProvider).toBe('openrouter');
    });
  });

  describe('resetConfig', () => {

    it('works when storage was empty', async () => {
      await resetConfig();
      expect(store['local:config']).toEqual(defaultConfig);
    });
  });

  describe('hasApiKey', () => {
    it('returns false when no API key is set', async () => {
      const result = await hasApiKey();
      expect(result).toBe(false);
    });

    it('returns false when API key is empty string', async () => {
      store['local:config'] = { deepseekApiKey: '' };
      const result = await hasApiKey();
      expect(result).toBe(false);
    });

    it('returns true when API key is set', async () => {
      store['local:config'] = { deepseekApiKey: 'sk-abc123' };
      const result = await hasApiKey();
      expect(result).toBe(true);
    });
  });
});

describe('CodeBuddy context-window configuration', () => {
  it('keeps the default untouched unless a positive integer tier was explicitly saved', async () => {
    const defaults = await getConfig();
    expect(defaults.documentCodeBuddyTaskProfiles.translation.contextWindow).toBeUndefined();
    store['local:config'] = {
      documentCodeBuddyTaskProfiles: {
        translation: { ...DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES.translation, contextWindow: '1000000' },
        accuracyReview: { ...DEFAULT_DOCUMENT_CODEBUDDY_TASK_PROFILES.accuracyReview, contextWindow: '1M' },
      },
    };
    const normalized = await getConfig();
    expect(normalized.documentCodeBuddyTaskProfiles.translation.contextWindow).toBe(1_000_000);
    expect(normalized.documentCodeBuddyTaskProfiles.accuracyReview.contextWindow).toBeUndefined();
  });
});
