import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { extractBlocks, findBlockNode, buildNodeMap, collapseSpacedText } from '../entrypoints/utils/blockExtractor';
import { shouldSkipByClass, isLowPriorityElement, isOverlayElement, classifyNode, isParagraphLikeElement, normalizeBlockText, isElementHidden } from '../entrypoints/utils/blockExtractor/rules';
import { applyBlockTranslation } from '../entrypoints/utils/translationDisplay';

// Mock matchSiteRule for shouldSkipBySiteRules tests
vi.mock('../rules', () => ({
  matchSiteRule: vi.fn(),
  buildSitePrompt: vi.fn(() => ''),
}));

import { matchSiteRule } from '../rules';

function setupHTML(html: string): Document {
  document.body.innerHTML = html;
  return document;
}






describe('extractBlocks - Text Length Filtering', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip very short text (less than 3 chars)', () => {
    setupHTML(`
      <p>Hi</p>
      <p>This is a longer paragraph with enough text content.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('longer paragraph');
  });

  it('keeps long readable paragraphs below the safety ceiling', () => {
    const longText = 'This is a long but valid paragraph. '.repeat(500);
    setupHTML(`<p>${longText}</p><p>Normal length paragraph here.</p>`);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toContain('This is a long but valid paragraph.');
    expect(blocks[0].text.length).toBeGreaterThan(16_384);
  });

  it('rejects pathological single-block text above the safety ceiling', () => {
    const longText = 'a'.repeat(100_100);
    setupHTML(`<p>${longText}</p><p>Normal length paragraph here.</p>`);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Normal length paragraph here.');
  });

  it('should accept text at boundary (exactly 3 chars)', () => {
    setupHTML(`
      <p>abc</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
  });
});






