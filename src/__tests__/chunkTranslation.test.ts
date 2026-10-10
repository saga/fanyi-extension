import { describe, it, expect, vi } from 'vitest';

// chunkTranslation 使用扩展 API，但这些用例只覆盖纯结果校验函数，不触发浏览器消息。
vi.mock('webextension-polyfill', () => ({
  default: { runtime: { sendMessage: vi.fn() } },
}));

import { normalizeChunkTranslationEntries } from '../entrypoints/content/chunkTranslation';

describe('normalizeChunkTranslationEntries', () => {
  it('ignores unknown IDs, empty text, malformed entries, and duplicate IDs', () => {
    const entries = [
      ['b1', 'First translation'],
      ['foreign-id', 'Must not count as translated'],
      ['b2', '   '],
      ['b1', 'Duplicate translation'],
      ['b2'],
      null,
    ];

    const result = normalizeChunkTranslationEntries(entries, ['b1', 'b2']);

    expect(Array.from(result.entries())).toEqual([['b1', 'First translation']]);
    expect(result.has('foreign-id')).toBe(false);
    expect(result.has('b2')).toBe(false);
  });

  it('accepts all non-empty translations whose IDs belong to the current chunk', () => {
    const result = normalizeChunkTranslationEntries(
      [['b1', '译文一'], ['b2', '译文二']],
      ['b1', 'b2'],
    );

    expect(result.size).toBe(2);
    expect(result.get('b1')).toBe('译文一');
    expect(result.get('b2')).toBe('译文二');
  });
});
