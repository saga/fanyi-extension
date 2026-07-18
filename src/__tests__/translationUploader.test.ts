import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fetch
globalThis.fetch = vi.fn();

import { uploadTranslation, type UploadRequest } from '../entrypoints/utils/translationUploader';

describe('uploadTranslation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects when shareTranslations is false', async () => {
    const result = await uploadTranslation(
      { serverUrl: 'https://example.com/fanyi/page', shareTranslations: false } as any,
      {} as UploadRequest,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('未开启');
  });

  it('rejects private URLs', async () => {
    const result = await uploadTranslation(
      { serverUrl: 'https://example.com/fanyi/page', shareTranslations: true } as any,
      { url: 'http://localhost:3000/test', html: '<html></html>' } as UploadRequest,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('私有');
  });

  it('rejects oversized HTML', async () => {
    const result = await uploadTranslation(
      { serverUrl: 'https://example.com/fanyi/page', shareTranslations: true } as any,
      { url: 'https://example.com/article', html: 'x'.repeat(900001) } as UploadRequest,
    );
    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('超过');
  });

  it('calls fetch when all checks pass', async () => {
    (globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ accepted: true }),
    });

    const result = await uploadTranslation(
      { serverUrl: 'https://example.com/fanyi/page', shareTranslations: true } as any,
      {
        url: 'https://example.com/article',
        html: '<html></html>',
        sourceLang: 'en',
        targetLang: 'zh',
        provider: 'deepseek',
        promptStyle: 'default',
        contentHash: 'abc123',
      } as UploadRequest,
    );

    expect(result.accepted).toBe(true);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('handles fetch failure gracefully', async () => {
    (globalThis.fetch as any).mockRejectedValueOnce(new Error('network'));

    const result = await uploadTranslation(
      { serverUrl: 'https://example.com/fanyi/page', shareTranslations: true } as any,
      {
        url: 'https://example.com/article',
        html: '<html></html>',
      } as UploadRequest,
    );

    expect(result.accepted).toBe(false);
    expect(result.reason).toContain('网络');
  });
});