describe('findBlockNode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should find node by XPath', () => {
    setupHTML(`
      <article>
        <p id="test">Test paragraph content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);

    const node = findBlockNode(blocks[0], document);
    expect(node).toBeTruthy();
    expect(node!.textContent).toContain('Test paragraph');
  });
});


// =============================================================================
// classifyNode（ADR-001 P0）：显式区分「节点自身是噪声」与「节点子树该被剪掉」
// =============================================================================
describe('classifyNode', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('treats article with has-sidebar as structural container (not subtree-pruned)', () => {
    // 404media.co 案例：<article class="... has-sidebar"> 命中 "sidebar" 噪声 token，
    // 但它是结构性内容容器，不应被整棵剪枝——子树应继续下钻提取正文。
    document.body.innerHTML = '<article class="post tag-ai has-sidebar"><div class="post__content"><p>Body text.</p></div></article>';
    const article = document.querySelector('article')!;
    const cls = classifyNode(article);
    expect(cls.nodeNoise).toBe(true);          // 自身命中 noise token
    expect(cls.structuralContainer).toBe(true); // 是结构性内容容器
    expect(cls.subtreePrune).toBe(false);       // 因此不剪子树
  });


});

describe('extractBlocks - Google Blog Alternating Translation Issue', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should NOT skip alternating paragraphs (fix for walker.currentNode bug)', () => {
    // 模拟 Google Blog 实际页面结构：h3 标题也会被提取
    // 关键：h3 和 p 都是 DIRECT_SET 成员，都会被 grabNode 接受
    // 当 h3 被接受后，如果设置 walker.currentNode = nextSibling，会导致下一个 p 被跳过
    setupHTML(`
      <article>
        <div class="rich-text">
          <h3>Gemini 3.5</h3>
          <p><b>1.</b> We launched Gemini 3.5 Flash: the first in our latest series.</p>
          <p>2. Gemini 3.5 Flash is generally available today.</p>
          <p><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models.</p>
          <p>4. Landing in the top-right quadrant of the Artificial Analysis index.</p>
          <p><b>5.</b> Gemini 3.5 Flash is ideal for tackling long-horizon agentic tasks.</p>
          <p>6. Building on the strong multimodal foundation of Gemini 3.</p>
          <h3>Gemini Omni</h3>
          <p><b>7.</b> Gemini Omni is our new model that can create anything from any input.</p>
          <p>8. It combines Gemini's intelligence with the best of our generative media models.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    const h3Blocks = blocks.filter(b => b.tag === 'h3');
    
    // 验证 h3 也被提取
    expect(h3Blocks).toHaveLength(2);
    
    // 关键测试：所有 8 个段落都应该被提取，不应该"隔一个跳过"
    expect(pBlocks).toHaveLength(8);
    
    // 验证每个段落的编号都存在
    const extractedTexts = pBlocks.map(b => b.text);
    expect(extractedTexts.some(t => t.includes('1.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('2.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('3.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('4.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('5.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('6.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('7.'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('8.'))).toBe(true);
  });






  // Regression test: TreeWalker's currentNode must NOT be manually modified.
  //
  // In real browsers (Chrome/Firefox), after walker.nextNode() returns a node,
  // setting walker.currentNode = currentNode.nextSibling causes the NEXT call
  // to nextNode() to skip the sibling element itself and only visit its
  // children (text nodes / inline elements). Since grabNode rejects text
  // nodes, sibling paragraphs alternatingly disappear — only every other <p>
  // creates a block.
  //
  // Example (minified HTML, no whitespace text nodes between <p> siblings):
  //   <h3>Title</h3><p><b>1.</b> text</p><p>2. text</p><p><b>3.</b> text</p>
  //   → blocks for <p>2.</p> and following <p>4.</p>, etc. (odds skipped)
  //
  // NOTE: jsdom's TreeWalker handles currentNode assignment differently from
  // real browsers, so this test CANNOT reproduce the bug in jsdom. It
  // verifies the correct behaviour (all paragraphs extracted) using the
  // structure that previously triggered the issue.
  it('should extract ALL consecutive paragraphs without alternating skip (TreeWalker currentNode guard)', () => {
    // Exact minified format from blog.google — no whitespace between tags
    setupHTML(`<article><div class="rich-text"><h3>Section</h3><p><b>1.</b> First paragraph with bold lead-in has enough text length.</p><p><b>2.</b> Second paragraph also starts with bold and has enough text.</p><p><b>3.</b> Third paragraph follows the same bold pattern with enough text.</p><p><b>4.</b> Fourth paragraph here still following the bold pattern text.</p><p><b>5.</b> Fifth paragraph maintains the alternating bold start pattern.</p><p><b>6.</b> Sixth and final paragraph using the bold start pattern text.</p></div></article>`);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');

    // ALL 6 paragraphs must be extracted, not just every other one
    expect(pBlocks).toHaveLength(6);

    const texts = pBlocks.map(b => b.text);
    expect(texts.some(t => t.startsWith('1.'))).toBe(true);
    expect(texts.some(t => t.startsWith('2.'))).toBe(true);
    expect(texts.some(t => t.startsWith('3.'))).toBe(true);
    expect(texts.some(t => t.startsWith('4.'))).toBe(true);
    expect(texts.some(t => t.startsWith('5.'))).toBe(true);
    expect(texts.some(t => t.startsWith('6.'))).toBe(true);
  });

  // Simulates the actual blog.google structure with module--text wrappers and
  // multiple heading sections, verifying no paragraphs are skipped.
  it('should extract all paragraphs in multi-section Google Blog structure', () => {
    setupHTML(`
      <article>
        <div class="uni-content">
          <div class="module--text module--text__article" role="presentation">
            <div class="uni-paragraph article-paragraph">
              <div class="rich-text">
                <p class="drop-cap">This week at Google I/O 2026 we unveiled new models and tools. You can dig into our announcements for a TL;DR keep scrolling for our annual list of 100 highlights from the event.</p>
              </div>
            </div>
          </div>

          <div class="module--text module--text__article" role="presentation">
            <div class="uni-paragraph article-paragraph">
              <div class="rich-text"><h2>Create and build with our most advanced models</h2></div>
            </div>
          </div>

          <div class="module--text module--text__article" role="presentation">
            <div class="uni-paragraph article-paragraph">
              <div class="rich-text"><h3>Gemini 3.5</h3><p><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series of models combining frontier intelligence with action.</p><p><b>2.</b> Gemini 3.5 Flash is generally available today via our agent-first development platform.</p><p><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series. It outperforms Gemini 3.1 Pro on challenging coding and agentic benchmarks.</p><p><b>4.</b> Landing in the top-right quadrant of the Artificial Analysis index 3.5 Flash delivers frontier-level intelligence at exceptional speed.</p></div>
            </div>
          </div>

          <div class="module--text module--text__article" role="presentation">
            <div class="uni-paragraph article-paragraph">
              <div class="rich-text"><h3 data-block-key="w4ep3">AI Search</h3><p data-block-key="ak933"><b>17.</b> <a href="#">AI Mode</a> is our most powerful AI Search and it has surpassed more than 1 billion monthly users.</p><p data-block-key="fbafd"><b>18.</b> We are seeing incredible momentum with AI Mode queries more than doubling every quarter since launch.</p><p data-block-key="3o9av"><b>19.</b> Today we are launching the biggest upgrade to our Search box in over 25 years a new intelligent Search box.</p><p data-block-key="34i32"><b>20.</b> We are also making it even easier to continue the conversation with Search bringing AI Overviews and AI Mode into one seamless AI Search experience.</p></div>
            </div>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');

    // All 9 paragraphs across all sections must be extracted (including drop-cap intro)
    expect(pBlocks).toHaveLength(9);

    const texts = pBlocks.map(b => b.text);
    expect(texts.some(t => t.includes('1. We launched'))).toBe(true);
    expect(texts.some(t => t.includes('2. Gemini 3.5 Flash is generally'))).toBe(true);
    expect(texts.some(t => t.includes('3. Gemini 3.5 Flash delivers intelligence'))).toBe(true);
    expect(texts.some(t => t.includes('4. Landing in the top-right'))).toBe(true);
    expect(texts.some(t => t.includes('17. AI Mode is our most powerful'))).toBe(true);
    expect(texts.some(t => t.includes('18. We are seeing incredible momentum'))).toBe(true);
    expect(texts.some(t => t.includes('19. Today we are launching the biggest'))).toBe(true);
    expect(texts.some(t => t.includes('20. We are also making it even easier'))).toBe(true);
  });
});











describe('extractBlocks - Deeply nested structures', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract text from deeply nested divs in article', () => {
    setupHTML(`
      <article>
        <div class="content-wrapper">
          <div class="section">
            <div class="block">
              <div class="text-block">
                <p>Deeply nested paragraph with enough text content to be extracted properly.</p>
              </div>
            </div>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some(b => b.text.includes('Deeply nested paragraph'))).toBe(true);
  });

});



































// ========== Hidden Elements ==========


// ========== Article Container Detection ==========


// ============================================================
// 通用噪声模式回归测试。覆盖在 blockExtractor.ts 的
// SKIP_CLASS_PATTERNS 中加入的跨站通用 class 模式，用于
// 防止以后误删 pattern 导致噪声回流。每个 describe 块对应
// 一类场景。
// ============================================================







describe('extractBlocks - Bankingdive-style article regression', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // 这次回归的触发页面：bankingdive.com 的 Wells Fargo CEO 文章
  // (https://www.bankingdive.com/news/wells-fargo-ceo-scharf-ai-employment-banking-jobs/821368/)
  // 整页结构：<article>(empty class) > [.first-page-pdf > .printed-branding,
  // .article-title-wrapper > h1 + p 副标题, .article-byline, .article-wrapper >
  // .article-body(含 .hybrid-ad-wrapper / .inline-signup / .storylines-carousel),
  // .reading-list, .post-article-wrapper]
  // 之前 90 个块、26 个噪声；改后 43 个块、0 个噪声，标题/副标题稳定。
  it('bankingdive: should extract h1+subtitle+body, drop signup/read-more/post-article noise', () => {
    setupHTML(`
      <article class="">
        <div class="first-page-pdf">
          <div class="printed-branding">
            <span class="promoted-branded-copy">An article from</span>
          </div>
          <div class="article-title-wrapper">
            <h1>Wells Fargo CEO: AI effect on employment is complicated</h1>
            <p>The bank's biggest AI-related challenge is determining how the technology transforms business.</p>
          </div>
        </div>
        <div class="article-byline">
          <span>Caitlin Mullen</span>
          <span>Senior Editor</span>
        </div>
        <div class="article-wrapper">
          <div class="article-body">
            <p>Wells Fargo CEO Charlie Scharf said Wednesday the bank is examining its use of AI carefully.</p>
            <div class="hybrid-ad-wrapper">
              <p>Hybrid ad wrapper for desktop and mobile sized units.</p>
            </div>
            <p>The bank also plans to hire more people who can build AI systems internally over time.</p>
            <div class="inline-signup">
              <form>
                <label>Email:</label>
                <input type="email" />
                <button>Sign up</button>
                <p>By signing up you agree to our Terms of Use and Privacy Policy.</p>
              </form>
            </div>
            <section class="storylines-carousel-wrapper hide-small show-large">
              <div class="storylines-carousel">
                <h3>Read More in Technology</h3>
                <p>JPMorgan Chase taps AI to process checks faster than before.</p>
              </div>
            </section>
            <p>Ultimately Wells has cut about fifteen billion dollars in expenses over the past five years.</p>
          </div>
        </div>
        <div class="reading-list recommended-reading">
          <h3>Recommended Reading</h3>
          <p>California judge rules in favor of OppFi against the regulator.</p>
        </div>
        <div class="post-article-wrapper">
          <p>More from our coverage area and related investigations here.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    // 1. 标题 + 副标题必须保留（即使 h1 在 .article-body 外）
    expect(blockTexts).toContain('Wells Fargo CEO: AI effect on employment is complicated');
    expect(blockTexts).toContain("The bank's biggest AI-related challenge is determining how the technology transforms business.");

    // 2. 正文段落必须保留
    expect(blockTexts).toContain('Wells Fargo CEO Charlie Scharf said Wednesday the bank is examining its use of AI carefully.');
    expect(blockTexts).toContain('The bank also plans to hire more people who can build AI systems internally over time.');
    expect(blockTexts).toContain('Ultimately Wells has cut about fifteen billion dollars in expenses over the past five years.');

    // 3. 噪声必须被拒掉
    expect(blockTexts.some(t => t.includes('An article from'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Caitlin Mullen'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Senior Editor'))).toBe(false);
    expect(blockTexts.some(t => t.includes('desktop and mobile sized'))).toBe(false);
    expect(blockTexts.some(t => /^Email:?$/.test(t.trim()))).toBe(false);
    expect(blockTexts.some(t => t.includes('Terms of Use'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Read More in Technology'))).toBe(false);
    expect(blockTexts.some(t => t.includes('JPMorgan Chase taps AI'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Recommended Reading'))).toBe(false);
    expect(blockTexts.some(t => t.includes('California judge'))).toBe(false);
    expect(blockTexts.some(t => t.includes('related investigations'))).toBe(false);
  });
});

// =============================================================================
// Regression tests: refactor (constants/rules/walker/index split)
// =============================================================================

describe('blockExtractor - isElementHidden performance (regression: layout thrash)', () => {
  // 旧实现: 走父链 + 每次都调 getComputedStyle,
  // 大型页面 (~1000 节点 × 15 深) 触发 ~15000 次 layout。
  // 新实现: 只查 el 自身 + WeakSet memo 避免重复。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('detects visibility changes on the same DOM node across scans', () => {
    const div = document.createElement('div');
    div.textContent = 'A reusable SPA node';
    document.body.appendChild(div);

    expect(isElementHidden(div)).toBe(false);
    div.setAttribute('aria-hidden', 'true');
    expect(isElementHidden(div)).toBe(true);
    div.removeAttribute('aria-hidden');
    expect(isElementHidden(div)).toBe(false);
  });



});

describe('blockExtractor - repeated text must remain translatable', () => {
  // 同一段文字可能在摘要框、正文和预览中分别可见；每个 DOM 节点都需有独立 ID。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('assigns different block IDs to identical paragraphs across sections', () => {
    const duplicateText =
      'Companies that prioritize employee well-being consistently outperform their peers in long-term value creation across diverse market conditions.';

    setupHTML(`
      <article>
        <div class="summary-callout">
          <p>${duplicateText}</p>
        </div>
        <p>${duplicateText}</p>
        <div class="article-body">
          <p>${duplicateText}</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const matching = blocks.filter((b) => b.text === duplicateText);
    expect(matching).toHaveLength(3);
    expect(new Set(matching.map((b) => b.id)).size).toBe(3);
    expect(document.querySelectorAll('[data-fanyi-block-id]')).toHaveLength(3);
  });

});

describe('blockExtractor - SVG / MathML namespace rejection', () => {
  // SVG 命名空间下的 <text> 元素不翻译, 避免破坏图表 / 公式。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips <svg><text> elements entirely', () => {
    setupHTML(`
      <div>
        <p>Real paragraph text content here for translation.</p>
        <svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
          <text x="10" y="50">Chart label not to translate</text>
        </svg>
      </div>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);

    expect(texts).toContain('Real paragraph text content here for translation.');
    expect(texts.some((t) => t.includes('Chart label'))).toBe(false);
  });
});


describe('blockExtractor - data-fanyi-block-id tag on extracted nodes', () => {
  // collectBlocks 在 grabNode 成功后写入 dataset.fanyiBlockId,
  // findBlockNode 用这个属性找回节点, 比 XPath 健壮 (抗 DOM 变化)。
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('tags extracted nodes with data-fanyi-block-id for robust lookup', () => {
    setupHTML(`
      <article>
        <p>First paragraph text for translation testing here.</p>
        <p>Second paragraph text for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.length).toBe(2);

    for (const block of blocks) {
      const node = document.querySelector(`[data-fanyi-block-id="${block.id}"]`);
      expect(node).not.toBeNull();
      expect(node?.textContent?.trim()).toBe(block.text);
    }
  });


});

// =============================================================================
// MDN coverage regression tests
// (验证 constants.ts 补全后的行为: 新加的 <search> <dialog> <address> <hgroup>
//  <del> <ins> <kbd> <samp> <var> <data> <s> <dfn> <ruby> 元素按预期分类)
// =============================================================================

describe('blockExtractor - MDN coverage: SEMANTIC_SKIP_TAGS additions', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips entire <dialog> subtree (modal, like cookie banner)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <dialog open>
          <p>This dialog body text should not be translated.</p>
          <button>OK</button>
        </dialog>
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('dialog body text'))).toBe(false);
    expect(texts).not.toContain('OK');
  });

  it('skips entire <search> subtree (search region, semantic nav)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <search>
          <p>Search the website for related content here.</p>
        </search>
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('Search the website'))).toBe(false);
  });

});

