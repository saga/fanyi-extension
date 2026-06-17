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

import { getConfig, setConfig, resetConfig, hasApiKey } from '../entrypoints/utils/config';
import type { Config } from '../entrypoints/utils/config';

const defaultConfig: Config = {
  sourceLang: 'auto',
  targetLang: 'zh',
  deepseekApiKey: '',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  useServerTranslation: false,
  serverUrl: 'https://s.sunxiunan.com/fanyi/page',
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

    it('merges stored partial config with defaults', async () => {
      store['local:config'] = { targetLang: 'en', deepseekApiKey: 'sk-test' };
      const config = await getConfig();
      expect(config.targetLang).toBe('en');
      expect(config.deepseekApiKey).toBe('sk-test');
      expect(config.sourceLang).toBe('auto'); // default preserved
    });

    it('overrides shortcuts via shallow merge (stored shortcuts replace entire object)', async () => {
      store['local:config'] = {
        shortcuts: { translatePage: 'Ctrl+T' },
      };
      const config = await getConfig();
      expect(config.shortcuts.translatePage).toBe('Ctrl+T');
      // Shallow merge: stored shortcuts object replaces default entirely
      expect(config.shortcuts.translateSelection).toBeUndefined();
    });
  });

  describe('setConfig', () => {
    it('stores partial config and merges with defaults', async () => {
      await setConfig({ targetLang: 'ja' });
      const stored = store['local:config'];
      expect(stored.targetLang).toBe('ja');
      expect(stored.sourceLang).toBe('auto'); // default preserved in merge
    });

    it('strips Proxy/reactive wrappers via JSON serialization', async () => {
      // Simulate a Vue ref-like proxy by creating an object with non-serializable getters
      const proxyLike = {
        get targetLang() {
          return 'en';
        },
        nonSerializable: undefined,
      };
      // Access the getter to get the value
      const rawValue = { targetLang: proxyLike.targetLang };
      await setConfig(rawValue);
      const stored = store['local:config'];
      expect(stored.targetLang).toBe('en');
    });

    it('overwrites existing config values', async () => {
      store['local:config'] = { targetLang: 'en' };
      await setConfig({ sourceLang: 'zh' });
      const stored = store['local:config'];
      expect(stored.targetLang).toBe('en'); // preserved
      expect(stored.sourceLang).toBe('zh'); // overwritten
    });
  });

  describe('resetConfig', () => {
    it('resets storage to default config', async () => {
      store['local:config'] = {
        targetLang: 'ja',
      };
      await resetConfig();
      expect(store['local:config']).toEqual(defaultConfig);
    });

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