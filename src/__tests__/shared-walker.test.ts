/**
 * 双 walker 共享 fixture 测试（fanyi-extension 侧）。
 * 见 src/__tests__/fixtures/article-roots.ts 的说明：同一组结构在 vocal-saga 也有
 * 一份相同测试，用于捕获两个 blockExtractor 副本的语义漂移。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { extractBlocks } from '../entrypoints/utils/blockExtractor';
import { ARTICLE_ROOT_FIXTURES } from './fixtures/article-roots';

describe('shared walker fixtures (fanyi-extension)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  for (const fx of ARTICLE_ROOT_FIXTURES) {
    it(`extracts body paragraphs for: ${fx.name}`, () => {
      document.body.innerHTML = fx.html;
      const blocks = extractBlocks(document);
      const allText = blocks.map((b) => b.text).join('\n');
      for (const expected of fx.expectTexts) {
        expect(allText, `expected "${expected}" to be extracted from ${fx.name}`).toContain(
          expected,
        );
      }
    });
  }
});
