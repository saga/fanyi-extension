import { describe, expect, it } from 'vitest';
import {
  CHAT_API_DEFAULTS,
  getChatApiEndpoint,
  getChatApiModel,
  normalizeChatApiBaseUrl,
  validateChatApiSettings,
} from '../entrypoints/service/chatApi';

describe('web chat API providers', () => {
  it.each(['deepseek', 'gemini', 'openai'] as const)('provides usable defaults for %s', (provider) => {
    const defaults = CHAT_API_DEFAULTS[provider];
    expect(defaults.baseUrl).toMatch(/^https:\/\//);
    expect(defaults.model).toBeTruthy();
    expect(getChatApiEndpoint({ provider, ...defaults, apiKey: 'test-key' }))
      .toBe(defaults.baseUrl + '/chat/completions');
  });

  it('requires an explicit base URL and model for OpenAI-compatible endpoints', () => {
    expect(validateChatApiSettings({
      provider: 'compatible', baseUrl: '', apiKey: 'test-key', model: '',
    })).toEqual(['尚未填写 API Base URL', '尚未填写模型 ID']);
  });

  it('rejects non-HTTPS remote endpoints', () => {
    expect(() => normalizeChatApiBaseUrl('http://api.example.com/v1'))
      .toThrow('必须使用 HTTPS');
  });

  it('allows localhost HTTP endpoints and removes trailing slashes', () => {
    expect(normalizeChatApiBaseUrl('http://127.0.0.1:8080/v1///'))
      .toBe('http://127.0.0.1:8080/v1');
  });

  it('uses provider defaults when the model field is empty', () => {
    expect(getChatApiModel({
      provider: 'gemini', baseUrl: '', apiKey: 'test-key', model: '',
    })).toBe(CHAT_API_DEFAULTS.gemini.model);
  });
});
