import { describe, it, expect, beforeEach } from 'vitest';
import { extractBlocks, findBlockNode, buildNodeMap } from './blockExtractor';

function setupHTML(html: string): Document {
  document.body.innerHTML = html;
  return document;
}

describe('extractBlocks - Basic Extraction', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract simple paragraphs', () => {
    setupHTML(`
      <div>
        <p>Hello world this is a test paragraph.</p>
        <p>Another paragraph with enough text.</p>
      </div>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].text).toBe('Hello world this is a test paragraph.');
    expect(blocks[0].tag).toBe('p');
    expect(blocks[1].text).toBe('Another paragraph with enough text.');
  });

  it('should extract headings', () => {
    setupHTML(`
      <article>
        <h1>Main Title of the Article</h1>
        <h2>Subsection Heading Here</h2>
        <h3>Minor Section Title</h3>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(3);
    expect(blocks[0].tag).toBe('h1');
    expect(blocks[1].tag).toBe('h2');
    expect(blocks[2].tag).toBe('h3');
  });

  it('should extract list items', () => {
    setupHTML(`
      <ul>
        <li>First list item with enough text content.</li>
        <li>Second list item also has sufficient length.</li>
      </ul>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].tag).toBe('li');
    expect(blocks[1].tag).toBe('li');
  });

  it('should extract blockquotes', () => {
    setupHTML(`
      <blockquote>This is a quoted passage with sufficient text length for extraction.</blockquote>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('blockquote');
  });

  it('should extract definition descriptions', () => {
    setupHTML(`
      <dl>
        <dt>Term</dt>
        <dd>This is the definition of the term with enough text.</dd>
      </dl>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('dd');
  });
});

describe('extractBlocks - Inline Elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should keep inline elements inside parent block', () => {
    setupHTML(`
      <p><span>Text inside span</span> and more text outside.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
    expect(blocks[0].text).toBe('Text inside span and more text outside.');
  });

  it('should keep links inside parent paragraph', () => {
    setupHTML(`
      <p>See <a href="/page">Understanding the Difference Between Embedding Layers</a> for details.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
    expect(blocks[0].text).toContain('Understanding the Difference Between Embedding Layers');
  });

  it('should handle mixed inline elements in paragraph', () => {
    setupHTML(`
      <p>
        <span>First span text.</span>
        <a href="/link">Link text here.</a>
        <strong>Bold text too.</strong>
      </p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
    expect(blocks[0].text.replace(/\s+/g, ' ')).toBe('First span text. Link text here. Bold text too.');
  });

  it('should handle emphasis and strong tags', () => {
    setupHTML(`
      <p>This is <em>emphasized</em> and <strong>strong</strong> text in a paragraph.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('This is emphasized and strong text in a paragraph.');
  });

  it('should not extract inline elements as standalone blocks', () => {
    setupHTML(`
      <div>
        <span>Standalone span with enough text content.</span>
        <strong>Standalone strong with enough text content.</strong>
        <em>Standalone em with enough text content.</em>
      </div>
    `);

    const blocks = extractBlocks(document);
    const inlineTags = blocks.filter(b => ['span', 'strong', 'em'].includes(b.tag));
    expect(inlineTags).toHaveLength(0);
  });

  it('should handle nested inline elements', () => {
    setupHTML(`
      <p><span><strong><em>Nested inline content with enough text.</em></strong></span></p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
  });
});

describe('extractBlocks - Skip Elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip script tags', () => {
    setupHTML(`
      <script>var x = "This script content should not be extracted";</script>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Normal paragraph content here.');
  });

  it('should skip style tags', () => {
    setupHTML(`
      <style>.class { color: red; }</style>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
  });

  it('should skip code and pre tags', () => {
    setupHTML(`
      <code>function hello() { return "world"; }</code>
      <pre>Some preformatted code block content here.</pre>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('p');
  });

  it('should skip form elements', () => {
    setupHTML(`
      <input type="text" value="Input value" />
      <textarea>Textarea content here.</textarea>
      <button>Click me button text.</button>
      <select><option>Option text here.</option></select>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
  });

  it('should skip iframe tags', () => {
    setupHTML(`
      <iframe src="https://example.com"></iframe>
      <p>Normal paragraph content here.</p>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
  });

  it('should skip header and footer tags', () => {
    setupHTML(`
      <header><p>Header paragraph content here.</p></header>
      <article><p>Article paragraph content here.</p></article>
      <footer><p>Footer paragraph content here.</p></footer>
    `);

    const blocks = extractBlocks(document);
    const footerBlocks = blocks.filter(b =>
      b.text.includes('Footer') || b.text.includes('Header')
    );
    expect(footerBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
  });

  it('should skip aside and nav tags', () => {
    setupHTML(`
      <nav><p>Navigation link text here.</p></nav>
      <aside><p>Sidebar paragraph content here.</p></aside>
      <main><p>Main article paragraph content here.</p></main>
    `);

    const blocks = extractBlocks(document);
    const sidebarBlocks = blocks.filter(b =>
      b.text.includes('Navigation') || b.text.includes('Sidebar')
    );
    expect(sidebarBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
  });
});

describe('extractBlocks - Class-based Skipping', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip sidebar elements outside article', () => {
    setupHTML(`
      <div class="sidebar"><p>Sidebar paragraph content here.</p></div>
      <main><p>Main article paragraph content here.</p></main>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Main article paragraph content here.');
  });

  it('should skip footer elements', () => {
    setupHTML(`
      <div class="footer-wrap"><p>Footer paragraph content here.</p></div>
      <article><p>Article paragraph content here.</p></article>
    `);

    const blocks = extractBlocks(document);
    const footerBlocks = blocks.filter(b => b.text.includes('Footer'));
    expect(footerBlocks).toHaveLength(0);
  });

  it('should skip ad containers', () => {
    setupHTML(`
      <div class="ad-container"><p>Ad paragraph content here.</p></div>
      <article><p>Article paragraph content here.</p></article>
    `);

    const blocks = extractBlocks(document);
    const adBlocks = blocks.filter(b => b.text.includes('Ad'));
    expect(adBlocks).toHaveLength(0);
  });

  it('should skip widget areas', () => {
    setupHTML(`
      <div class="subscribe-widget"><p>Subscribe widget content here.</p></div>
      <article><p>Article paragraph content here.</p></article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
  });

  it('should skip cookie banners', () => {
    setupHTML(`
      <div class="cookie-consent"><p>We use cookies to improve your experience.</p></div>
      <article><p>Article paragraph content here.</p></article>
    `);

    const blocks = extractBlocks(document);
    const cookieBlocks = blocks.filter(b => b.text.includes('cookies'));
    expect(cookieBlocks).toHaveLength(0);
  });

  it('should NOT skip elements inside article context', () => {
    setupHTML(`
      <article>
        <div class="sidebar"><p>Sidebar inside article context.</p></div>
        <div class="footer-wrap"><p>Footer inside article context.</p></div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(2);
  });

  it('should skip notranslate class', () => {
    setupHTML(`
      <p class="notranslate">This should not be translated at all.</p>
      <p>This should be translated normally.</p>
    `);

    const blocks = extractBlocks(document);
    const noTranslateBlocks = blocks.filter(b => b.text.includes('notranslate'));
    expect(noTranslateBlocks).toHaveLength(0);
  });
});

describe('extractBlocks - Complex Structures', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle headings with anchor links (Substack style)', () => {
    setupHTML(`
      <article>
        <h1 class="header-anchor-post">
          1. Reusing KV Tensors Across Layers
          <div class="header-anchor-parent">
            <div class="header-anchor offset-top"></div>
            <button type="button" aria-label="Link">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"></svg>
            </button>
          </div>
        </h1>
        <p>Paragraph after heading.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const headings = blocks.filter(b => b.tag.startsWith('h'));
    expect(headings).toHaveLength(1);
    expect(headings[0].text).toContain('Reusing KV Tensors');
  });

  it('should handle nested divs with text content', () => {
    setupHTML(`
      <article>
        <div class="content-wrapper">
          <div class="inner">
            <p>Deeply nested paragraph content here.</p>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Deeply nested paragraph content here.');
  });

  it('should handle figure with figcaption', () => {
    setupHTML(`
      <figure>
        <img src="/image.png" alt="Test image" />
        <figcaption>This is a caption describing the figure content.</figcaption>
      </figure>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tag).toBe('figcaption');
  });

  it('should handle mixed content with lists and paragraphs', () => {
    setupHTML(`
      <article>
        <p>Introduction paragraph with enough text content.</p>
        <ul>
          <li>First item in the list with content.</li>
          <li>Second item in the list with content.</li>
        </ul>
        <p>Conclusion paragraph with enough text content.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(4);
    expect(blocks[0].tag).toBe('p');
    expect(blocks[1].tag).toBe('li');
    expect(blocks[2].tag).toBe('li');
    expect(blocks[3].tag).toBe('p');
  });

  it('should handle definition lists', () => {
    setupHTML(`
      <dl>
        <dt>First Term</dt>
        <dd>Definition of first term with enough text content.</dd>
        <dt>Second Term</dt>
        <dd>Definition of second term with enough text content.</dd>
      </dl>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(2);
    expect(blocks[0].tag).toBe('dd');
    expect(blocks[1].tag).toBe('dd');
  });
});

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

  it('should skip very long text (3072+ chars)', () => {
    const longText = 'a'.repeat(3100);
    setupHTML(`
      <p>${longText}</p>
      <p>Normal length paragraph here.</p>
    `);

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

describe('extractBlocks - SPA Content (Twitter/X)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract span text inside article container', () => {
    setupHTML(`
      <div>
        <article role="article">
          <div>
            <div>
              <span>This is a tweet with enough text content to be extracted.</span>
            </div>
          </div>
        </article>
      </div>
    `);

    const blocks = extractBlocks(document);
    const tweetBlocks = blocks.filter(b => b.text.includes('tweet'));
    expect(tweetBlocks).toHaveLength(1);
    expect(tweetBlocks[0].tag).toBe('span');
  });

  it('should extract multiple spans inside article', () => {
    setupHTML(`
      <article>
        <div>
          <span>First part of the tweet content.</span>
          <span>Second part of the tweet content.</span>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('should NOT extract span outside article context', () => {
    setupHTML(`
      <div class="sidebar">
        <span>This is sidebar content that should not be extracted.</span>
      </div>
      <article>
        <div>
          <span>This is article content that should be extracted.</span>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const sidebarBlocks = blocks.filter(b => b.text.includes('sidebar'));
    expect(sidebarBlocks).toHaveLength(0);
    const articleBlocks = blocks.filter(b => b.text.includes('article content'));
    expect(articleBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should extract div with text inside article', () => {
    setupHTML(`
      <article>
        <div>
          <div>
            This is a div with enough text content inside an article container.
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const divBlocks = blocks.filter(b => b.tag === 'div' && b.text.includes('div with enough text'));
    expect(divBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle Twitter-like nested structure', () => {
    setupHTML(`
      <div>
        <div>
          <main>
            <div>
              <article role="article">
                <div>
                  <div>
                    <span>Full tweet text with enough characters to be extracted properly.</span>
                  </div>
                </div>
              </article>
            </div>
          </main>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document);
    const tweetBlocks = blocks.filter(b => b.text.includes('Full tweet text'));
    expect(tweetBlocks).toHaveLength(1);
  });
});

describe('extractBlocks - Content Editable', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip content editable elements', () => {
    setupHTML(`
      <p contenteditable="true">Editable paragraph content here.</p>
      <p>Non-editable paragraph content here.</p>
    `);

    const blocks = extractBlocks(document);
    const editableBlocks = blocks.filter(b => b.text.includes('Editable'));
    expect(editableBlocks).toHaveLength(0);
  });
});

describe('extractBlocks - Real-world Scenarios', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle blog post layout', () => {
    setupHTML(`
      <body>
        <nav class="main-menu">
          <p>Home About Contact</p>
        </nav>
        <div class="sidebar">
          <p>Related articles and widgets here.</p>
        </div>
        <article>
          <h1>Blog Post Title Here</h1>
          <p>First paragraph of the blog post content.</p>
          <h2>Section One</h2>
          <p>Content of section one with enough text length.</p>
          <blockquote>A relevant quote from an expert in the field.</blockquote>
          <h2>Section Two</h2>
          <p>Content of section two with enough text length.</p>
          <ul>
            <li>Key point number one of the article.</li>
            <li>Key point number two of the article.</li>
          </ul>
        </article>
        <footer class="post-footer">
          <p>Copyright and footer links here.</p>
        </footer>
      </body>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    // Should NOT include nav/sidebar/footer content
    expect(blockTexts.some(t => t.includes('Home About'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Related articles'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Copyright'))).toBe(false);

    // Should include article content
    expect(blockTexts.some(t => t.includes('Blog Post Title'))).toBe(true);
    expect(blockTexts.some(t => t.includes('First paragraph'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Section One'))).toBe(true);
    expect(blockTexts.some(t => t.includes('relevant quote'))).toBe(true);
  });

  it('should handle Substack-like article', () => {
    setupHTML(`
      <div id="main">
        <div class="main-menu"><p>Subscribe Sign in</p></div>
        <article>
          <h1>Recent Developments in LLM Architectures</h1>
          <div class="overlay-zrMCxn">
            <div>
              <p>As reasoning models and agent workflows keep more tokens around.</p>
              <p>The main examples I want to look at are KV sharing and per-layer embeddings.</p>
            </div>
          </div>
        </article>
        <div class="subscribe-widget"><p>Subscribe now for more content.</p></div>
        <div class="footer-wrap"><p>Copyright 2026</p></div>
      </div>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    // Should include article content
    expect(blockTexts.some(t => t.includes('reasoning models'))).toBe(true);
    expect(blockTexts.some(t => t.includes('main examples'))).toBe(true);

    // Should NOT include menu, widget, footer
    expect(blockTexts.some(t => t.includes('Subscribe Sign in'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Subscribe now'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Copyright'))).toBe(false);
  });

  it('should handle news article with complex layout', () => {
    setupHTML(`
      <body>
        <header class="site-header"><p>News Site Header</p></header>
        <nav class="navigation-menu"><p>Categories and links here.</p></nav>
        <main>
          <article>
            <h1>Breaking News Headline Here</h1>
            <p>Lead paragraph with the most important information.</p>
            <figure>
              <img src="/photo.jpg" alt="News photo" />
              <figcaption>Photo caption describing the image content.</figcaption>
            </figure>
            <p>Second paragraph with additional details and context.</p>
            <blockquote>Quote from a relevant source or expert.</blockquote>
            <p>Third paragraph with more background information.</p>
          </article>
          <aside class="sidebar">
            <p>Related stories and sidebar content here.</p>
          </aside>
        </main>
        <footer class="site-footer"><p>Footer copyright information.</p></footer>
      </body>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    // Should include article content
    expect(blockTexts.some(t => t.includes('Breaking News'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Lead paragraph'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Photo caption'))).toBe(true);
    expect(blockTexts.some(t => t.includes('Quote from'))).toBe(true);

    // Should NOT include header, nav, sidebar, footer
    expect(blockTexts.some(t => t.includes('News Site Header'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Categories'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Related stories'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Footer copyright'))).toBe(false);
  });

  it('should handle Substack article from sample2.html structure', () => {
    setupHTML(`
      <div id="entry">
        <div id="main" class="main typography use-theme-bg">
          <div class="single-post-container">
            <div class="container">
              <div class="single-post">
                <div class="pencraft pc-display-contents pc-reset pubTheme-yiXxQA">
                  <article class="typography newsletter-post post">
                    <div class="post-header">
                      <h3 class="subtitle subtitle-HEEcLo">From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs</h3>
                    </div>
                    <div class="available-content">
                      <div class="body markup">
                        <p>After a short family break, I am excited to be back and catching up on a busy few weeks of open-weight LLM releases. The thing that stood out to me is how much newer architectures are focused on long-context efficiency.</p>
                        <p>Here's another paragraph with enough text to be extracted.</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document);
    console.log('Extracted blocks:', blocks.map(b => ({ tag: b.tag, text: b.text })));
    
    expect(blocks.length).toBeGreaterThanOrEqual(3);
    
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts.some(t => t.includes('From Gemma 4 to DeepSeek V4'))).toBe(true);
    expect(blockTexts.some(t => t.includes('After a short family break'))).toBe(true);
    expect(blockTexts.some(t => t.includes('another paragraph'))).toBe(true);
  });
});

describe('extractBlocks - XPath Generation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should generate valid XPath for each block', () => {
    setupHTML(`
      <article>
        <p>First paragraph.</p>
        <p>Second paragraph.</p>
        <div><p>Third paragraph in div.</p></div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(3);

    for (const block of blocks) {
      expect(block.xpath).toBeTruthy();
      expect(block.xpath.startsWith('/')).toBe(true);
    }
  });

  it('should generate unique XPath for each block', () => {
    setupHTML(`
      <article>
        <p>First paragraph content here.</p>
        <p>Second paragraph content here.</p>
        <p>Third paragraph content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const xpaths = blocks.map(b => b.xpath);
    const uniqueXpaths = new Set(xpaths);
    expect(uniqueXpaths.size).toBe(blocks.length);
  });
});

describe('extractBlocks - Heading Context', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should capture heading path in context', () => {
    setupHTML(`
      <article>
        <h1>Main Article Title</h1>
        <h2>Section Title</h2>
        <p>Paragraph under section with enough text.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const paragraph = blocks.find(b => b.tag === 'p');
    expect(paragraph).toBeTruthy();
    expect(paragraph!.context).toBeTruthy();
    expect(paragraph!.context!.headingPath).toContain('Main Article Title');
    expect(paragraph!.context!.headingPath).toContain('Section Title');
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

describe('extractBlocks - Paragraph with Inline Elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract paragraph with inline b and a tags as single block', () => {
    setupHTML(`
      <article>
        <p><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series of models combining frontier intelligence with action.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    // 应该只提取一个段落块，而不是多个块
    expect(pBlocks).toHaveLength(1);
    expect(pBlocks[0].text).toBe('1. We launched Gemini 3.5 Flash: the first in our latest series of models combining frontier intelligence with action.');
  });

  it('should not extract inline elements separately from parent paragraph', () => {
    setupHTML(`
      <article>
        <p><b>Bold text</b> and <a href="#">linked text</a> together in one paragraph.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    
    // 不应该有单独的 <b> 或 <a> 块
    const inlineBlocks = blocks.filter(b => ['b', 'strong', 'a', 'span'].includes(b.tag));
    expect(inlineBlocks).toHaveLength(0);
    
    // 应该只有一个段落块
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(1);
    expect(pBlocks[0].text).toBe('Bold text and linked text together in one paragraph.');
  });

  it('should handle complex inline structure in paragraph', () => {
    setupHTML(`
      <article>
        <p><span><strong>Important:</strong></span> This is <em>emphasized</em> text with <a href="#">a link</a> inside.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    expect(pBlocks).toHaveLength(1);
    expect(pBlocks[0].text).toBe('Important: This is emphasized text with a link inside.');
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

  it('should extract all paragraphs including those with inline b and a tags', () => {
    setupHTML(`
      <article>
        <div class="rich-text">
          <h3 data-block-key="o63sw">Gemini 3.5</h3>
          <p data-block-key="f5hj2"><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series of models combining frontier intelligence with action.</p>
          <p data-block-key="com71">2. Gemini 3.5 Flash is generally available today via our agent-first development platform.</p>
          <p data-block-key="ar1dc"><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series.</p>
          <p data-block-key="2ugbm">4. Landing in the top-right quadrant of the Artificial Analysis index, 3.5 Flash delivers frontier-level intelligence.</p>
          <p data-block-key="61kma"><b>5.</b> Gemini 3.5 Flash is ideal for tackling long-horizon agentic tasks, with <a href="#">new features</a>.</p>
          <p data-block-key="4u52g">6. Building on the strong multimodal foundation of Gemini 3, 3.5 Flash generates richer, more interactive web UIs.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    // 应该提取所有 6 个段落，不管是否包含 <b> 或 <a> 标签
    expect(pBlocks).toHaveLength(6);
    
    // 验证每个段落的文本都被正确提取
    const extractedTexts = pBlocks.map(b => b.text);
    
    expect(extractedTexts.some(t => t.includes('1. We launched'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('2. Gemini 3.5 Flash is generally'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('3. Gemini 3.5 Flash delivers intelligence'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('4. Landing in the top-right'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('5. Gemini 3.5 Flash is ideal'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('6. Building on the strong'))).toBe(true);
  });

  it('should extract paragraphs with mixed inline elements', () => {
    setupHTML(`
      <article>
        <div class="rich-text">
          <p data-block-key="test1"><b>Bold</b> and <a href="#">link</a> in paragraph.</p>
          <p data-block-key="test2">Plain text paragraph.</p>
          <p data-block-key="test3"><strong>Strong</strong> text with <em>emphasis</em> inside.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    expect(pBlocks).toHaveLength(3);
    
    // 验证包含内联元素的段落也被正确提取
    const test1Block = pBlocks.find(b => b.text.includes('Bold'));
    const test2Block = pBlocks.find(b => b.text.includes('Plain text'));
    const test3Block = pBlocks.find(b => b.text.includes('Strong'));
    
    expect(test1Block).toBeTruthy();
    expect(test2Block).toBeTruthy();
    expect(test3Block).toBeTruthy();
  });

  it('should extract all paragraphs in rich-text div inside article', () => {
    setupHTML(`
      <article>
        <div class="rich-text">
          <h3>Gemini 3.5</h3>
          <p><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series of models.</p>
          <p><b>2.</b> Gemini 3.5 Flash is generally available today via our agent-first development platform.</p>
          <p><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series. It outperforms Gemini 3.1 Pro on challenging coding and agentic benchmarks like Terminal-Bench 2.1 (76.2%), GDPval-AA (1656 Elo) and MCP Atlas (83.6%).</p>
          <p><b>4.</b> Landing in the top-right quadrant of the Artificial Analysis index, 3.5 Flash delivers frontier-level intelligence.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    // 应该提取所有 4 个段落
    expect(pBlocks).toHaveLength(4);
    
    // 检查第 3 个段落是否被提取
    const thirdParagraph = pBlocks.find(b => b.text.includes('Gemini 3.5 Flash delivers intelligence'));
    expect(thirdParagraph).toBeTruthy();
    expect(thirdParagraph!.text).toContain('Terminal-Bench 2.1');
    expect(thirdParagraph!.text).toContain('GDPval-AA');
    expect(thirdParagraph!.text).toContain('MCP Atlas');
  });

  it('should extract paragraphs with data-block-key attribute', () => {
    setupHTML(`
      <article>
        <div class="rich-text">
          <h3 data-block-key="o63sw">Gemini 3.5</h3>
          <p data-block-key="f5hj2"><b>1.</b> We launched <a href="#">Gemini 3.5 Flash</a>: the first in our latest series.</p>
          <p data-block-key="com71"><b>2.</b> Gemini 3.5 Flash is generally available today.</p>
          <p data-block-key="ar1dc"><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series.</p>
          <p data-block-key="2ugbm"><b>4.</b> Landing in the top-right quadrant of the Artificial Analysis index.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    expect(pBlocks).toHaveLength(4);
    
    // 检查所有段落的文本都被提取
    const extractedTexts = pBlocks.map(b => b.text);
    expect(extractedTexts.some(t => t.includes('1. We launched'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('2. Gemini 3.5 Flash is generally'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('3. Gemini 3.5 Flash delivers intelligence'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('4. Landing in the top-right'))).toBe(true);
  });

  it('should handle uni-paragraph wrapper like Google Blog', () => {
    setupHTML(`
      <article>
        <div class="uni-paragraph article-paragraph" data-component="uni-article-paragraph">
          <div class="rich-text">
            <h3 data-block-key="o63sw">Gemini 3.5</h3>
            <p data-block-key="f5hj2"><b>1.</b> First paragraph content with enough text length here.</p>
            <p data-block-key="ar1dc"><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series. It outperforms Gemini 3.1 Pro on challenging coding and agentic benchmarks.</p>
            <p data-block-key="2ugbm"><b>4.</b> Fourth paragraph content with enough text length here.</p>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    
    expect(pBlocks).toHaveLength(3);
    
    const geminiParagraph = pBlocks.find(b => b.text.includes('Gemini 3.5 Flash delivers intelligence'));
    expect(geminiParagraph).toBeTruthy();
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

describe('extractBlocks - Google Blog Alternating Translation Issue (Real Structure)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract all paragraphs from sample.html exact structure', () => {
    // 完全模拟 sample.html 中 Gemini 3.5 部分的实际 DOM 结构
    setupHTML(`
      <article>
        <div class="uni-paragraph article-paragraph" data-component="uni-article-paragraph" data-component-initialized="true">
          <div class="rich-text">
            <h3 data-block-key="o63sw">Gemini 3.5</h3>
            <p data-block-key="f5hj2"><b>1.</b> We launched <a href="https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-3-5/">Gemini 3.5 Flash</a>: the first in our latest series of models combining frontier intelligence with action.</p>
            <p data-block-key="com71"><b>2.</b> Gemini 3.5 Flash is generally available today via our agent-first development platform <a href="https://antigravity.google/" rel="noopener" target="_blank">Google Antigravity</a> the Gemini API in <a href="https://aistudio.google.com/" rel="noopener" target="_blank">Google AI Studio</a> and <a href="https://developer.android.com/studio" rel="noopener" target="_blank">Android Studio</a>.</p>
            <p data-block-key="ar1dc"><b>3.</b> Gemini 3.5 Flash delivers intelligence that rivals large flagship models at speeds you expect from the Flash series. It outperforms Gemini 3.1 Pro on challenging coding and agentic benchmarks like Terminal-Bench 2.1 (76.2%), GDPval-AA (1656 Elo) and MCP Atlas (83.6%).</p>
            <p data-block-key="2ugbm"><b>4.</b> Landing in the top-right quadrant of the Artificial Analysis index, 3.5 Flash delivers frontier-level intelligence at exceptional speed — proving you no longer have to trade quality for latency.</p>
            <p data-block-key="61kma"><b>5.</b> Gemini 3.5 Flash is ideal for tackling long-horizon agentic tasks. What used to take a developer days or an auditor weeks, 3.5 Flash can now help complete in a fraction of the time, often at less than half the cost of other frontier models. It rapidly plans, builds and iterates to solve real-world problems, whether it’s developing new applications, maintaining codebases or helping to prepare financial documents.</p>
            <p data-block-key="4u52g"><b>6.</b> Building on the strong multimodal foundation of Gemini 3, 3.5 Flash generates richer, more interactive web UIs and graphics.</p>
            <p data-block-key="2mko"><b>7.</b> We’re also hard at work on Gemini 3.5 Pro. It’s already being used internally and we look forward to rolling it out next month.</p>
            <h3 data-block-key="7tmnq">Gemini Omni</h3>
            <p data-block-key="bo6h"><b>8.</b> <a href="https://blog.google/innovation-and-ai/models-and-research/gemini-models/gemini-omni/">Gemini Omni</a> is our new model that can create anything from any input — starting with video. It combines Gemini's intelligence with the best of our generative media models for a new level of world understanding, multimodality and editing. We’re starting with video outputs now, but over time, Gemini Omni will be able to generate any output from any input.</p>
            <p data-block-key="6qdvi"><b>9.</b> <a href="https://deepmind.google/models/gemini-omni/" rel="noopener" target="_blank">Gemini Omni</a> combines an intuitive understanding of physics with Gemini's knowledge of history, science and culture, bridging the gap from photorealism to meaningful storytelling. It has an improved understanding of forces like gravity, kinetic energy and fluid dynamics, allowing you to create more realistic scenes.</p>
            <p data-block-key="1kof1"><b>10.</b> Videos created with Omni include our imperceptible <a href="https://blog.google/innovation-and-ai/products/identifying-ai-generated-media-online/">SynthID digital watermark</a>. You can easily verify content through the Gemini app, Gemini in Chrome and Search.</p>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    const h3Blocks = blocks.filter(b => b.tag === 'h3');
    
    // 验证 h3 标题被提取
    expect(h3Blocks).toHaveLength(2);
    expect(h3Blocks.some(b => b.text === 'Gemini 3.5')).toBe(true);
    expect(h3Blocks.some(b => b.text === 'Gemini Omni')).toBe(true);
    
    // 关键测试：所有 10 个段落都应该被提取，不应该"隔一个跳过"
    expect(pBlocks).toHaveLength(10);
    
    // 验证每个段落的编号都存在（包括之前未被翻译的第 3 段）
    const extractedTexts = pBlocks.map(b => b.text);
    expect(extractedTexts.some(t => t.includes('1. We launched'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('2. Gemini 3.5 Flash is generally'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('3. Gemini 3.5 Flash delivers intelligence'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('4. Landing in the top-right'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('5. Gemini 3.5 Flash is ideal'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('6. Building on the strong'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('7. We’re also hard at work'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('8. Gemini Omni'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('9. Gemini Omni'))).toBe(true);
    expect(extractedTexts.some(t => t.includes('10. Videos created with Omni'))).toBe(true);
    
    // 特别验证之前未被翻译的第 3 段内容
    const thirdParagraph = pBlocks.find(b => b.text.includes('Terminal-Bench 2.1'));
    expect(thirdParagraph).toBeTruthy();
    expect(thirdParagraph!.text).toContain('76.2%');
    expect(thirdParagraph!.text).toContain('GDPval-AA');
    expect(thirdParagraph!.text).toContain('1656 Elo');
    expect(thirdParagraph!.text).toContain('MCP Atlas');
    expect(thirdParagraph!.text).toContain('83.6%');
  });
});

describe('extractBlocks - Substack Article Structure (sample2.html)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract subtitle h3 and all paragraphs from Substack article structure', () => {
    // 模拟 sample2.html（Substack 文章）的 DOM 结构，包含 post-header、author info、available-content、body.markup 等
    const html = `
      <div id="entry">
        <div id="main" class="main typography use-theme-bg">
          <div aria-label="Post" role="main" class="single-post-container">
            <div class="container">
              <div class="single-post">
                <div class="pencraft pc-display-contents pc-reset pubTheme-yiXxQA">
                  <article class="typography newsletter-post post">
                    <div role="region" aria-label="Post header" class="post-header">
                      <h1 dir="auto" class="post-title published title-X77sOw">Recent Developments in LLM Architectures: KV Sharing, mHC, and Compressed Attention</h1>
                      <h3 dir="auto" class="subtitle subtitle-HEEcLo">From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs</h3>
                      <div aria-label="Post UFI" role="region" class="pencraft pc-display-flex pc-flexDirection-column pc-paddingBottom-16 pc-reset">
                        <div class="pencraft pc-display-flex pc-paddingTop-16 pc-paddingBottom-16 pc-justifyContent-space-between pc-alignItems-center pc-reset">
                          <div class="pencraft pc-display-flex pc-gap-12 pc-alignItems-center pc-reset byline-wrapper">
                            <div class="pencraft pc-display-flex pc-reset">
                              <div class="pencraft pc-display-flex pc-flexDirection-row pc-gap-8 pc-alignItems-center pc-justifyContent-flex-start pc-reset">
                                <div class="pencraft pc-display-flex pc-flexDirection-row pc-alignItems-center pc-justifyContent-flex-start pc-reset">
                                  <div class="pencraft pc-display-flex pc-width-36 pc-height-36 pc-justifyContent-center pc-alignItems-center pc-position-relative pc-reset">Avatar</div>
                                </div>
                              </div>
                            </div>
                            <div class="pencraft pc-display-flex pc-flexDirection-column pc-reset">
                              <div class="pencraft pc-reset">Sebastian Raschka, PhD</div>
                              <div class="pencraft pc-display-flex pc-gap-4 pc-reset">
                                <div class="pencraft pc-reset">May 16, 2026</div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                    <div class="available-content">
                      <div dir="auto" class="body markup">
                        <p>After a short family break, I am excited to be back and catching up on a busy few weeks of open-weight LLM releases. The thing that stood out to me is how much newer architectures are focused on long-context efficiency.</p>
                        <p>As reasoning models and agent workflows keep more tokens around (for longer), KV-cache size, memory traffic, and attention cost quickly become the main constraints, and LLM developers are adding a growing number of architecture tricks to reduce those costs.</p>
                        <p>The main examples I want to look at are KV sharing and per-layer embeddings in Gemma 4, layer-wise attention budgeting in Laguna XS.2, compressed convolutional attention in ZAYA1-8B, and mHC plus compressed attention in DeepSeek V4.</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    setupHTML(html);
    const blocks = extractBlocks(document);

    const h3Blocks = blocks.filter(b => b.tag === 'h3');
    const pBlocks = blocks.filter(b => b.tag === 'p');

    // 验证 subtitle h3 被提取
    expect(h3Blocks.some(b => b.text.includes('From Gemma 4 to DeepSeek V4'))).toBe(true);

    // 验证所有段落被提取
    expect(pBlocks.some(b => b.text.includes('After a short family break'))).toBe(true);
    expect(pBlocks.some(b => b.text.includes('As reasoning models'))).toBe(true);
    expect(pBlocks.some(b => b.text.includes('KV sharing and per-layer embeddings'))).toBe(true);

    // 总数：1 个 title h1 + 1 个 subtitle h3 + 3 个段落 + 3 个 byline divs（Avatar/name/date）
    expect(blocks.filter(b => b.tag === 'h1')).toHaveLength(1);
    expect(h3Blocks.filter(b => b.text.includes('From Gemma 4'))).toHaveLength(1);
    expect(pBlocks).toHaveLength(3);
  });

  it('should correctly resolve XPath for subtitle h3 (no index collision)', () => {
    // 验证 findBlockNode 能正确匹配 subtitle h3，
    // 即使 document 中还有其他 h3 元素（例如 navbar 中的 h3）
    const html = `
      <div id="entry">
        <div id="main" class="main typography use-theme-bg">
          <div aria-label="Post" role="main" class="single-post-container">
            <div class="container">
              <div class="single-post">
                <div class="pencraft pc-display-contents pc-reset pubTheme-yiXxQA">
                  <article class="typography newsletter-post post">
                    <div role="region" aria-label="Post header" class="post-header">
                      <h3 dir="auto" class="subtitle subtitle-HEEcLo">From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs</h3>
                    </div>
                    <div class="available-content">
                      <div dir="auto" class="body markup">
                        <p>After a short family break, I am excited to be back and catching up on a busy few weeks of open-weight LLM releases.</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    setupHTML(html);

    const blocks = extractBlocks(document);
    const subtitleBlock = blocks.find(b => b.tag === 'h3');
    expect(subtitleBlock).toBeTruthy();

    // buildNodeMap 验证 XPath 能正确匹配
    const nodeMap = buildNodeMap(blocks, document);
    const foundNode = nodeMap.get(subtitleBlock!.id);
    expect(foundNode).toBeTruthy();
    expect((foundNode as Element)?.tagName?.toLowerCase()).toBe('h3');
  });

  it('should resolve subtitle h3 XPath when distractor h3 elements exist outside article (navbar)', () => {
    // 模拟真实 Substack 页面：navbar 中也有 h3 元素，
    // 需要验证 subtitle h3 的 XPath 索引不受干扰
    const html = `
      <div id="entry">
        <div class="main-menu">
          <div style="position: fixed;">
            <div class="pencraft pc-display-flex pc-reset">
              <div class="logoContainer-p12gJb">
                <h3 class="sidebarHeading">Navigation</h3>
              </div>
              <div class="titleContainer-DJYq5v">
                <h3 class="sidebarHeading">Sections</h3>
              </div>
            </div>
          </div>
        </div>
        <div id="main" class="main typography use-theme-bg">
          <div aria-label="Post" role="main" class="single-post-container">
            <div class="container">
              <div class="single-post">
                <div class="pencraft pc-display-contents pc-reset">
                  <article class="typography newsletter-post post">
                    <div role="region" aria-label="Post header" class="post-header">
                      <h1 class="post-title">Recent Developments in LLM Architectures</h1>
                      <h3 class="subtitle subtitle-HEEcLo">From Gemma 4 to DeepSeek V4, How New Open-Weight LLMs Are Reducing Long-Context Costs</h3>
                    </div>
                    <div class="available-content">
                      <div dir="auto" class="body markup">
                        <p>After a short family break, I am excited to be back and catching up on a busy few weeks of open-weight LLM releases.</p>
                      </div>
                    </div>
                  </article>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`;

    setupHTML(html);

    const blocks = extractBlocks(document);
    const subtitleBlock = blocks.find(b => b.tag === 'h3' && b.text.includes('From Gemma 4'));
    expect(subtitleBlock).toBeTruthy();

    const nodeMap = buildNodeMap(blocks, document);
    const foundNode = nodeMap.get(subtitleBlock!.id);

    // 即使有 2 个导航 h3 在前面, subtitle h3 也必须被正确匹配
    expect(foundNode).toBeTruthy();
    expect((foundNode as Element)?.tagName?.toLowerCase()).toBe('h3');
    expect((foundNode as Element)?.textContent).toContain('From Gemma 4');
  });
});
