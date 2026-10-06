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

});
