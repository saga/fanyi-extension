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

describe('buildNodeMap', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('should build a map of block IDs to nodes', () => {
    setupHTML(`
      <article>
        <p>First paragraph content here.</p>
        <p>Second paragraph content here.</p>
      </article>
    `);

    const blocks = extractBlocks(document);
    const nodeMap = buildNodeMap(blocks, document);

    expect(nodeMap.size).toBe(blocks.length);
    expect(nodeMap.has('b1')).toBe(true);
    expect(nodeMap.has('b2')).toBe(true);
  });
});
