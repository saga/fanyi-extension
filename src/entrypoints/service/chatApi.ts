export type ChatApiProvider = 'deepseek' | 'gemini' | 'openai' | 'compatible';

export interface ChatApiSettings {
  provider: ChatApiProvider;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export const CHAT_API_DEFAULTS: Record<ChatApiProvider, { baseUrl: string; model: string }> = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.5-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4.1-mini' },
  compatible: { baseUrl: '', model: '' },
};

export function normalizeChatApiBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error('API Base URL 格式不正确，请填写完整的 http(s) 地址');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('API Base URL 必须使用 HTTPS（本机 localhost 除外）');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('API Base URL 不应包含账号、密码、查询参数或片段');
  }
  return trimmed;
}

export function validateChatApiSettings(settings: ChatApiSettings): string[] {
  const issues: string[] = [];
  const defaults = CHAT_API_DEFAULTS[settings.provider] ?? CHAT_API_DEFAULTS.compatible;
  if (!Object.prototype.hasOwnProperty.call(CHAT_API_DEFAULTS, settings.provider)) issues.push('不支持的 API Provider');
  const baseUrl = settings.baseUrl.trim() || defaults.baseUrl;
  const model = settings.model.trim() || defaults.model;
  if (!settings.apiKey.trim()) issues.push('尚未填写 API Key');
  if (!baseUrl) issues.push('尚未填写 API Base URL');
  else {
    try {
      normalizeChatApiBaseUrl(baseUrl);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : 'API Base URL 无效');
    }
  }
  if (!model) issues.push('尚未填写模型 ID');
  return issues;
}

export function getChatApiEndpoint(settings: ChatApiSettings): string {
  const defaults = CHAT_API_DEFAULTS[settings.provider];
  const baseUrl = normalizeChatApiBaseUrl(settings.baseUrl.trim() || defaults.baseUrl);
  if (!baseUrl) throw new Error('请先填写 API Base URL');
  return baseUrl + '/chat/completions';
}

export function getChatApiModel(settings: ChatApiSettings): string {
  return settings.model.trim() || CHAT_API_DEFAULTS[settings.provider].model;
}