describe('blockExtractor - MDN coverage: SKIP_SET additions (media / embed)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips <video> and its <track> subtitles', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <video controls>
          <source src="movie.mp4" type="video/mp4">
          <track src="subs_en.vtt" kind="subtitles" srclang="en">
          Your browser does not support video.
        </video>
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('Your browser does not support video'))).toBe(false);
  });


  it('skips <template> placeholder content (avoid grabbing ghost text)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <template id="tpl">
          <p>Template ghost text that should not be extracted.</p>
        </template>
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    expect(texts.some((t) => t.includes('Template ghost text'))).toBe(false);
  });
});

describe('blockExtractor - MDN coverage: <hgroup> allows inner headings', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('skips <hgroup> wrapper but still extracts inner <h1>', () => {
    setupHTML(`
      <article>
        <hgroup>
          <h1>Article Main Title Text For Translation</h1>
          <h2>Subtitle of the article goes here today</h2>
        </hgroup>
        <p>Real article body paragraph text for translation testing.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Article Main Title Text For Translation');
    expect(texts).toContain('Subtitle of the article goes here today');
    expect(texts).toContain('Real article body paragraph text for translation testing.');
  });
});


describe('blockExtractor - MDN coverage: code preservation (regression)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not translate <kbd>, <samp>, <var>, <code> standalone', () => {
    // 验证: 单纯 <kbd>Ctrl+C</kbd> 不应被独立抓出 (会作为内联不被接受)
    // 但在 paragraph 中, 整段仍被 paragraph 抓
    setupHTML(`
      <article>
        <p>Press <kbd>Ctrl+C</kbd> to copy text in this application.</p>
        <p>The variable <var>count</var> stores the total number of items.</p>
        <p>Output: <samp>File not found error in current directory.</samp></p>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.length).toBe(3);
    for (const block of blocks) {
      // 不应单独抓 kbd/var/samp, 应作为整段 paragraph
      expect(block.tag).toBe('p');
    }
  });

  it('preserves <code> and <pre> as invisible to translation', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <p>Use the function <code>getUserById(id)</code> to fetch the user data.</p>
        <pre>function foo() { return 42; }</pre>
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    // pre 整段不应被抓
    expect(texts.some((t) => t.includes('function foo()'))).toBe(false);
    // code 也不应独立被抓 (它在 <p> 内, 整段 <p> 抓)
    const codeParagraph = blocks.find((b) => b.text.includes('getUserById'));
    expect(codeParagraph).toBeDefined();
    expect(codeParagraph!.text).toContain('getUserById(id)');
  });
});

