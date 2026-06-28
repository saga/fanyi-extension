import { describe, it, expect, beforeEach } from 'vitest';
import {
  scoreElement,
  collectCandidates,
  detectArticleRoot,
  SCORE_THRESHOLD,
} from '../entrypoints/utils/contentDetector';

describe('contentDetector', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  // --- scoreElement ---

  describe('scoreElement', () => {
    it('scores high for article-like content', () => {
      const el = document.createElement('div');
      el.className = 'article-content';
      el.innerHTML = `
        <h1>Title</h1>
        <p>This is a paragraph with some text content.</p>
        <p>Another paragraph with more words and sentences.</p>
        <p>Third paragraph to increase the text density of this element.</p>
      `;
      document.body.appendChild(el);
      const score = scoreElement(el);
      expect(score).toBeGreaterThan(0.5);
    });

    it('scores lower for navigation than content', () => {
      const nav = document.createElement('div');
      nav.className = 'main-menu';
      nav.innerHTML = `
        <a href="/home">Home</a>
        <a href="/about">About</a>
        <a href="/contact">Contact</a>
        <a href="/blog">Blog</a>
        <a href="/docs">Docs</a>
      `;
      document.body.appendChild(nav);

      const content = document.createElement('div');
      content.className = 'article-body';
      content.innerHTML = `
        <h1>Article</h1>
        <p>This is a real article with paragraphs of text content.</p>
        <p>More content here to make the score higher.</p>
      `;
      document.body.appendChild(content);

      expect(scoreElement(nav)).toBeLessThan(scoreElement(content));
    });

    it('scores empty elements low', () => {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const score = scoreElement(el);
      expect(score).toBeLessThan(0.15);
    });
  });

  // --- collectCandidates ---

  describe('collectCandidates', () => {
    it('collects article and main elements', () => {
      document.body.innerHTML = `
        <article><p>Article content</p></article>
        <main><p>Main content</p></main>
      `;
      const candidates = collectCandidates(document);
      const tags = candidates.map(el => el.tagName.toLowerCase());
      expect(tags).toContain('article');
      expect(tags).toContain('main');
    });

    it('collects elements with content-like class names', () => {
      document.body.innerHTML = `
        <div class="sidebar"><a href="#">Link</a></div>
        <div class="post-content"><p>Post content</p></div>
        <div class="article-body"><p>Article body</p></div>
      `;
      const candidates = collectCandidates(document);
      const classes = candidates.map(el => el.className);
      expect(classes.some(c => c.includes('post-content'))).toBe(true);
      expect(classes.some(c => c.includes('article-body'))).toBe(true);
    });

    it('collects parent elements (up to 2 levels)', () => {
      document.body.innerHTML = `
        <div id="level-0">
          <div id="level-1">
            <div id="level-2" class="article-content">
              <p>Content</p>
            </div>
          </div>
        </div>
      `;
      const candidates = collectCandidates(document);
      const ids = candidates.map(el => el.id);
      expect(ids).toContain('level-2');
      expect(ids).toContain('level-1');
      expect(ids).toContain('level-0');
    });

    it('does not collect body or html', () => {
      document.body.innerHTML = '<div class="article"><p>Content</p></div>';
      const candidates = collectCandidates(document);
      expect(candidates).not.toContain(document.body);
      expect(candidates).not.toContain(document.documentElement);
    });

    it('does not duplicate elements', () => {
      document.body.innerHTML = '<article class="content"><p>Content</p></article>';
      const candidates = collectCandidates(document);
      const articleCount = candidates.filter(el => el.tagName === 'ARTICLE').length;
      expect(articleCount).toBe(1);
    });
  });

  // --- detectArticleRoot ---

  describe('detectArticleRoot', () => {
    it('detects article content', () => {
      document.body.innerHTML = `
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <article>
          <h1>Article Title</h1>
          <p>This is a long article with multiple paragraphs of content.</p>
          <p>The second paragraph continues the article with more text.</p>
          <p>A third paragraph to ensure high text density and paragraph ratio.</p>
        </article>
        <footer><p>Footer content</p></footer>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.tagName).toBe('ARTICLE');
    });

    it('detects div with content-like class', () => {
      document.body.innerHTML = `
        <div class="sidebar"><a href="#">Link1</a><a href="#">Link2</a></div>
        <div class="post-content">
          <h2>Blog Post</h2>
          <p>This is a blog post with substantial content that should be detected.</p>
          <p>More paragraphs to increase the score of this element.</p>
          <p>Even more content to ensure the scoring algorithm picks this div.</p>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.className).toContain('post-content');
    });

    it('returns null for pages with no good content', () => {
      document.body.innerHTML = `
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <div><a href="/link1">Link</a></div>
      `;
      const root = detectArticleRoot(document);
      expect(root).toBeNull();
    });

    it('prefers content div over navigation', () => {
      document.body.innerHTML = `
        <div class="main-menu">
          <a href="/home">Home</a>
          <a href="/about">About</a>
          <a href="/blog">Blog</a>
          <a href="/docs">Docs</a>
        </div>
        <div class="content">
          <h1>Welcome</h1>
          <p>This is the main content of the page with real article text.</p>
          <p>It has multiple paragraphs and good text density.</p>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.textContent).toContain('main content');
    });

    // Regression: databricks.com blog. OneTrust cookie banner (#onetrust-consent-sdk
    // → #onetrust-pc-sdk → #ot-pc-content) holds ~2600 chars of dense GDPR legal text
    // with almost no links, so it scores HIGHER than the real article body. Without
    // the consent-SDK exclusion it wins detectArticleRoot() and the walker then prunes
    // the whole subtree (every ancestor carries ot-/onetrust/consent classes), yielding
    // 0 blocks → "No translatable content found".
    it('excludes consent/cookie SDK containers even when they score highest', () => {
      document.body.innerHTML = `
        <div id="onetrust-consent-sdk">
          <div id="onetrust-pc-sdk" class="otPcTab ot-hide">
            <div id="ot-pc-content" class="ot-pc-scrollbar ot-sdk-row">
              <p>We use cookies to personalize content and analyze our traffic. You can consent to the use of such technologies by accepting all, or reject all non-essential technologies.</p>
              <p>Privacy Preference Center. When you visit any website, it may store or retrieve information on your browser, mostly in the form of cookies.</p>
              <p>Manage your privacy preferences and consent settings across all vendors. Strictly Necessary Cookies Always Active.</p>
            </div>
          </div>
        </div>
        <div class="rich-text-blog">
          <h1>Introducing the product</h1>
          <p>This is the real article body with multiple paragraphs of genuine content that users want translated.</p>
          <p>Second paragraph of the actual article continues here with more detail.</p>
          <p>Third paragraph rounds out the article body so it has healthy text density.</p>
        </div>
      `;

      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      // Must pick the article, never any OneTrust container.
      expect(root!.id).not.toBe('ot-pc-content');
      expect(root!.id).not.toBe('onetrust-pc-sdk');
      expect(root!.closest('#onetrust-consent-sdk')).toBeNull();
      expect(root!.textContent).toContain('real article body');
    });

    it('excludes consent SDK reachable via class match (Cookiebot)', () => {
      document.body.innerHTML = `
        <div class="CybotCookiebotDialog">
          <p>We use cookies. Accept all. Manage consent. Privacy settings for everyone.</p>
          <p>Cookiebot consent dialog with lots of dense legal text and no links at all.</p>
        </div>
        <div class="post-content">
          <h2>Real post</h2>
          <p>This is the genuine article content that should be detected as the root.</p>
          <p>Additional paragraphs ensure this scores well in the detection algorithm.</p>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.className).toContain('post-content');
    });

    // Regression: analyticsvidhya.com blog. Custom cookie modal #cookiesModal
    // (class "modal fade", not a known SDK name) holds ~50k chars of cookie policy
    // text in #myTabContent. The id "cookiesModal" didn't match CONSENT_SDK_ID_RE
    // (which only had "cookielaw"/"cookie-law", not plain "cookie"), so
    // #myTabContent scored highest and won detectArticleRoot() — translating
    // cookie policy instead of the article.
    it('excludes custom cookie modal with "cookie" in id (not a known SDK)', () => {
      document.body.innerHTML = `
        <div id="cookiesModal" class="modal fade">
          <div class="modal-dialog">
            <div class="modal-content">
              <div class="modal-body">
                <div id="myTabContent" class="tab-content">
                  <div id="details" class="tab-pane">
                    <h2>Necessary cookies</h2>
                    <p>Necessary cookies help make a website usable by enabling basic functions like page navigation and access to secure areas of the website. The website cannot function properly without these cookies.</p>
                    <p>Analytics cookies allow the website to compute anonymous visits and traffic sources so that the website can be improved. All information these cookies collect is aggregated and anonymous.</p>
                    <p>Marketing cookies are used to track visitors across websites. The intention is to display ads that are relevant and engaging for the individual user.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div id="article-start" class="content-box">
          <h1>System Design for ML Interviews</h1>
          <p>ML system design interviews test how well you can think beyond models. Choosing an algorithm is only one part of the answer.</p>
          <p>You also need to explain how data is collected, how features are created, and how predictions are served.</p>
        </div>
      `;
      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.id).toBe('article-start');
      expect(root!.closest('#cookiesModal')).toBeNull();
      expect(root!.textContent).toContain('ML system design interviews');
    });

    // 安全阀：consent SDK 容器若 textContent > 5000 字符不视为噪声，参与评分。
    // 回归 case: 长隐私政策 / 长 FAQ 用 id="cookie-policy" 命名，但因文本过长
    // 实际是页面正文，不应被绝对排除导致 "No translatable content"。
    it('safe valve: long cookie-named container (>5000 chars) is NOT excluded', () => {
      // 构造一个 >5000 字符的 "cookie-policy" 容器作为唯一候选正文
      const longPolicy = 'This privacy policy paragraph explains in detail how user data is handled. '.repeat(80); // ~5800 chars
      document.body.innerHTML = `
        <div id="cookie-policy" class="cookie-banner">
          <h1>Privacy Policy</h1>
          <p>${longPolicy}</p>
          <p>Additional paragraph to ensure healthy text density for detection.</p>
        </div>
      `;

      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      // 安全阀应让 cookie-policy 容器参与评分并胜出
      expect(root!.id).toBe('cookie-policy');
    });

    it('safe valve: short cookie-named container (<5000 chars) is still excluded', () => {
      // 对照组：短文本的 cookie-banner 仍应被排除
      document.body.innerHTML = `
        <div id="cookie-banner" class="cookie-banner">
          <p>We use cookies. Accept all to continue.</p>
        </div>
        <div class="post-content">
          <h1>Real Article</h1>
          <p>This is the genuine article content that should be detected as the root.</p>
          <p>Another paragraph to ensure good text density and structure for detection.</p>
        </div>
      `;

      const root = detectArticleRoot(document);
      expect(root).not.toBeNull();
      expect(root!.className).toContain('post-content');
      expect(root!.closest('#cookie-banner')).toBeNull();
    });
  });
});
