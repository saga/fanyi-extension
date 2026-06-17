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
  deepseekApiKey: string;
  /** OpenAI-compatible chat completions 端点, 例如:
   *   - DeepSeek: https://api.deepseek.com/v1/chat/completions
   *   - OpenAI:   https://api.openai.com/v1/chat/completions
   *   - 自建代理: http://localhost:11434/v1/chat/completions (Ollama)
   * 留空时回落到默认 DeepSeek 端点。
   */
  apiBaseUrl: string;
  floatingBallPosition?: { x: number; y: number };
  shortcuts: ShortcutConfig;
  touchGesture: string;
  /** 是否使用服务端翻译（发送到 /fanyi/page） */
  useServerTranslation: boolean;
  /** 服务端翻译地址，留空时使用默认地址 */
  serverUrl: string;
}

const defaultConfig: Config = {
  enabled: true,
  sourceLang: 'auto',
  targetLang: 'zh',
  deepseekApiKey: '',
  apiBaseUrl: 'https://api.deepseek.com/v1/chat/completions',
  shortcuts: {
    translatePage: 'Alt+T',
    translateSelection: 'Alt+S',
    restoreOriginal: 'Alt+R',
    toggleTranslation: 'Alt+V',
  },
  touchGesture: 'TripleTap',
  useServerTranslation: false,
  serverUrl: 'https://s.sunxiunan.com/fanyi/page',
};

/** 读取 API 端点 URL, 留空时回落到默认 DeepSeek 端点。 */
export async function getApiBaseUrl(): Promise<string> {
  const url = (await getConfig()).apiBaseUrl?.trim();
  return url || 'https://api.deepseek.com/v1/chat/completions';
}

export async function getConfig(): Promise<Config> {
  const config = await storage.getItem<Partial<Config>>('local:config');
  const merged: Config = { ...defaultConfig, ...config };
  // 空字符串 = "用默认", 不应在 UI 显示空。把空值归一化成默认 URL,
  // 这样 popup 始终能展示一个有意义的端点。
  if (!merged.apiBaseUrl?.trim()) {
    merged.apiBaseUrl = defaultConfig.apiBaseUrl;
  }
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
