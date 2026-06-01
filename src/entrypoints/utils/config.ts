import { storage } from '@wxt-dev/storage';

export interface ShortcutConfig {
  translatePage: string;
  translateSelection: string;
  restoreOriginal: string;
  toggleTranslation: string;
}

export interface Config {
  enabled: boolean;
  sourceLang: string;
  targetLang: string;
  mode: 'bilingual' | 'target';
  deepseekApiKey: string;
  floatingBallPosition?: { x: number; y: number };
  shortcuts: ShortcutConfig;
  touchGesture: string;
}

const defaultConfig: Config = {
  enabled: true,
  sourceLang: 'auto',
  targetLang: 'zh',
  mode: 'bilingual',
  deepseekApiKey: '',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  touchGesture: 'TripleTap',
};

export async function getConfig(): Promise<Config> {
  const config = await storage.getItem<Partial<Config>>('local:config');
  return { ...defaultConfig, ...config };
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
