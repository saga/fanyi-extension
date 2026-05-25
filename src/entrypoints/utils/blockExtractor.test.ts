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

  it('should skip sidebar/footer classes even inside article context', () => {
    setupHTML(`
      <article>
        <div class="sidebar"><p>Sidebar inside article context.</p></div>
        <div class="footer-wrap"><p>Footer inside article context.</p></div>
        <p>Main article content that should be extracted.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const sidebarBlocks = blocks.filter(b => b.text.includes('Sidebar'));
    expect(sidebarBlocks).toHaveLength(0);
    const footerBlocks = blocks.filter(b => b.text.includes('Footer'));
    expect(footerBlocks).toHaveLength(0);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain('Main article content');
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

  it('should not duplicate text when blockquote contains a single p', () => {
    setupHTML(`
      <article>
        <blockquote>
          <p>Do not trust analysis written in the issue. Independently verify behavior and derive your own analysis from the code and execution path.</p>
        </blockquote>
        <p>That is worse than no diagnosis.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const texts = blocks.map(b => b.text);

    const targetText = 'Do not trust analysis written in the issue.';
    const matches = texts.filter(t => t.includes(targetText));
    expect(matches.length).toBe(1);
  });

  it('should handle blockquote with multiple p children', () => {
    setupHTML(`
      <article>
        <blockquote>
          <p>First paragraph inside blockquote.</p>
          <p>Second paragraph inside blockquote.</p>
          <p>Third paragraph inside blockquote.</p>
        </blockquote>
        <p>Content after blockquote.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).toContain('First paragraph inside blockquote.');
    expect(blockTexts).toContain('Second paragraph inside blockquote.');
    expect(blockTexts).toContain('Third paragraph inside blockquote.');
    expect(blockTexts).toContain('Content after blockquote.');

    const blockquoteExtractions = blocks.filter(b => b.tag === 'blockquote');
    expect(blockquoteExtractions.length).toBe(0);
  });

  it('should still extract blockquote when it has no block-level children', () => {
    setupHTML(`
      <article>
        <blockquote>
          A simple blockquote without any nested block elements.
        </blockquote>
        <p>Content after.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).toContain('A simple blockquote without any nested block elements.');
    expect(blockTexts).toContain('Content after.');
  });
});

describe('extractBlocks - MathML/SVG namespace filtering', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip MathML elements inside paragraphs', () => {
    setupHTML(`
      <article>
        <p>The speedup <math xmlns="http://www.w3.org/1998/Math/MathML"><mrow><mn>1</mn></mrow></math> of a program is limited.</p>
        <p>Another paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const mathBlocks = blocks.filter(b => b.tag === 'math');
    expect(mathBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should skip MathML elements with nested mrow/mn', () => {
    setupHTML(`
      <article>
        <p>Amdahl's law formula: <math xmlns="http://www.w3.org/1998/Math/MathML">
          <mrow>
            <mi>S</mi>
            <mo>=</mo>
            <mfrac>
              <mn>1</mn>
              <mrow>
                <mo>(</mo>
                <mn>1</mn>
                <mo>-</mo>
                <mi>p</mi>
                <mo>)</mo>
                <mo>+</mo>
                <mfrac><mi>p</mi><mi>n</mi></mfrac>
              </mrow>
            </mfrac>
          </mrow>
        </math></p>
        <p>This paragraph is about Amdahl's law and has enough text.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const mathBlocks = blocks.filter(b => b.tag === 'math');
    expect(mathBlocks).toHaveLength(0);

    const mathChildBlocks = blocks.filter(b =>
      ['mrow', 'mi', 'mo', 'mn', 'mfrac'].includes(b.tag)
    );
    expect(mathChildBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should skip SVG elements', () => {
    setupHTML(`
      <article>
        <p>Below is an icon: <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24">
          <circle cx="12" cy="12" r="10" />
        </svg></p>
        <p>Paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const svgBlocks = blocks.filter(b => b.tag === 'svg');
    expect(svgBlocks).toHaveLength(0);

    const svgChildBlocks = blocks.filter(b => ['circle', 'path', 'rect'].includes(b.tag));
    expect(svgChildBlocks).toHaveLength(0);
  });

  it('should handle Wikipedia-style MathML in article content', () => {
    setupHTML(`
      <article>
        <p>In computer architecture, <b>Amdahl's law</b> is a formula that gives the theoretical speedup in latency of the execution of a task at fixed workload that can be expected of a system whose resources are improved.</p>
        <p>The speedup can be formulated as:</p>
        <p><math xmlns="http://www.w3.org/1998/Math/MathML">
          <mrow>
            <mi>S</mi>
            <mo>=</mo>
            <mfrac>
              <mn>1</mn>
              <mrow>
                <mo>(</mo>
                <mn>1</mn>
                <mo>-</mo>
                <mi>p</mi>
                <mo>)</mo>
                <mo>+</mo>
                <mfrac><mi>p</mi><mi>n</mi></mfrac>
              </mrow>
            </mfrac>
          </mrow>
        </math></p>
        <p>Where <i>S</i> is the theoretical speedup, <i>p</i> is the proportion of the program that can be made parallel, and <i>n</i> is the number of processors.</p>
      </article>
    `);

    const blocks = extractBlocks(document);

    const mathBlocks = blocks.filter(b => b.tag === 'math');
    expect(mathBlocks).toHaveLength(0);

    const mathChildBlocks = blocks.filter(b =>
      ['mrow', 'mi', 'mo', 'mn', 'mfrac'].includes(b.tag)
    );
    expect(mathChildBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(3);

    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts.some(t => t.includes("Amdahl's law"))).toBe(true);
    expect(blockTexts.some(t => t.includes('theoretical speedup'))).toBe(true);
  });

  it('should skip inline SVG inside paragraph but still extract the paragraph text', () => {
    setupHTML(`
      <article>
        <p>Click the <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><path d="M0 0h16v16H0z"/></svg> icon to save.</p>
        <p>Another paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const svgBlocks = blocks.filter(b => b.tag === 'svg');
    expect(svgBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBe(2);
  });
});

describe('extractBlocks - Nested lists', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract nested ul list items only', () => {
    setupHTML(`
      <article>
        <ul>
          <li>First level item with enough text content to be extracted.</li>
          <li>Second level item parent with nested list.</li>
          <ul>
            <li>Nested first item with enough text content here.</li>
            <li>Nested second item with enough text content here.</li>
          </ul>
          <li>Third level item with enough text content.</li>
        </ul>
      </article>
    `);

    const blocks = extractBlocks(document);
    const liBlocks = blocks.filter(b => b.tag === 'li');
    expect(liBlocks.length).toBeGreaterThanOrEqual(4);
  });

  it('should extract nested ol list items', () => {
    setupHTML(`
      <article>
        <ol>
          <li>Step one with comprehensive description text here.</li>
          <li>Step two with detailed explanation of the process.</li>
          <ol>
            <li>Sub-step one with additional detailed text content.</li>
            <li>Sub-step two with more explanatory information.</li>
          </ol>
          <li>Step three with final concluding description text.</li>
        </ol>
      </article>
    `);

    const blocks = extractBlocks(document);
    const liBlocks = blocks.filter(b => b.tag === 'li');
    expect(liBlocks.length).toBeGreaterThanOrEqual(4);
  });
});