describe('blockExtractor - MDN coverage: data tables not translated (regression)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('does not translate content inside <table> (Wikipedia-style data tables)', () => {
    setupHTML(`
      <article>
        <p>Real article paragraph text for translation testing.</p>
        <table>
          <thead>
            <tr><th>Year</th><th>GDP</th></tr>
          </thead>
          <tbody>
            <tr><td>2024</td><td>$25.4T</td></tr>
            <tr><td>2023</td><td>$23.0T</td></tr>
          </tbody>
        </table>
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    expect(texts).toContain('Real article paragraph text for translation testing.');
    // 表格内容应被拒绝
    expect(texts.some((t) => t.includes('Year') && t.includes('GDP'))).toBe(false);
    expect(texts.some((t) => t.includes('2024') || t.includes('25.4T'))).toBe(false);
  });
});

describe('blockExtractor - MDN coverage: form text is translatable (regression)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('translates <label> and <legend> text (visible UI labels)', () => {
    setupHTML(`
      <form>
        <fieldset>
          <legend>Personal information section heading text</legend>
          <label>Email address field label</label>
          <input type="email">
        </fieldset>
      </form>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    expect(texts.some((t) => t.includes('Personal information'))).toBe(true);
    expect(texts.some((t) => t.includes('Email address field label'))).toBe(true);
  });

});

