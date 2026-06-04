import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock cacheManager
const mockCache = {
  get: vi.fn(),
  set: vi.fn(),
  clear: vi.fn(),
};

vi.mock('./cacheManager', () => ({
  analysisCache: {
    get: (...args: any[]) => mockCache.get(...args),
    set: (...args: any[]) => mockCache.set(...args),
    clear: () => mockCache.clear(),
  },
  translationCache: {
    get: (...args: any[]) => mockCache.get(...args),
    set: (...args: any[]) => mockCache.set(...args),
    clear: () => mockCache.clear(),
  },
}));

import {
  processTranslationResult,
  prepareSelectionTask,
  getCachedTranslation,
  cacheTranslation,
  clearAllCache,
} from './translateApi';

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

describe('prepareSelectionTask', () => {
  it('wraps text in selection task format', () => {
    const result = prepareSelectionTask('Hello world');
    const parsed = JSON.parse(result);
    expect(parsed).toEqual([{ id: 'b1', text: 'Hello world' }]);
  });

  it('handles empty string', () => {
    const result = prepareSelectionTask('');
    const parsed = JSON.parse(result);
    expect(parsed).toEqual([{ id: 'b1', text: '' }]);
  });

  it('handles special characters', () => {
    const result = prepareSelectionTask('Hello "world" & <friends>');
    const parsed = JSON.parse(result);
    expect(parsed[0].text).toBe('Hello "world" & <friends>');
  });

  it('handles multiline text', () => {
    const result = prepareSelectionTask('Line 1\nLine 2\nLine 3');
    const parsed = JSON.parse(result);
    expect(parsed[0].text).toBe('Line 1\nLine 2\nLine 3');
  });

  it('handles unicode text', () => {
    const result = prepareSelectionTask('こんにちは世界');
    const parsed = JSON.parse(result);
    expect(parsed[0].text).toBe('こんにちは世界');
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

  it('clears both analysis and translation caches', () => {
    clearAllCache();
    expect(mockCache.clear).toHaveBeenCalledTimes(2);
  });
});