describe('extractBlocks - Tables', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract table cells as text blocks', () => {
    setupHTML(`
      <article>
        <p>Below is a comparison table showing the results.</p>
        <table>
          <thead>
            <tr><th>Model Name</th><th>Accuracy Score</th></tr>
          </thead>
          <tbody>
            <tr><td>Model A</td><td>95.2%</td></tr>
            <tr><td>Model B</td><td>93.7%</td></tr>
          </tbody>
        </table>
        <p>As shown above, Model A performs best overall.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(2);
    expect(pBlocks[0].text).toBe('Below is a comparison table showing the results.');
    expect(pBlocks[1].text).toBe('As shown above, Model A performs best overall.');
  });

  it('should skip table caption and cell elements', () => {
    setupHTML(`
      <article>
        <table>
          <caption>Table One: Performance Comparison of Different Models</caption>
          <tr><th>Model</th><th>Score</th></tr>
          <tr><td>GPT-5</td><td>98.7</td></tr>
        </table>
        <p>Regular paragraph after table with enough content.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const captionBlocks = blocks.filter(b => b.tag === 'caption');
    expect(captionBlocks).toHaveLength(0);
    const cellBlocks = blocks.filter(b => b.tag === 'td' || b.tag === 'th');
    expect(cellBlocks).toHaveLength(0);
    expect(blocks.some(b => b.tag === 'p')).toBe(true);
  });
});

describe('extractBlocks - Details/Summary elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should not extract summary as standalone block', () => {
    setupHTML(`
      <article>
        <details>
          <summary>Click to expand this section with detailed information</summary>
          <p>Hidden content that becomes visible when expanded here.</p>
        </details>
        <p>Regular paragraph outside details element.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extractBlocks - Reference/citation patterns', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip sup reference links (Wikipedia style)', () => {
    setupHTML(`
      <article>
        <p>Amdahl's law is a formula in computer architecture<sup id="cite_ref-1"><a href="#cite_note-1">[1]</a></sup> that is widely cited.</p>
        <p>Another paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const supBlocks = blocks.filter(b => b.tag === 'sup');
    expect(supBlocks).toHaveLength(0);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBe(2);
    expect(pBlocks.some(b => b.text.includes("Amdahl's law"))).toBe(true);
  });

  it('should skip ordered list in references section when outside article', () => {
    setupHTML(`
      <article>
        <p>Main article content with enough text here.</p>
      </article>
      <div class="footnote">
        <ol>
          <li>Reference one citation details here.</li>
          <li>Reference two citation details here.</li>
        </ol>
      </div>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);
    expect(blockTexts.some(t => t.includes('Reference one'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Reference two'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Main article'))).toBe(true);
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

  it('should handle multiple sections with same nesting depth', () => {
    setupHTML(`
      <article>
        <section>
          <div><div><p>First section paragraph with enough text.</p></div></div>
        </section>
        <section>
          <div><div><p>Second section paragraph with enough text.</p></div></div>
        </section>
        <section>
          <div><div><p>Third section paragraph with enough text.</p></div></div>
        </section>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(3);
  });
});

describe('extractBlocks - Mixed real-world article', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle a complete article with mixed content types', () => {
    setupHTML(`
      <article>
        <h1>The Future of Artificial Intelligence Research</h1>
        <p class="byline">By John Smith, Published on May 20, 2026</p>
        <p>Artificial intelligence has transformed from a niche academic discipline into a fundamental technology driving innovation across every sector of the global economy.</p>
        <h2>Recent Breakthroughs in Model Architecture</h2>
        <p>The past year has witnessed remarkable advances in neural network design, particularly in the domain of transformer architectures and their successors.</p>
        <blockquote>
          <p>"The pace of innovation in AI has exceeded even our most optimistic projections from five years ago." — Dr. Sarah Chen, MIT</p>
        </blockquote>
        <p>These architectural innovations have led to substantial improvements in both training efficiency and inference performance.</p>
        <h2>Key Research Areas</h2>
        <ul>
          <li>Mixture of Experts architectures are enabling more efficient model scaling without proportional compute increases.</li>
          <li>Retrieval Augmented Generation continues to bridge the gap between parametric knowledge and external information sources.</li>
          <li>Multimodal models that seamlessly integrate text, vision, and audio understanding are becoming the new standard.</li>
        </ul>
        <h2>Conclusion</h2>
        <p>The trajectory of AI research suggests we are still in the early stages of understanding what these systems can achieve.</p>
      </article>
    `);

    const blocks = extractBlocks(document);

    const h1Blocks = blocks.filter(b => b.tag === 'h1');
    const h2Blocks = blocks.filter(b => b.tag === 'h2');
    const pBlocks = blocks.filter(b => b.tag === 'p');
    const liBlocks = blocks.filter(b => b.tag === 'li');

    expect(h1Blocks.length).toBe(1);
    expect(h2Blocks.length).toBe(3);
    expect(liBlocks.length).toBe(3);
    expect(pBlocks.length).toBeGreaterThanOrEqual(4);

    const texts = blocks.map(b => b.text);
    expect(texts.some(t => t.includes('Future of Artificial Intelligence'))).toBe(true);
    expect(texts.some(t => t.includes('Mixture of Experts'))).toBe(true);
    expect(texts.some(t => t.includes("Sarah Chen"))).toBe(true);
  });

  it('should handle article with figures interspersed', () => {
    setupHTML(`
      <article>
        <h1>Visual Guide to Neural Networks</h1>
        <p>Understanding neural network architectures requires both theoretical knowledge and visual intuition.</p>
        <figure>
          <img src="/network.png" alt="Neural network diagram" />
          <figcaption>Figure 1: A standard feedforward neural network with three hidden layers showing connections.</figcaption>
        </figure>
        <p>The diagram above illustrates the basic structure of a multi-layer perceptron, where each node represents a neuron.</p>
        <figure>
          <img src="/cnn.png" alt="CNN diagram" />
          <figcaption>Figure 2: Convolutional neural network architecture showing feature extraction layers.</figcaption>
        </figure>
        <p>Convolutional networks add specialized layers that excel at detecting spatial patterns in grid-like data.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const figcaptionBlocks = blocks.filter(b => b.tag === 'figcaption');
    expect(figcaptionBlocks).toHaveLength(2);
    expect(figcaptionBlocks.some(b => b.text.includes('Figure 1'))).toBe(true);
    expect(figcaptionBlocks.some(b => b.text.includes('Figure 2'))).toBe(true);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBe(3);
  });
});

describe('extractBlocks - Whitespace and empty elements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip elements with only whitespace text', () => {
    setupHTML(`
      <article>
        <p>     </p>
        <p>   \n  \t  </p>
        <p>Valid paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(1);
    expect(pBlocks[0].text).toBe('Valid paragraph with enough text content here.');
  });

  it('should skip empty elements', () => {
    setupHTML(`
      <article>
        <p></p>
        <div></div>
        <span></span>
        <p>Actual paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.length).toBe(1);
    expect(blocks[0].tag).toBe('p');
  });

  it('should skip elements with only invisible children', () => {
    setupHTML(`
      <article>
        <p><br><br></p>
        <p><img src="/icon.png" alt="" /></p>
        <p>Valid paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(1);
  });
});