// =============================================================================
// collapseSpacedText —— 合并 CSS letter-spacing 渲染的分散单词
// hero section / CTA 按钮 / 品牌名常用 letter-spacing 装饰，textContent 抽取后
// 变成 "S t a r t" 这种单字符+空格序列，翻译后会变成 "开 始" 视觉错乱。
// =============================================================================

describe('collapseSpacedText', () => {
  it('merges spaced single characters into a word (Start)', () => {
    expect(collapseSpacedText('S t a r t')).toBe('Start');
  });


  it('leaves normal multi-char words unchanged', () => {
    expect(collapseSpacedText('hello world')).toBe('hello world');
    expect(collapseSpacedText('Hello world this is a test')).toBe(
      'Hello world this is a test',
    );
  });



  it('does NOT merge CJK characters (Chinese should stay spaced)', () => {
    // 中文字符本身是有意义的单字，letter-spacing 渲染的中文应保留原样
    expect(collapseSpacedText('开 始 使 用')).toBe('开 始 使 用');
    expect(collapseSpacedText('学 习 更 多')).toBe('学 习 更 多');
  });





});


// =============================================================================
// 噪声三层策略 (webclaw 借鉴)
// =============================================================================
//
// 1. 精确 token 匹配: matchesSkipClass 已实现 (精确 + '-'/'_' 前后缀边界)
// 2. ≤6 字符 word-boundary 正则: LOW_PRIORITY_PATTERNS / OVERLAY_PATTERNS 用 \b
// 3. 5000 字符安全阀: 噪声类元素 textContent > 5000 时不视为噪声

