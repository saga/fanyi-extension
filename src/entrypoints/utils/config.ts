import { storage } from '@wxt-dev/storage';

export interface ShortcutConfig {
  translatePage: string;
  translateSelection: string;
  restoreOriginal: string;
  toggleTranslation: string;
}

export type Provider = 'deepseek' | 'cloudflare' | 'openrouter' | 'nvidia';

export interface Config {
  sourceLang: string;
  targetLang: string;
  deepseekApiKey: string;
  /** 服务端翻译使用的 LLM Provider（仅对"通过远程服务器翻译"生效，本地翻译固定 DeepSeek） */
  provider: Provider;
  floatingBallPosition?: { x: number; y: number };
  shortcuts: ShortcutConfig;
  /** 是否使用服务端翻译（发送到 /fanyi/page） */
  useServerTranslation: boolean;
  /** 服务端翻译地址，留空时使用默认地址 */
  serverUrl: string;
}

const defaultConfig: Config = {
  sourceLang: 'auto',
  targetLang: 'zh',
  deepseekApiKey: '',
  provider: 'deepseek',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  useServerTranslation: false,
  serverUrl: 'https://s.sunxiunan.com/fanyi/page',
};

export async function getConfig(): Promise<Config> {
  const config = await storage.getItem<Partial<Config>>('local:config');
  const merged: Config = { ...defaultConfig, ...config };
  return merged;
}

export async function setConfig(config: Partial<Config>): Promise<void> {
  const currentConfig = await getConfig();
  // Use JSON serialization to strip Proxy/reactive wrappers from Vue refs
  const cleanConfig = JSON.parse(JSON.stringify({ ...currentConfig, ...config }));
  await storage.setItem('local:config', cleanConfig);
}

export async function resetConfig(): Promise<void> {
  await storage.setItem('local:config', defaultConfig);
}

export async function hasApiKey(): Promise<boolean> {
  const config = await getConfig();
  return !!config.deepseekApiKey;
}