describe('extractBlocks - Malformed or unusual HTML', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle text directly inside article without wrapping tags', () => {
    setupHTML(`
      <article>
        This is direct text content inside an article element without any wrapping paragraph tag.
        <p>This is a proper paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
    expect(blocks.some(b => b.tag === 'p')).toBe(true);
  });

  it('should handle div with only text as a block', () => {
    setupHTML(`
      <article>
        <div>This div contains direct text content that should be extracted as a translatable block since it has enough characters.</div>
        <div><span>This span inside a div has enough text content to be extracted.</span></div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should handle mixed inline and block siblings', () => {
    setupHTML(`
      <article>
        <p>First paragraph with enough text content here.</p>
        <span>Inline span with enough text to be a standalone block here.</span>
        <p>Second paragraph with enough text content here.</p>
        <strong>Strong text that is also valid as standalone block content.</strong>
      </article>
    `);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(2);

    const spanBlocks = blocks.filter(b => b.tag === 'span');
    expect(spanBlocks.length).toBeGreaterThanOrEqual(1);

    const strongBlocks = blocks.filter(b => b.tag === 'strong');
    expect(strongBlocks.length).toBeGreaterThanOrEqual(1);
  });
});

describe('extractBlocks - Hidden and non-visible content', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip content inside display:none containers', () => {
    setupHTML(`
      <article>
        <p>Visible paragraph content that should be extracted here.</p>
        <div style="display: none;">
          <p>Hidden paragraph content that should be skipped here.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.some(b => b.text.includes('Visible paragraph'))).toBe(true);
    expect(blocks.some(b => b.text.includes('Hidden paragraph'))).toBe(false);
  });

  it('should skip aria-hidden content', () => {
    setupHTML(`
      <article>
        <p>Normal visible paragraph with enough text content here.</p>
        <div aria-hidden="true">
          <p>This content is marked as aria-hidden and should be skipped.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.some(b => b.text.includes('Normal visible'))).toBe(true);
    expect(blocks.some(b => b.text.includes('aria-hidden'))).toBe(false);
  });

  it('should skip visibility:hidden content', () => {
    setupHTML(`
      <article>
        <p>Visible paragraph with enough text content here.</p>
        <div style="visibility: hidden;">
          <p>Hidden by visibility paragraph with enough text.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.some(b => b.text.includes('Hidden by visibility'))).toBe(false);
  });

  it('should skip content with hidden attribute', () => {
    setupHTML(`
      <article>
        <p>Visible paragraph with enough text content here.</p>
        <div hidden>
          <p>Hidden attribute paragraph with enough text content.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.some(b => b.text.includes('Hidden attribute'))).toBe(false);
  });

  it('should skip content in deeply nested hidden ancestors', () => {
    setupHTML(`
      <article>
        <p>Visible paragraph with enough text content here.</p>
        <div class="wrapper">
          <div class="inner" style="display: none;">
            <div><div><p>Deeply nested hidden paragraph content here.</p></div></div>
          </div>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks.some(b => b.text.includes('Deeply nested hidden'))).toBe(false);
  });
});

describe('extractBlocks - Cookie Consent and Privacy', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip OneTrust SDK cookie policy container', () => {
    setupHTML(`
      <article>
        <p>Article paragraph content that should be extracted here.</p>
      </article>
      <div id="ot-sdk-cookie-policy">
        <div class="ot-cookie-policy-content">
          <ul>
            <li>taboola_session_id</li>
            <li>Duration</li>
            <li>DescriptionThis cookie is owned by trc.taboola.com</li>
            <li>Cookie_ga_*</li>
            <li>Duration1 year 1 month 4 days</li>
            <li>DescriptionGoogle Analytics sets this cookie</li>
          </ul>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('taboola'))).toBe(false);
    expect(blockTexts.some(t => t.includes('DescriptionGoogle Analytics'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph content that should be extracted here.');
  });

  it('should skip OneTrust preference center (ot-pc-*)', () => {
    setupHTML(`
      <article>
        <p>Article content that should be translated here.</p>
      </article>
      <div class="ot-pc-content">
        <div class="ot-pc-header">
          <h3>Cookie Settings</h3>
        </div>
        <div class="ot-pc-desc">This website uses cookies to ensure you get the best experience.</div>
        <div class="ot-pc-footer">
          <button>Allow All</button>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Cookie Settings'))).toBe(false);
    expect(blockTexts.some(t => t.includes('best experience'))).toBe(false);
  });

  it('should skip cookie banner with cookie-banner class', () => {
    setupHTML(`
      <div class="cookie-banner">
        <p>We use cookies to improve your experience on our site.</p>
        <button>Accept All Cookies</button>
      </div>
      <article>
        <p>Article content that should be translated.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('use cookies'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated.');
  });

  it('should skip GDPR consent modal regions', () => {
    setupHTML(`
      <div class="consent-modal">
        <h2>Your Privacy Choices</h2>
        <p>Select your cookie preferences below.</p>
        <div class="consent-container">
          <label class="ot-category">Functional Cookies</label>
          <p>These cookies are necessary for the website to function.</p>
        </div>
      </div>
      <article>
        <p>Real article text that must be extracted for translation here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Privacy Choices'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Functional Cookies'))).toBe(false);
    expect(blockTexts).toContain('Real article text that must be extracted for translation here.');
  });

  it('should skip cookie policy and privacy notice containers', () => {
    setupHTML(`
      <div class="privacy-policy">
        <h2>Privacy Policy</h2>
        <p>Last updated: January 2026</p>
        <div class="cookie-policy">
          <h3>Cookie Declaration</h3>
          <table class="cookie-table">
            <tr><th>Cookie</th><th>Duration</th><th>Description</th></tr>
            <tr><td>_ga</td><td>2 years</td><td>Google Analytics tracking cookie</td></tr>
          </table>
        </div>
      </div>
      <article>
        <p>Actual article paragraph that should be extracted for translation.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Privacy Policy'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie Declaration'))).toBe(false);
    expect(blockTexts.some(t => t.includes('_ga'))).toBe(false);
    expect(blockTexts).toContain('Actual article paragraph that should be extracted for translation.');
  });
});

