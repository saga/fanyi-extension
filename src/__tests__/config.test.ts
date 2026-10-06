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
  provider: 'deepseek',
  promptStyle: 'default',
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