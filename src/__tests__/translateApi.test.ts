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
  hasCompleteTranslationSet,
  logUnchangedBlocks,
  getCachedTranslation,
  cacheTranslation,
  clearAllCache,
  TRANSLATIONS_OBJECT_SCHEMA,
} from '../entrypoints/utils/translateApi';

describe('hasCompleteTranslationSet', () => {
  it('accepts only a complete set of non-empty translations with the expected IDs', () => {
    expect(hasCompleteTranslationSet(new Map([['b1', '你好'], ['b2', '世界']]), ['b1', 'b2'])).toBe(true);
    expect(hasCompleteTranslationSet(new Map([['b1', '你好']]), ['b1', 'b2'])).toBe(false);
    expect(hasCompleteTranslationSet(new Map([['b1', '你好'], ['b2', '  ']]), ['b1', 'b2'])).toBe(false);
    expect(hasCompleteTranslationSet(new Map([['b1', '你好'], ['extra', '多余']]), ['b1'])).toBe(false);
    expect(hasCompleteTranslationSet(new Map([['b1', '你好']]), ['b1', 'b1'])).toBe(false);
    expect(hasCompleteTranslationSet(new Map(), [])).toBe(false);
  });
});

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






  // 真实场景：prompt 要求 `translated_text` 字段，但模型经常自由发挥用 `text`。
  // 修复前的 hard bug：id 全在、map 全空、content 报 missing。回归测试。
  it('accepts `text` field as fallback (model flattens naming)', () => {
    const json = JSON.stringify({
      translations: [
        { id: 'b66', text: '这处房产位于诺埃街160号' },
        { id: 'b67', text: '另一段翻译' },
      ],
    });
    const result = processTranslationResult(json);
    expect(result.size).toBe(2);
    expect(result.get('b66')).toBe('这处房产位于诺埃街160号');
    expect(result.get('b67')).toBe('另一段翻译');
  });



  it('still rejects entries with neither id nor text', () => {
    const json = JSON.stringify({
      translations: [{ translated_text: 'no id' }, { id: 'b1' }], // 第二条没 text
    });
    const result = processTranslationResult(json);
    expect(result.size).toBe(0);
  });

  it('throws on invalid JSON', () => {
    expect(() => processTranslationResult('not json')).toThrow();
  });

  // 回归：模型返回裸对象时以前抛 "translations is not iterable"，无形状信息。
  it('throws a descriptive error when the top level is not a translation array', () => {
    expect(() => processTranslationResult('{"answer":"hello"}')).toThrow(/不是翻译数组/);
    expect(() => processTranslationResult('{"answer":"hello"}')).toThrow(/answer/);
    expect(() => processTranslationResult('{"translations":{"b1":"你好"}}')).toThrow(/不是翻译数组/);
    expect(() => processTranslationResult('"just a string"')).toThrow(/不是翻译数组/);
    expect(() => processTranslationResult('42')).toThrow(/不是翻译数组/);
  });

  // 单块 chunk 时模型经常返回裸对象而非单元素数组：形状合法，接受。
  it('accepts a bare single-entry object', () => {
    const result = processTranslationResult('{"id":"b1","translated_text":"AWS 新闻博客"}');
    expect(result.size).toBe(1);
    expect(result.get('b1')).toBe('AWS 新闻博客');
  });

  // 严格 schema 必须包一层 object：CLI StructuredOutput 工具拒收顶层 array。
  it('TRANSLATIONS_OBJECT_SCHEMA wraps the array in an object', () => {
    expect(TRANSLATIONS_OBJECT_SCHEMA.type).toBe('object');
    const schema = TRANSLATIONS_OBJECT_SCHEMA as unknown as {
      properties: { translations: { type: string; items: { required: string[] } } };
      required: string[];
    };
    expect(schema.properties.translations.type).toBe('array');
    expect(schema.properties.translations.items.required).toContain('id');
    expect(schema.required).toContain('translations');
  });
});

describe('logUnchangedBlocks', () => {
  it('returns the original string untouched', () => {
    const raw = JSON.stringify({ translations: [{ id: 'b1', translated_text: '你好' }] });
    const out = logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(out).toBe(raw);
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

  // 配套：logUnchangedBlocks 也得认 `text` 字段，否则 `unchanged` 统计会漏。
  it('detects unchanged blocks when model uses `text` field', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const raw = JSON.stringify({ translations: [{ id: 'b1', text: 'hello' }] });
    logUnchangedBlocks(raw, [{ id: 'b1', text: 'hello' }]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
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


});

describe('clearAllCache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears the translation cache', async () => {
    await clearAllCache();
    expect(mockCache.clear).toHaveBeenCalledTimes(1);
  });

});