describe('blockExtractor - noise safe valve (5000 chars)', () => {
  // shouldSkipByClass 安全阀：class 命中噪声模式但 textContent > 5000 时不跳过，
  // 防误杀长 FAQ / 长隐私政策正文。
  // 回归 case: #cookiesModal 50k 字符的 cookie policy 被整棵跳过。

  function makeEl(classAttr: string, text: string): HTMLElement {
    const el = document.createElement('div');
    el.className = classAttr;
    el.textContent = text;
    return el;
  }

  it('shouldSkipByClass returns true for noise class with short text', () => {
    // 'cookie-banner' 在 SKIP_CLASS_PATTERNS 里，短文本应被跳过
    const el = makeEl('cookie-banner', 'Accept cookies for the best experience.');
    expect(shouldSkipByClass(el)).toBe(true);
  });

  it('shouldSkipByClass returns false for noise class with >5000 chars text (safe valve)', () => {
    // 长文本应触发安全阀，不被跳过
    const longText = 'This is a long FAQ paragraph. '.repeat(200); // ~5800 chars
    const el = makeEl('cookie-banner', longText);
    expect(shouldSkipByClass(el)).toBe(false);
  });


  it('extractBlocks extracts long FAQ inside element with noise class', () => {
    // 集成测试：长 FAQ 应被抽取，不被噪声 class 整棵剪枝。
    // 构造 60 个段落，每段 < MAX_TEXT_LENGTH(3072)，总计 > 5000 字符触发安全阀。
    // 用 'footer-wrap'（在 SKIP_CLASS_PATTERNS 但不在 OVERLAY_PATTERNS）作为噪声类，
    // 单独验证 shouldSkipByClass 安全阀，避免与 isOverlayElement 逻辑耦合。
    const faqParagraphs = Array.from(
      { length: 60 },
      (_, i) => `<p>FAQ paragraph ${i}: This is a long FAQ paragraph that should be translated and not skipped by noise filter.</p>`,
    ).join('');
    setupHTML(`
      <article class="footer-wrap">
        <h1>FAQ Article</h1>
        ${faqParagraphs}
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map((b) => b.text);
    // 至少 5 个 FAQ 段落必须被抽取（证明安全阀让 walker 继续进入子树）
    const faqTexts = texts.filter((t) => t.includes('long FAQ paragraph that should be translated'));
    expect(faqTexts.length).toBeGreaterThanOrEqual(5);
  });
});

describe('blockExtractor - short pattern word boundary (\\b)', () => {
  // LOW_PRIORITY_PATTERNS / OVERLAY_PATTERNS 用 regex 在原始 className 上匹配，
  // 短模式 (≤6 字符) 若无 \b 会误伤超集词：
  //   - "share" 误伤 "shareholder-content"
  //   - "social" 误伤 "socialism-study"
  //   - "promo" 误伤 "promontory-view"
  //   - "dialog" 误伤 "dialogue-script"
  //   - "cookie" 误伤 "cookies-link" (实际是噪声，但用于验证 \b 边界)
  // 加 \b 后，"share" 只匹配 \bshare\b，不匹配 "shareholder"。

  it('isLowPriorityElement does NOT match "shareholder-content" (\\bshare\\b)', () => {
    // 'shareholder-content' 含子串 'share'，但 \bshare\b 不应匹配
    const el = document.createElement('div');
    el.className = 'shareholder-content';
    expect(isLowPriorityElement(el)).toBe(false);
  });


  it('isLowPriorityElement does NOT match "socialism-study" (\\bsocial\\b)', () => {
    const el = document.createElement('div');
    el.className = 'socialism-study';
    expect(isLowPriorityElement(el)).toBe(false);
  });


  it('isLowPriorityElement does NOT match "promontory-view" (\\bpromo\\b)', () => {
    const el = document.createElement('div');
    el.className = 'promontory-view';
    expect(isLowPriorityElement(el)).toBe(false);
  });

  it('isOverlayElement does NOT match "dialogue-script" (\\bdialog\\b)', () => {
    // 'dialogue-script' 含子串 'dialog'，但 \bdialog\b 不应匹配
    // 注意：isOverlayElement 在 article/main 内会直接返回 false，所以这里用顶层 div
    const el = document.createElement('div');
    el.className = 'dialogue-script';
    document.body.appendChild(el);
    expect(isOverlayElement(el)).toBe(false);
  });





  // 站点（如 sigarch.org 的 FeedBlitz 订阅表单）可能在运行时被 JS
  // 把 form action 改成 http://，触发 Mixed Content 警告。这类表单
  // 通常在侧边栏，不属于正文，应当被识别为 overlay 隐藏掉。
  it('isOverlayElement matches form with insecure http:// action', () => {
    const form = document.createElement('form');
    form.setAttribute('action', 'http://app.feedblitz.com/f/f.Fbz?AddNewUserDirect');
    form.setAttribute('method', 'POST');
    document.body.appendChild(form);
    expect(isOverlayElement(form)).toBe(true);
    form.remove();
  });

  it('isOverlayElement does NOT match form with secure https:// action', () => {
    const form = document.createElement('form');
    form.setAttribute('action', 'https://app.feedblitz.com/f/f.Fbz?AddNewUserDirect');
    form.setAttribute('method', 'POST');
    document.body.appendChild(form);
    expect(isOverlayElement(form)).toBe(false);
    form.remove();
  });

  it('isOverlayElement does NOT match form with no action', () => {
    const form = document.createElement('form');
    form.setAttribute('method', 'POST');
    document.body.appendChild(form);
    expect(isOverlayElement(form)).toBe(false);
    form.remove();
  });

  it('isOverlayElement does NOT match form with relative action', () => {
    const form = document.createElement('form');
    form.setAttribute('action', '/submit');
    document.body.appendChild(form);
    expect(isOverlayElement(form)).toBe(false);
    form.remove();
  });
});

describe('extractBlocks - paragraphs declared via data-as="p" (Mintlify docs)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // 回归: docs.langchain.com (Mintlify) 把 Markdown 段落渲染成
  //   <span data-as="p">…</span>
  // 而不是 <p>，外层套 <div class="mdx-content">，正文根是 <main>（没有 <article>）。
  // 症状: 标题 (h1/h2 在 DIRECT_SET) 被翻译，正文段落全部漏掉。
  const MINTLIFY_PAGE = `
    <main class="px-5">
      <div class="grow w-full">
        <div class="mdx-content">
          <h2 id="interrupt-decision-types"><span>Interrupt decision types</span></h2>
          <span data-as="p">The middleware defines four built-in ways a human can respond to an interrupt:</span>
          <span data-as="p">Use <code>reject</code> when the human is denying the requested action.</span>
        </div>
      </div>
    </main>
  `;

  it('extracts paragraphs under a plain <main> with no <article> ancestor', () => {
    setupHTML(MINTLIFY_PAGE);
    const texts = extractBlocks(document).map((b) => b.text);

    expect(texts).toContain(
      'The middleware defines four built-in ways a human can respond to an interrupt:',
    );
    expect(texts).toContain('Use reject when the human is denying the requested action.');
    // 标题本来就抓得到, 回归点是它不再是"唯一"被翻译的内容。
    expect(texts).toContain('Interrupt decision types');
  });

  it('does not fragment inline children of a data-as="p" paragraph', () => {
    setupHTML(MINTLIFY_PAGE);
    const blocks = extractBlocks(document);

    // 段落内的 <code> 不应独立成块 (SKIP_SET 拒绝), 段落应整段抓取。
    expect(blocks.some((b) => b.tag === 'code')).toBe(false);
    expect(blocks.filter((b) => b.tag === 'span')).toHaveLength(2);
  });

  it('treats a nested inline span as part of the paragraph, not a separate block', () => {
    setupHTML(`
      <main>
        <span data-as="p">Outer paragraph text that is long enough to translate.
          <span class="highlight">inner emphasis span</span>
        </span>
      </main>
    `);

    const blocks = extractBlocks(document);
    // 只有段落本身; 嵌套 <span> 不能变成第二个块 (否则句子会碎片化)。
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('span');
  });

  it('only treats data-as="p" as a paragraph declaration, not other data-as values', () => {
    const asP = document.createElement('span');
    asP.setAttribute('data-as', 'p');
    const asCode = document.createElement('span');
    asCode.setAttribute('data-as', 'code');
    const bare = document.createElement('span');

    expect(isParagraphLikeElement(asP)).toBe(true);
    expect(isParagraphLikeElement(asCode)).toBe(false);
    expect(isParagraphLikeElement(bare)).toBe(false);
  });

  it('round-trips extraction → apply without destroying the paragraph inline link', () => {
    setupHTML(`
      <main>
        <div class="mdx-content">
          <span data-as="p">The <a href="/oss/python/langchain/middleware">middleware</a> defines
            four built-in ways a human can respond to an interrupt.</span>
        </div>
      </main>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);

    const para = document.querySelector('span[data-as="p"]') as HTMLElement;
    // 提取阶段必须给段落打上 block id —— 服务端就是靠它回填译文的。
    expect(para.dataset.fanyiBlockId).toBe(blocks[0].id);

    const link = para.querySelector('a');
    expect(link).not.toBeNull();

    applyBlockTranslation(para, '中间件定义了四种内置的人类响应方式。');

    // 内链必须存活在 .fanyi-original 里，而不是被 textContent 覆盖掉。
    expect(para.querySelector('.fanyi-original a')).toBe(link);
    expect(para.querySelector('.fanyi-translation')?.textContent).toBe(
      '中间件定义了四种内置的人类响应方式。',
    );
    expect(para.classList.contains('fanyi-translated')).toBe(true);
  });
});