describe('extractBlocks - Cookie Consent libraries (cc-*)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip Cookie Consent (cc-window, cc-banner, cc-overlay)', () => {
    setupHTML(`
      <div class="cc-window">
        <div class="cc-banner">
          <p>This website uses cookies to ensure you get the best experience.</p>
          <button class="cc-btn cc-accept">Got it!</button>
        </div>
      </div>
      <article>
        <p>Article content that should be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('best experience'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be translated here.');
  });

  it('should skip cc-floating and cc-container variants', () => {
    setupHTML(`
      <div class="cc-floating">
        <p>Cookie consent floating banner text.</p>
      </div>
      <div class="cc-container">
        <p>Cookie preferences container text.</p>
      </div>
      <article>
        <p>Real article paragraph for translation here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('floating banner'))).toBe(false);
    expect(blockTexts.some(t => t.includes('preferences container'))).toBe(false);
    expect(blockTexts).toContain('Real article paragraph for translation here.');
  });
});

describe('extractBlocks - CMP platforms (ConsentManager, Klaro)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip ConsentManager (cmpbox, cmpwrapper)', () => {
    setupHTML(`
      <div class="cmpbox">
        <div class="cmpbox-inner">
          <div class="cmpbox-content">
            <p>We use cookies and other technologies to provide our services.</p>
          </div>
          <div class="cmpbox-buttons">
            <button class="cmpbox-btn">Accept All</button>
            <button class="cmpbox-btn">Deny</button>
          </div>
        </div>
      </div>
      <article>
        <p>Article content for translation purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('We use cookies'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation purposes here.');
  });

  it('should skip Klaro consent manager', () => {
    setupHTML(`
      <div class="klaro">
        <div class="klaro-cookie-notice">
          <p>Hello! Would you like to accept cookies for analytics?</p>
        </div>
        <div class="klaro-cookie-modal">
          <p>Cookie settings and preferences.</p>
        </div>
      </div>
      <article>
        <p>Article text to be translated for testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('accept cookies'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie settings'))).toBe(false);
    expect(blockTexts).toContain('Article text to be translated for testing here.');
  });
});

