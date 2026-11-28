import { describe, it, expect, vi, beforeEach } from 'vitest';

// Readability 解析失败的场景：验证 DOM 抽取证据仍能阻止评分选中局部容器。
vi.mock('@mozilla/readability', () => ({
  Readability: class {
    parse() {
      return null;
    }
  },
}));

import { detectArticleRoot } from '../entrypoints/utils/contentDetector';
import { prepareDocument } from '../entrypoints/utils/contentHelper';
import {
  buildNodeMap,
  extractBlocksFromRoots,
} from '../entrypoints/utils/blockExtractor';

describe('root evidence fallback', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('uses DOM extraction evidence when Readability fails and scoring picks a fragment', () => {
    const paragraph = 'Castle Bravo was a full-scale thermonuclear test whose unexpectedly large yield came from the lithium-7 reaction. The scientists had anticipated a much smaller explosion, and the fallout triggered a major international incident.';
    const paragraphs = Array.from({ length: 16 }, (_, i) =>
      `<p>${paragraph} This is paragraph number ${i + 1} of the main discussion.</p>`,
    ).join('');
    const footnotes = Array.from({ length: 5 }, (_, i) =>
      `<li id="fn${i + 1}"><p>${paragraph} This is footnote number ${i + 1} with fewer links.</p></li>`,
    ).join('');
    const inlineNoise = 'var siteConfig = "navigation metadata for the publication"; '.repeat(120);

    document.body.innerHTML = `
      <header><h1>Which Future?</h1></header>
      <script>${inlineNoise}</script>
      ${paragraphs}
      <section class="footnotes"><ol>${footnotes}</ol></section>
    `;

    const root = detectArticleRoot(document);
    expect(root?.element).toBe(document.body);
    expect(root?.source).toBe('body-fallback');
  });

  it('keeps every scoped block mapped back to an original DOM node', () => {
    const paragraph = 'Castle Bravo was a full-scale thermonuclear test whose unexpectedly large yield came from the lithium-7 reaction. The scientists had anticipated a much smaller explosion, and the fallout triggered a major international incident.';
    const paragraphs = Array.from({ length: 16 }, (_, i) =>
      `<p>${paragraph} This is paragraph number ${i + 1} of the main discussion.</p>`,
    ).join('');
    const footnotes = Array.from({ length: 5 }, (_, i) =>
      `<li id="fn${i + 1}"><p>${paragraph} This is footnote number ${i + 1} with fewer links.</p></li>`,
    ).join('');

    document.body.innerHTML = `
      <header><h1>Which Future?</h1></header>
      <script>var siteConfig = "navigation metadata";</script>
      ${paragraphs}
      <section class="footnotes"><ol>${footnotes}</ol></section>
    `;

    const { blocks } = prepareDocument(document);
    expect(blocks.length).toBeGreaterThanOrEqual(16);
    expect(blocks.map((block) => block.text).join(' ')).toContain('paragraph number 16');
    expect(buildNodeMap(blocks, document).size).toBe(blocks.length);
  });

  it('extracts from multiple content roots in document order with continuous block ids', () => {
    const first = 'The first article region contains several sentences that must be translated in order.';
    const second = 'The second article region contains several sentences that must be translated in order.';
    document.body.innerHTML = `
      <div id="first"><p>${first}</p></div>
      <nav><p>Navigation text should not be included in the extraction scope.</p></nav>
      <div id="second"><p>${second}</p></div>
    `;

    const blocks = extractBlocksFromRoots([
      document.getElementById('first')!,
      document.getElementById('second')!,
    ]);
    expect(blocks.map((block) => block.text)).toEqual([first, second]);
    expect(new Set(blocks.map((block) => block.id)).size).toBe(blocks.length);
  });
});