// =============================================================================
// 首尾零宽 / 不可见字符
// =============================================================================

describe('normalizeBlockText - invisible edge characters', () => {
  it('strips leading/trailing ZWSP and whitespace in one pass', () => {
    expect(normalizeBlockText('\u200bInterrupt decision types')).toBe(
      'Interrupt decision types',
    );
    expect(normalizeBlockText('  \u200b Title \u200b  ')).toBe('Title');
    expect(normalizeBlockText('\n\t\u200b\u200bFoo\u200d\u200b\n')).toBe('Foo');
    // 全空白 / 全零宽 → 空串
    expect(normalizeBlockText('\u200b\u200b')).toBe('');
    expect(normalizeBlockText('   ')).toBe('');
  });


  it('does NOT strip mid-text ZWNJ / ZWJ (they are semantic)', () => {
    // 波斯语 ZWNJ：می‌خواهم 是一个词，ZWNJ 不能删
    const persian = 'می\u200cخواهم';
    // emoji ZWJ 序列：👨‍👩‍👧 是一个字素簇，ZWJ 不能删
    const family = '👨\u200d👩\u200d👧';
    expect(normalizeBlockText(persian)).toBe(persian);
    expect(normalizeBlockText(family)).toBe(family);
    expect(normalizeBlockText(` ${persian} and ${family} `)).toBe(
      `${persian} and ${family}`,
    );
  });
});