describe('extractBlocks - WordPress GDPR/Cookie plugins', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip Borlabs Cookie (borlabs-cookie, brlbs)', () => {
    setupHTML(`
      <div class="borlabs-cookie">
        <div class="brlbs-cmpnt-container">
          <p>This website uses Borlabs Cookie to manage consent.</p>
        </div>
      </div>
      <article>
        <p>Article content that must be translated here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Borlabs Cookie'))).toBe(false);
    expect(blockTexts).toContain('Article content that must be translated here.');
  });

  it('should skip Complianz (cmplz, cmplz-cookie, cmplz-manage)', () => {
    setupHTML(`
      <div id="cmplz-cookiebanner">
        <div class="cmplz-manage-consent">
          <p>We use functional cookies to make our website work properly.</p>
        </div>
      </div>
      <article>
        <p>Article paragraph for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('functional cookies'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation testing here.');
  });

  it('should skip Moove GDPR (moove-gdpr)', () => {
    setupHTML(`
      <div class="moove-gdpr-cookie-notice">
        <p>Our website uses cookies to improve your browsing experience.</p>
      </div>
      <article>
        <p>Article content for translation here please.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('browsing experience'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation here please.');
  });

  it('should skip Cookie Law Info / CookieYes (cli-, wt-cli, cky-)', () => {
    setupHTML(`
      <div class="wt-cli-cookie-bar">
        <div class="cli-modal">
          <div class="cli-popup">
            <p>This website uses cookies to improve your experience.</p>
          </div>
        </div>
      </div>
      <div class="cky-banner">
        <div class="cky-consent">
          <p>CookieYes cookie consent banner content text.</p>
        </div>
      </div>
      <article>
        <p>Article paragraph for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('improve your experience'))).toBe(false);
    expect(blockTexts.some(t => t.includes('CookieYes'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction here.');
  });

  it('should skip wpfront-notification-bar', () => {
    setupHTML(`
      <div class="wpfront-notification-bar">
        <p>Notification bar with cookie policy information.</p>
      </div>
      <article>
        <p>Article paragraph to translate for testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Notification bar'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph to translate for testing here.');
  });
});

describe('extractBlocks - Regional regulation and multilingual class names', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip CCPA, LGPD, EU Cookie, CNIL notices', () => {
    setupHTML(`
      <div class="ccpa-notice">
        <p>Do not sell my personal information.</p>
      </div>
      <div class="lgpd-banner">
        <p>Este site utiliza cookies para melhorar sua experiência.</p>
      </div>
      <div class="eucookie-banner">
        <p>We use cookies in accordance with EU regulations.</p>
      </div>
      <div class="cnil-banner">
        <p>En poursuivant votre navigation, vous acceptez les cookies.</p>
      </div>
      <article>
        <p>Article content for translation purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('personal information'))).toBe(false);
    expect(blockTexts.some(t => t.includes('melhorar sua'))).toBe(false);
    expect(blockTexts.some(t => t.includes('EU regulations'))).toBe(false);
    expect(blockTexts.some(t => t.includes('acceptez les cookies'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation purposes here.');
  });

  it('should skip German (hinweis) and French (confidentialite) notices', () => {
    setupHTML(`
      <div class="hinweis-cookie">
        <p>Diese Website verwendet Cookies zur Verbesserung des Angebots.</p>
      </div>
      <div class="confidentialite-popup">
        <p>Politique de confidentialité et gestion des cookies.</p>
      </div>
      <article>
        <p>Article content to translate for testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Verbesserung'))).toBe(false);
    expect(blockTexts.some(t => t.includes('confidentialité'))).toBe(false);
    expect(blockTexts).toContain('Article content to translate for testing purposes here.');
  });

  it('should skip Polish (rodo) and short cookie forms (cbar, cono, coo, cook)', () => {
    setupHTML(`
      <div class="rodo-popup">
        <p>Informacja o przetwarzaniu danych osobowych.</p>
      </div>
      <div class="cbar-container">
        <p>Cookie bar short form notice text here.</p>
      </div>
      <div class="coo-modal">
        <p>Short cookie modal content for testing.</p>
      </div>
      <div class="cook-modal">
        <p>Another short cookie form for coverage testing.</p>
      </div>
      <article>
        <p>Article paragraph for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('danych osobowych'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie bar short'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Short cookie modal'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Another short cookie'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction here.');
  });
});

describe('extractBlocks - Generic cookie/consent variants', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip bare gdpr, consent, privacy, cookie-bar classes', () => {
    setupHTML(`
      <div class="gdpr">
        <p>GDPR compliance notice about data processing.</p>
      </div>
      <div class="consent">
        <p>Consent management panel for cookie preferences.</p>
      </div>
      <div class="privacy">
        <p>Privacy information about data collection practices.</p>
      </div>
      <div class="cookie-bar">
        <p>Cookie notice bar with accept and reject buttons here.</p>
      </div>
      <article>
        <p>Article content for translation testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('GDPR compliance'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Consent management'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Privacy information'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie notice bar'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation testing here.');
  });

  it('should skip data-protection, cookie-box, cookie-modal, cookie-container', () => {
    setupHTML(`
      <div class="data-protection">
        <p>Data protection declaration and cookie information.</p>
      </div>
      <div class="cookie-box">
        <p>Cookie box containing consent options for users.</p>
      </div>
      <div class="cookie-modal">
        <p>Cookie preferences modal dialog content here.</p>
      </div>
      <div class="cookie-container">
        <p>Container for cookie consent management tools.</p>
      </div>
      <article>
        <p>Article content for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Data protection'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie box'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie preferences'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Container for cookie'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction here.');
  });

  it('should skip cookie-disclaimer, lawdiv, opt-in, euc, disclaimer variants', () => {
    setupHTML(`
      <div class="cookie-disclaimer">
        <p>Cookie disclaimer with important legal information.</p>
      </div>
      <div class="lawdiv">
        <p>Legal division cookie compliance notice text here.</p>
      </div>
      <div class="opt-in">
        <p>Opt-in banner for marketing cookie preferences.</p>
      </div>
      <div class="euc">
        <p>EU cookie compliance directive notice banner.</p>
      </div>
      <div class="disclaimer">
        <p>General disclaimer about cookies and tracking here.</p>
      </div>
      <article>
        <p>Article content that should be extracted for translation.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Cookie disclaimer'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Legal division'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Opt-in banner'))).toBe(false);
    expect(blockTexts.some(t => t.includes('EU cookie'))).toBe(false);
    expect(blockTexts.some(t => t.includes('General disclaimer'))).toBe(false);
    expect(blockTexts).toContain('Article content that should be extracted for translation.');
  });

  it('should skip cookies-modal, cookies-wrapper, cookie__wrap, coockies variants', () => {
    setupHTML(`
      <div class="cookies-modal">
        <p>Modal dialog for managing multiple cookie categories here.</p>
      </div>
      <div class="cookies-wrapper">
        <p>Wrapper container for cookie consent interface elements.</p>
      </div>
      <div class="cookie__wrap">
        <p>BEM style cookie consent wrapper with configuration options.</p>
      </div>
      <div class="coockies-popup">
        <p>Misspelled cookies popup with consent information text.</p>
      </div>
      <article>
        <p>Article paragraph for translation extraction here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('managing multiple'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Wrapper container'))).toBe(false);
    expect(blockTexts.some(t => t.includes('BEM style'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Misspelled cookies'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction here.');
  });

  it('should skip data-privacy, data-consent, consent-popup, consent-wrapper, outer-consent', () => {
    setupHTML(`
      <div class="data-privacy">
        <p>Data privacy statement regarding cookie usage and tracking.</p>
      </div>
      <div class="data-consent">
        <p>Data consent management for analytics and marketing cookies.</p>
      </div>
      <div class="consent-popup">
        <p>Consent popup asking users to accept cookie categories.</p>
      </div>
      <div class="consent-wrapper">
        <p>Wrapper around the full consent management interface UI.</p>
      </div>
      <div class="outer-consent">
        <p>Outer consent layer covering the full viewport for GDPR.</p>
      </div>
      <article>
        <p>Article text for translation extraction purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Data privacy'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Data consent'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Consent popup'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Wrapper around'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Outer consent'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation extraction purposes here.');
  });

  it('should skip cookie-popup, cookie-overlay, cookie-wrapper, cookie-compliance, cookie-control', () => {
    setupHTML(`
      <div class="cookie-popup">
        <p>Popup style cookie notification for first time visitors.</p>
      </div>
      <div class="cookie-overlay">
        <p>Full screen overlay blocking until cookie choice is made.</p>
      </div>
      <div class="cookie-wrapper">
        <p>Cookie consent wrapper with all configuration options.</p>
      </div>
      <div class="cookie-compliance">
        <p>Cookie compliance information for regulatory requirements.</p>
      </div>
      <div class="cookie-control">
        <p>Cookie control panel for managing user consent preferences.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Popup style'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Full screen'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie consent wrapper'))).toBe(false);
    expect(blockTexts.some(t => t.includes('compliance information'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie control'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing here.');
  });

  it('should skip cookie-management, cookieman, cookiemgmt, modal-cookie, modal-cookies', () => {
    setupHTML(`
      <div class="cookie-management">
        <p>Advanced cookie management interface with category toggles.</p>
      </div>
      <div class="cookieman-modal">
        <p>Cookie manager modal for detailed consent configuration.</p>
      </div>
      <div class="cookiemgmt-panel">
        <p>Cookie management panel with granular consent controls.</p>
      </div>
      <div class="modal-cookie">
        <p>Modal cookie dialog for consent collection purposes.</p>
      </div>
      <div class="modal-cookies">
        <p>Modal cookies dialog with settings for all cookie types.</p>
      </div>
      <article>
        <p>Article content to translate for testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Advanced cookie'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie manager'))).toBe(false);
    expect(blockTexts.some(t => t.includes('management panel'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Modal cookie dialog'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Modal cookies dialog'))).toBe(false);
    expect(blockTexts).toContain('Article content to translate for testing purposes here.');
  });

  it('should skip cookie-div, cookie-law, cookie-accept, cookie-law-info, disclaimers', () => {
    setupHTML(`
      <div class="cookie-div">
        <p>Simple cookie notice division element with accept button.</p>
      </div>
      <div class="cookie-law">
        <p>EU cookie law compliance notice with information text.</p>
      </div>
      <div class="cookie-accept">
        <p>Cookie accept banner for first time website visitors.</p>
      </div>
      <div class="cookie-law-info">
        <p>Cookie law information bar at the bottom of the page.</p>
      </div>
      <div class="disclaimer-container">
        <p>Disclaimer container for legal cookie information display.</p>
      </div>
      <div class="disclamer">
        <p>Commonly misspelled disclaimer with cookie notice text.</p>
      </div>
      <article>
        <p>Article text for translation extraction purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Simple cookie'))).toBe(false);
    expect(blockTexts.some(t => t.includes('EU cookie law'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cookie accept'))).toBe(false);
    expect(blockTexts.some(t => t.includes('information bar'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Disclaimer container'))).toBe(false);
    expect(blockTexts.some(t => t.includes('misspelled disclaimer'))).toBe(false);
    expect(blockTexts).toContain('Article text for translation extraction purposes here.');
  });
});

describe('extractBlocks - Google Ad placements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip Google AdSense (adsbygoogle, google-ad, google-ads)', () => {
    setupHTML(`
      <div class="google-ad">
        <ins class="adsbygoogle" data-ad-client="ca-pub-1234567890" data-ad-slot="1234567890">
          <p>Advertisement content from Google AdSense network.</p>
        </ins>
      </div>
      <article>
        <p>Article content for translation testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Advertisement content'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation testing purposes here.');
  });

  it('should skip DFP/GPT ad units (dfp-ad, gpt-ad, div-gpt-ad, dfp-unit)', () => {
    setupHTML(`
      <div class="dfp-ad">
        <div class="dfp-unit">
          <p>DoubleClick for Publishers advertisement slot here.</p>
        </div>
      </div>
      <div class="gpt-ad">
        <p>Google Publisher Tags ad placement content here.</p>
      </div>
      <div class="div-gpt-ad">
        <p>Another GPT ad unit with sponsored message text here.</p>
      </div>
      <article>
        <p>Article paragraph for translation extraction testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('DoubleClick'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Publisher Tags'))).toBe(false);
    expect(blockTexts.some(t => t.includes('sponsored message'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction testing here.');
  });

  it('should skip Ezoic and Freestar ad platforms (ezoic-ad, freestar-ad)', () => {
    setupHTML(`
      <div class="ezoic-ad">
        <p>Ezoic platform advertisement placement unit here.</p>
      </div>
      <div class="freestar-ad">
        <p>Freestar ad network sponsored placement content.</p>
      </div>
      <div class="ezoic-pub">
        <p>Ezoic publisher ad placeholder with tracking text.</p>
      </div>
      <article>
        <p>Article content for translation extraction purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Ezoic platform'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Freestar ad'))).toBe(false);
    expect(blockTexts.some(t => t.includes('publisher ad'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction purposes here.');
  });
});

describe('extractBlocks - Native ad widgets (Taboola, Outbrain, MGID, RevContent, Zergnet)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip Taboola and Outbrain recommendation widgets', () => {
    setupHTML(`
      <div class="taboola-widget">
        <div class="trc">
          <p>You may like these sponsored stories from around the web.</p>
          <a href="#">Sponsored link by Taboola network content here.</a>
        </div>
      </div>
      <div class="outbrain-widget">
        <div class="ob-widget">
          <p>Recommended reading from Outbrain sponsored content platform.</p>
        </div>
      </div>
      <article>
        <p>Article content for translation testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('sponsored stories'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Recommended reading'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation testing purposes here.');
  });

  it('should skip MGID and MarketGid widgets', () => {
    setupHTML(`
      <div class="mgid-widget">
        <div class="mgbox">
          <p>Sponsored content from MGID native advertising network.</p>
        </div>
      </div>
      <div class="marketgid-container">
        <p>MarketGid native ad recommendation widget content here.</p>
      </div>
      <article>
        <p>Article content to translate for testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('native advertising'))).toBe(false);
    expect(blockTexts.some(t => t.includes('MarketGid'))).toBe(false);
    expect(blockTexts).toContain('Article content to translate for testing purposes here.');
  });

  it('should skip RevContent and Zergnet widgets', () => {
    setupHTML(`
      <div class="revcontent-widget">
        <div class="rc-widget">
          <p>RevContent native ad widget with sponsored links here.</p>
        </div>
      </div>
      <div class="zergnet-widget">
        <p>Zergnet content recommendation widget with ads text.</p>
      </div>
      <article>
        <p>Article paragraph for translation extraction testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('RevContent'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Zergnet'))).toBe(false);
    expect(blockTexts).toContain('Article paragraph for translation extraction testing here.');
  });

  it('should skip native-ad, native-ads, content-recommendation, recommended-content', () => {
    setupHTML(`
      <div class="native-ad">
        <p>Native advertisement blending with editorial content on this page.</p>
      </div>
      <div class="content-recommendation">
        <p>Content recommendations powered by third party ad networks here.</p>
      </div>
      <div class="recommended-content">
        <p>Recommended articles sponsored by advertising partners text here.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Native advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Content recommendations'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Recommended articles'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });
});

describe('extractBlocks - Ad formats and placements', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip leaderboard, skyscraper, ad-banner, display-ad ad formats', () => {
    setupHTML(`
      <div class="leaderboard">
        <p>728x90 leaderboard advertisement banner at the top of the page.</p>
      </div>
      <div class="skyscraper">
        <p>160x600 skyscraper ad unit in the sidebar for testing here.</p>
      </div>
      <div class="ad-banner">
        <p>Generic advertisement banner with promotional content text.</p>
      </div>
      <div class="display-ad">
        <p>Display advertising unit with image and text for marketing.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('leaderboard advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('skyscraper ad'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Generic advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Display advertising'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });

  it('should skip header-ad, footer-ad, sticky-ad placement ads', () => {
    setupHTML(`
      <div class="header-ad">
        <p>Advertisement in header area above the main content section.</p>
      </div>
      <div class="footer-ad">
        <p>Footer advertisement unit at the bottom of the page layout.</p>
      </div>
      <div class="sticky-ad">
        <p>Sticky advertisement that follows user as they scroll content.</p>
      </div>
      <article>
        <p>Article content for translation purposes and testing here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('header area'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Footer advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Sticky advertisement'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation purposes and testing here.');
  });

  it('should skip in-article-ad, inline-ad, incontent-ad placements', () => {
    setupHTML(`
      <article>
        <p>First paragraph of the article content that is genuine here.</p>
        <div class="in-article-ad">
          <p>Advertisement inserted between article paragraphs for revenue.</p>
        </div>
        <p>Second paragraph of article content after the ad placement here.</p>
        <div class="inline-ad">
          <p>Inline advertisement within the article body content area.</p>
        </div>
        <div class="incontent-ad">
          <p>In-content advertisement placed between text paragraphs here.</p>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('inserted between'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Inline advertisement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('In-content advertisement'))).toBe(false);
    expect(blockTexts).toContain('First paragraph of the article content that is genuine here.');
    expect(blockTexts).toContain('Second paragraph of article content after the ad placement here.');
  });

  it('should skip ad-wrapper, ad-panel, ad-frame, ad-box, adslot, adunit, adv, advertorial', () => {
    setupHTML(`
      <div class="ad-wrapper">
        <div class="ad-panel">
          <p>Wrapper container for advertisement placements on the website.</p>
        </div>
      </div>
      <div class="ad-frame">
        <div class="ad-box">
          <p>Advertising frame with boxed content for monetization here.</p>
        </div>
      </div>
      <div class="adslot">
        <p>Ad slot placeholder for programmatic advertising content.</p>
      </div>
      <div class="adunit">
        <p>Ad unit for display advertising served by ad network here.</p>
      </div>
      <div class="adv">
        <p>Short advert class notice for quick ad placement integration.</p>
      </div>
      <div class="advertorial">
        <p>Advertorial content that looks like editorial but is paid promotion.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Wrapper container'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Advertising frame'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad slot'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad unit'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Short advert'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Advertorial content'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });

  it('should skip ad-label, ad-placeholder, ad-inner, ad-holder, ad-widget, ad-code, ad-content variants', () => {
    setupHTML(`
      <div class="ad-label">
        <p>Advertisement label indicating paid content placement here.</p>
      </div>
      <div class="ad-placeholder">
        <p>Ad placeholder waiting for programmatic fill from network.</p>
      </div>
      <div class="ad-inner">
        <p>Inner ad container with nested advertisement elements here.</p>
      </div>
      <div class="ad-holder">
        <p>Ad holder div for dynamic ad insertion during page load.</p>
      </div>
      <div class="ad-widget">
        <p>Ad widget sidebar with sponsored content recommendations here.</p>
      </div>
      <div class="ad-code">
        <p>Ad code injected dynamically with tracking pixels and content.</p>
      </div>
      <div class="ad-content">
        <p>Ad content block with promotional messaging for products here.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Advertisement label'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad placeholder'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Inner ad container'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad holder div'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad widget sidebar'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad code injected'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad content block'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });
});

describe('extractBlocks - Sponsored, promoted and commercial content', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip sponsored-content, sponsored-post, sponsored-link(s)', () => {
    setupHTML(`
      <div class="sponsored-content">
        <p>This is sponsored content from our advertising partners network.</p>
      </div>
      <div class="sponsored-post">
        <p>Sponsored post with promotional content for products here.</p>
      </div>
      <div class="sponsored-links">
        <ul>
          <li class="sponsored-link"><a href="#">Paid link to external advertiser site here.</a></li>
          <li class="sponsored-link"><a href="#">Another sponsored link for testing purposes here.</a></li>
        </ul>
      </div>
      <article>
        <p>Article content for translation extraction testing purposes here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('sponsored content from'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Sponsored post'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Paid link'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing purposes here.');
  });

  it('should skip promoted-content, promoted-post, paid-content, paid-post', () => {
    setupHTML(`
      <div class="promoted-content">
        <p>Promoted content placed by advertising platform for marketing.</p>
      </div>
      <div class="promoted-post">
        <p>Promoted post with boosted visibility from paid promotion here.</p>
      </div>
      <div class="paid-content">
        <p>Paid content placement with sponsored messaging for products.</p>
      </div>
      <div class="paid-post">
        <p>Paid post sponsored by brand partners for advertising purposes.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing here please.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Promoted content'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Promoted post'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Paid content placement'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Paid post'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing here please.');
  });

  it('should skip affiliate, affiliate-link, commercial, commercial-content, advertorial', () => {
    setupHTML(`
      <div class="affiliate-content">
        <div class="affiliate-link">
          <p>Affiliate marketing disclosure and product recommendation here.</p>
        </div>
      </div>
      <div class="commercial-content">
        <p>Commercial content featuring paid product placement advertising.</p>
      </div>
      <div class="advertorial">
        <p>Advertorial style content presenting paid promotion as editorial.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing here please.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Affiliate marketing'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Commercial content'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Advertorial style'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing here please.');
  });

  it('should skip bare sponsored, promoted, commercial classes', () => {
    setupHTML(`
      <div class="sponsored">
        <p>Generic sponsored section with paid promotional content here.</p>
      </div>
      <div class="promoted">
        <p>Generic promoted section with advertiser messages for testing.</p>
      </div>
      <div class="commercial">
        <p>Commercial section with paid advertising content placement here.</p>
      </div>
      <article>
        <p>Article content for translation extraction testing here please.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Generic sponsored'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Generic promoted'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Commercial section'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation extraction testing here please.');
  });

  it('should skip ad-div, ad-area, ad-outer, ad-block, generic advert/adv', () => {
    setupHTML(`
      <div class="ad-div">
        <p>Generic ad division container for advertisement placements here.</p>
      </div>
      <div class="ad-area">
        <p>Ad area designation for programmatic ad slot placement here.</p>
      </div>
      <div class="ad-outer">
        <p>Outer ad wrapper for responsive advertisement units on page.</p>
      </div>
      <div class="ad-block">
        <p>Ad block extension detected advertisement container for removal.</p>
      </div>
      <div class="advert">
        <p>Generic advertisement class with promotional content for testing.</p>
      </div>
      <article>
        <p>Article content for translation purposes here for testing.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Generic ad division'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad area designation'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Outer ad wrapper'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Ad block extension'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Generic advertisement'))).toBe(false);
    expect(blockTexts).toContain('Article content for translation purposes here for testing.');
  });
});

describe('extractBlocks - Large documents', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should handle article with many paragraphs efficiently', () => {
    const paragraphs = Array.from({ length: 50 }, (_, i) =>
      `<p>Paragraph number ${i + 1} with enough text content to be extracted as a translatable block for testing.</p>`
    ).join('\n');

    setupHTML(`<article>${paragraphs}</article>`);

    const blocks = extractBlocks(document);
    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks).toHaveLength(50);
  });

  it('should skip very long text blocks', () => {
    const longText = 'Long text content. '.repeat(200);

    setupHTML(`
      <article>
        <p>${longText}</p>
        <p>Normal paragraph with enough text content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe('Normal paragraph with enough text content here.');
  });
});

describe('extractBlocks - WordPress/TNS style page (sample4.html)', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should skip navigation divs, footers, sidebars on lang=en-US pages', () => {
    document.documentElement.setAttribute('lang', 'en-US');

    setupHTML(`
      <div class="mobile-nav-dropdown">
        <div class="mobile-nav-header">Topics</div>
        <div class="mobile-nav-menu">
          <a href="/ai/">AI and Machine Learning</a>
          <a href="/cloud/">Cloud Native Computing</a>
        </div>
      </div>
      <div class="channels-nav">
        <a href="/podcasts/">Podcasts</a>
        <a href="/ebooks/">eBooks</a>
      </div>
      <div class="topics-nav">
        <a href="/architecture/">Architecture</a>
        <a href="/engineering/">Engineering</a>
      </div>
      <div class="content-column content-column-post-body">
        <div class="breadcrumb">
          <a href="/category/ai-agents/">AI Agents</a>
          <span> / </span>
          <a href="/category/ai-strategy/">AI Strategy</a>
        </div>
        <h1 class="title">Forward deployed engineer is AI's hottest job</h1>
        <div class="byline">
          <span class="date">May 16th, 2026 6:00am by</span>
          <span class="author">Matthew Burns</span>
        </div>
        <article>
          <p>OpenAI launched the Deployment Company this week.</p>
          <p>If you have been wondering which AI job is durable, the answer is becoming obvious.</p>
        </article>
      </div>
      <div class="content-column content-column-post-footer">
        <div class="related-posts">
          <a href="/post1/">Related article number one about AI</a>
          <a href="/post2/">Related article number two about cloud</a>
        </div>
      </div>
      <div class="footer">
        <p>Copyright 2026 The New Stack. All rights reserved.</p>
      </div>
      <div class="sidebar">
        <div class="widget-area">
          <h4>Subscribe to Our Newsletter</h4>
          <p>Get the latest news delivered to your inbox.</p>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).not.toContain('AI and Machine Learning');
    expect(blockTexts).not.toContain('Podcasts');
    expect(blockTexts).not.toContain('Architecture');
    expect(blockTexts).not.toContain('AI Agents');
    expect(blockTexts).not.toContain('Matthew Burns');
    expect(blockTexts).not.toContain('Related article number one about AI');
    expect(blockTexts).not.toContain('Copyright 2026 The New Stack. All rights reserved.');
    expect(blockTexts).not.toContain('Get the latest news delivered to your inbox.');

    expect(blockTexts).toContain('OpenAI launched the Deployment Company this week.');
    expect(blockTexts).toContain('If you have been wondering which AI job is durable, the answer is becoming obvious.');
  });

  it('should skip subscribe forms and trending story widgets inside article body', () => {
    setupHTML(`
      <article>
        <p>Main content paragraph that should definitely be translated here.</p>
        <div class="tns-trending-stories-block inline">
          <div class="section-heading">TRENDING STORIES</div>
          <ol class="tns-trending-stories-ol">
            <li><a href="/post1/">What Anthropic and OpenAI launched in 72 hours</a></li>
            <li><a href="/post2/">Forward deployed engineer is AI's hottest job</a></li>
          </ol>
        </div>
        <div class="subscribe-widget">
          <h4>Subscribe for Updates</h4>
          <p>Get notified about new articles and events.</p>
          <input type="email" placeholder="Enter your email address here" />
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts).not.toContain('TRENDING STORIES');
    expect(blockTexts).not.toContain('What Anthropic and OpenAI launched in 72 hours');
    expect(blockTexts).not.toContain('Forward deployed engineer is AI\'s hottest job');
    expect(blockTexts).not.toContain('Get notified about new articles and events.');
    expect(blockTexts).toContain('Main content paragraph that should definitely be translated here.');
  });

  it('should only extract article body paragraphs from a complete WordPress page layout', () => {
    setupHTML(`
      <header class="header">
        <div class="logo"><a href="/">The New Stack</a></div>
        <nav class="main-menu">
          <a href="/ai/">AI</a>
          <a href="/cloud/">Cloud</a>
        </nav>
      </header>
      <div class="content-column content-column-post-body">
        <h1 class="title">The Future of AI Engineering Careers</h1>
        <div class="byline">
          <span class="date">May 2026</span>
          <span class="author">By Jane Doe and John Smith</span>
        </div>
        <div class="social-share">
          <button>Share on Twitter</button>
          <button>Share on LinkedIn</button>
        </div>
        <div id="tns-post-body-content">
          <p class="first-paragraph">The AI engineering field is rapidly evolving with new roles emerging.</p>
          <h2 class="wp-block-heading">What Makes a Good AI Engineer</h2>
          <p>Understanding both the technical and business aspects is crucial for success.</p>
          <h2 class="wp-block-heading">Career Path and Growth Opportunities</h2>
          <p>The career trajectory for AI engineers shows remarkable growth potential.</p>
        </div>
      </div>
      <aside class="sidebar">
        <div class="widget-area">
          <h4>Popular Articles</h4>
          <ul>
            <li><a href="/post1/">How Kubernetes Changed Everything Forever</a></li>
            <li><a href="/post2/">The Rise of Platform Engineering Teams</a></li>
          </ul>
        </div>
      </aside>
      <footer class="footer">
        <div class="copyright">2026 The New Stack</div>
      </footer>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('The New Stack'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Jane Doe'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Share on'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Kubernetes Changed'))).toBe(false);

    const pBlocks = blocks.filter(b => b.tag === 'p');
    expect(pBlocks.length).toBeGreaterThanOrEqual(3);

    expect(blockTexts).toContain('The AI engineering field is rapidly evolving with new roles emerging.');
    expect(blockTexts).toContain('Understanding both the technical and business aspects is crucial for success.');
    expect(blockTexts).toContain('The career trajectory for AI engineers shows remarkable growth potential.');
  });

  it('should skip nav divs even when not using semantic nav tag (div-based nav)', () => {
    setupHTML(`
      <div class="mobile-nav-dropdown">
        <div class="content-column">
          <div class="row mobile-nav-row">
            <div class="col-20 mobile-nav-col">
              <div class="mobile-nav-header">Topics</div>
              <div class="mobile-nav-menu">
                <a href="/ai/">Artificial Intelligence and Machine Learning</a>
                <a href="/cloud/">Cloud Native and Kubernetes Ecosystem</a>
              </div>
            </div>
            <div class="col-20 mobile-nav-col">
              <div class="mobile-nav-header">Resources</div>
              <div class="mobile-nav-menu">
                <a href="/ebooks/">Free eBooks and Guides for Developers</a>
                <a href="/webinars/">Upcoming Webinars and Live Events</a>
              </div>
            </div>
          </div>
        </div>
      </div>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Artificial Intelligence'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Cloud Native'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Free eBooks'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Upcoming Webinars'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Topics'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Resources'))).toBe(false);
  });

  it('should handle compound class names like content-column-post-footer via endsWith matching', () => {
    setupHTML(`
      <div class="content-column content-column-post-footer">
        <p>Footer paragraph that should be skipped entirely.</p>
      </div>
      <div class="content-column content-column-mobile-footer">
        <p>Mobile footer paragraph that should also be skipped.</p>
      </div>
      <div class="content-column content-column-post-body">
        <p>Actual article content that should be translated here.</p>
      </div>
    `);

    const blocks = extractBlocks(document);
    const blockTexts = blocks.map(b => b.text);

    expect(blockTexts.some(t => t.includes('Footer paragraph'))).toBe(false);
    expect(blockTexts.some(t => t.includes('Mobile footer'))).toBe(false);
    expect(blockTexts).toContain('Actual article content that should be translated here.');
    expect(blocks).toHaveLength(1);
  });
});

describe('extractBlocks - Adjacent inline elements in article', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should extract multiple adjacent span elements as separate blocks', () => {
    setupHTML(`
      <article>
        <div>
          <span>First span with enough text content for a standalone block here.</span>
          <span>Second span with enough text content for a standalone block here.</span>
          <span>Third span with enough text content for a standalone block here.</span>
        </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const spanBlocks = blocks.filter(b => b.tag === 'span');
    expect(spanBlocks).toHaveLength(3);
  });

  it('should extract div with direct text and inline children as one block', () => {
    setupHTML(`
      <article>
        <div class="content">
          Text content directly inside div <a href="#">with a link</a> and more text <strong>and bold</strong> at the end.
          </div>
      </article>
    `);

    const blocks = extractBlocks(document);
    const divBlocks = blocks.filter(b => b.tag === 'div');
    expect(divBlocks.length).toBeGreaterThanOrEqual(1);
  });
});
