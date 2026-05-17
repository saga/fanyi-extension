import { storage } from '@wxt-dev/storage';

export interface Config {
  enabled: boolean;
  sourceLang: string;
  targetLang: string;
  mode: 'bilingual' | 'target';
  deepseekApiKey: string;
  floatingBallPosition?: { x: number; y: number };
}

const defaultConfig: Config = {
  enabled: true,
  sourceLang: 'auto',
  targetLang: 'zh',
  mode: 'bilingual',
  deepseekApiKey: '',
};

export async function getConfig(): Promise<Config> {
  const config = await storage.getItem<Partial<Config>>('local:config');
  return { ...defaultConfig, ...config };
}

export async function setConfig(config: Partial<Config>): Promise<void> {
  const currentConfig = await getConfig();
  await storage.setItem('local:config', { ...currentConfig, ...config });
}

export async function resetConfig(): Promise<void> {
  await storage.setItem('local:config', defaultConfig);
}

export async function hasApiKey(): Promise<boolean> {
  const config = await getConfig();
  return !!config.deepseekApiKey;
}
