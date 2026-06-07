import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cacheManager
const mockCache = {
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
};

vi.mock('../entrypoints/utils/cacheManager', () => ({
  translationCache: {
    get: (...args: any[]) => mockCache.get(...args),
    set: (...args: any[]) => mockCache.set(...args),
    clear: () => mockCache.clear(),
  },
}));

import {
  processTranslationResult,
  logUnchangedBlocks,
  getCachedTranslation,
  cacheTranslation,
  clearAllCache,
} from '../entrypoints/utils/translateApi';

describe('processTranslationResult', () => {
  it('parses JSON with translations array', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: '你好' },
        { id: 'b2', translated_text: '世界' },
      ],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });

  it('parses JSON with direct array (no translations wrapper)', () => {
    const json = JSON.stringify([
      { id: 'b1', translated_text: '你好' },
      { id: 'b2', translated_text: '世界' },
    ]);
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('你好');
    expect(result.get('b2')).toBe('世界');
  });

  it('returns empty Map for empty translations array', () => {
    const json = JSON.stringify({ translations: [] });
    const result = processTranslationResult(json);
    expect(result.size).toBe(0);
  });

  it('handles single translation item', () => {
    const json = JSON.stringify({
      translations: [{ id: 'b1', translated_text: '单个翻译' }],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('单个翻译');
  });

  it('preserves empty translated_text', () => {
    const json = JSON.stringify({
      translations: [{ id: 'b1', translated_text: '' }],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('');
  });

  it('handles items with extra fields', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: '你好', confidence: 0.95, extra: 'data' },
      ],
    });
    const result = processTranslationResult(json);
    expect(result.get('b1')).toBe('你好');
  });

  it('throws on invalid JSON', () => {
    expect(() => processTranslationResult('not json')).toThrow();
  });
});

describe('logUnchangedBlocks', () => {
  it('returns the original string untouched', () => {
    const raw = JSON.stringify({ translations: [{ id: 'b1', translated_text: '你好' }] });
    const out = logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(out).toBe(raw);
  });

  it('does not throw on invalid JSON', () => {
    expect(() => logUnchangedBlocks('not json', [{ id: 'b1', text: 'x' }])).not.toThrow();
    expect(logUnchangedBlocks('not json', [{ id: 'b1', text: 'x' }])).toBe('not json');
  });

  it('warns when a block came back unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify({ translations: [{ id: 'b1', translated_text: 'hello' }] });
    logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(warn).toHaveBeenCalled();
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).toContain('b1');
    warn.mockRestore();
  });

  it('errors when every block came back unchanged', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: 'hello' },
        { id: 'b2', translated_text: 'world' },
      ],
    });
    logUnchangedBlocks(raw, [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ]);
    expect(err).toHaveBeenCalled();
    expect(String(err.mock.calls[0]?.[0])).toMatch(/ALL/);
    warn.mockRestore();
    err.mockRestore();
  });

  it('warns when response is missing blocks from the input', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify({ translations: [{ id: 'b1', translated_text: '你好' }] });
    logUnchangedBlocks(raw, [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ]);
    const allArgs = warn.mock.calls.flat().map(String).join(' | ');
    expect(allArgs).toMatch(/missing/);
    warn.mockRestore();
  });

  it('is silent when all blocks were translated', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = JSON.stringify({
      translations: [
        { id: 'b1', translated_text: '你好' },
        { id: 'b2', translated_text: '世界' },
      ],
    });
    logUnchangedBlocks(raw, [
      { id: 'b1', text: 'hello' },
      { id: 'b2', text: 'world' },
    ]);
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });

  it('accepts the bare-array form (no translations wrapper)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const raw = JSON.stringify([{ id: 'b1', translated_text: 'hello' }]);
    logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('getCachedTranslation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null when cache is empty', async () => {
    mockCache.get.mockResolvedValue(null);
    const result = await getCachedTranslation('test-key');
    expect(result).toBeNull();
  });

  it('returns Map from cached plain object', async () => {
    mockCache.get.mockResolvedValue({ b1: '你好', b2: '世界' });
    const result = await getCachedTranslation('test-key');
    expect(result).toBeInstanceOf(Map);
    expect(result?.get('b1')).toBe('你好');
    expect(result?.get('b2')).toBe('世界');
    expect(result?.size).toBe(2);
  });

  it('returns empty Map for empty object', async () => {
    mockCache.get.mockResolvedValue({});
    const result = await getCachedTranslation('test-key');
    expect(result).toBeInstanceOf(Map);
    expect(result?.size).toBe(0);
  });

  it('handles single entry', async () => {
    mockCache.get.mockResolvedValue({ b1: '单个翻译' });
    const result = await getCachedTranslation('test-key');
    expect(result?.get('b1')).toBe('单个翻译');
  });
});

describe('cacheTranslation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores Map as plain object with 7-day TTL', async () => {
    const data = new Map([
      ['b1', '你好'],
      ['b2', '世界'],
    ]);
    await cacheTranslation('test-key', data);

    expect(mockCache.set).toHaveBeenCalledTimes(1);
    const [key, storedObj, ttl] = mockCache.set.mock.calls[0];
    expect(key).toBe('test-key');
    expect(storedObj).toEqual({ b1: '你好', b2: '世界' });
    expect(ttl).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('stores empty Map', async () => {
    await cacheTranslation('test-key', new Map());
    expect(mockCache.set).toHaveBeenCalledWith('test-key', {}, 7 * 24 * 60 * 60 * 1000);
  });

  it('stores single entry', async () => {
    const data = new Map([['b1', '单个翻译']]);
    await cacheTranslation('test-key', data);
    const [, storedObj] = mockCache.set.mock.calls[0];
    expect(storedObj).toEqual({ b1: '单个翻译' });
  });
});

describe('clearAllCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the translation cache', async () => {
    await clearAllCache();
    expect(mockCache.clear).toHaveBeenCalledTimes(1);
  });

  it('throws if cache clear fails', async () => {
    mockCache.clear.mockRejectedValueOnce(new Error('Storage error'));
    await expect(clearAllCache()).rejects.toThrow('Storage error');
  });
});