describe('extractBlocks - Mintlify heading anchors leak a ZWSP (regression)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /**
   * Mintlify 的每个标题里都塞了一个 hover 才显示的锚点链接
   * （`<a class="...opacity-0...">`），而它内部**只有一个 U+200B 占位**
   * 加一个图标 div。于是整个标题的 textContent 以 ZWSP 开头：
   * `"\u200bInterrupt decision types"`。
   *
   * `trim()` 去不掉它（U+200B 是 Cf 格式字符，不是 WhiteSpace），
   * 之前会原样进译文请求。真实页面 14 处。
   */
  const MINTLIFY_HEADING = `
    <main>
      <h2 id="interrupt-decision-types" class="flex whitespace-pre-wrap group font-semibold"><div class="absolute" tabindex="-1"><a href="#interrupt-decision-types" class="-ml-10 flex items-center opacity-0 group/link" aria-label="Navigate to header">\u200b<div class="size-6 rounded-md"><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"></path></svg></div></a>Interrupt decision types</h2>
      <span data-as="p">Human-in-the-loop middleware lets you approve or reject tool calls before they run.</span>
    </main>
  `;

  it('extracts the heading without the ZWSP', () => {
    setupHTML(MINTLIFY_HEADING);
    const blocks = extractBlocks(document);

    const heading = blocks.find((b) => b.tag === 'h2');
    expect(heading).toBeDefined();
    expect(heading!.text).toBe('Interrupt decision types');
    // 反向断言：任何块都不该带首尾零宽字符
    for (const b of blocks) {
      expect(b.text).toBe(normalizeBlockText(b.text));
      expect(b.text.startsWith('\u200b')).toBe(false);
    }
  });

  it('cleans the heading text carried in context.headingPath', () => {
    setupHTML(MINTLIFY_HEADING);
    const blocks = extractBlocks(document);

    const para = blocks.find((b) => b.tag === 'span');
    expect(para).toBeDefined();
    // headingPath 也是送给模型的上下文，同样不能带 ZWSP
    expect(para!.context.headingPath).toContain('Interrupt decision types');
    for (const h of para!.context.headingPath) {
      expect(h.startsWith('\u200b')).toBe(false);
    }
  });
});
