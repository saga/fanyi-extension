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
      const root = detectArticleRoot(document)?.element ?? null;
      expect(root).not.toBeNull();
      expect(root!.tagName).toBe('ARTICLE');
    });


    it('returns null for pages with no good content', () => {
      document.body.innerHTML = `
        <nav><a href="/">Home</a><a href="/about">About</a></nav>
        <div><a href="/link1">Link</a></div>
      `;
      const root = detectArticleRoot(document)?.element ?? null;
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
      const root = detectArticleRoot(document)?.element ?? null;
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

      const root = detectArticleRoot(document)?.element ?? null;
      expect(root).not.toBeNull();
      // Must pick the article, never any OneTrust container.
      expect(root!.id).not.toBe('ot-pc-content');
      expect(root!.id).not.toBe('onetrust-pc-sdk');
      expect(root!.closest('#onetrust-consent-sdk')).toBeNull();
      expect(root!.textContent).toContain('real article body');
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
      const root = detectArticleRoot(document)?.element ?? null;
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

      const root = detectArticleRoot(document)?.element ?? null;
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

      const root = detectArticleRoot(document)?.element ?? null;
      expect(root).not.toBeNull();
      expect(root!.className).toContain('post-content');
      expect(root!.closest('#cookie-banner')).toBeNull();
    });

    // Regression: developers.googleblog.com
    // 页面没有 article/main，body 下直接是 .blog-detail-container 作为真正文章容器。
    // 文章内部有很多 .inner-block-content.rich-content 小块（单段文字、密度极高），
    // 之前因为 rich 命中正 token 且链接少，得分超过真正容器，导致只提取到 1 个 block。
    it('prefers large body-level container over high-density inner fragments', () => {
      document.body.innerHTML = `
        <header class="dgc-header">
          <a href="/">Google Developers</a>
          <a href="/products">Products</a>
          <a href="/blog">Blog</a>
        </header>
        <div class="blog-detail-container">
          <h1>LiteRT.js, Google's high performance Web AI Inference</h1>
          <p>We are excited to announce LiteRT.js, a JavaScript binding of LiteRT for running AI directly inside the web browser.</p>
          <p>While prior web AI solutions like TensorFlow.js relied on less performant JavaScript-based kernels, we are now making our native runtime available to the web.</p>
          <p>Our initial release provides all the tools needed to get started, including the new LiteRT.js npm package and a collection of demos.</p>
          <p>With LiteRT.js, web developers can integrate models into their apps written in JavaScript or TypeScript to handle complex tasks.</p>
          <p>By leveraging LiteRT's lowering flow and runtime, you get simple conversion of models from a variety of Python ML frameworks.</p>
          <div class="block">
            <div class="inner-block-content rich-content">
              <p>To ground these claims in real-world efficiency, we benchmarked popular AI models using LiteRT.js across three distinct hardware configurations.</p>
            </div>
            <div class="inner-block-content rich-content">
              <p>The results show significant improvements in latency and memory usage compared to pure JavaScript inference solutions.</p>
            </div>
            <div class="inner-block-content rich-content">
              <p>Developers can expect consistent behavior across Chrome, Firefox, Safari, and Edge.</p>
            </div>
          </div>
          <p>Native hardware acceleration is available across CPU, GPU, and NPU through WebGPU and WebGL backends.</p>
          <p>Quantization tools allow you to configure tailored schemes across different model architectures.</p>
        </div>
        <footer class="footer-utility__wrapper"><p>Terms & Privacy</p></footer>
      `;

      const root = detectArticleRoot(document)?.element ?? null;
      expect(root).not.toBeNull();
      expect(root!.className).toContain('blog-detail-container');
      expect(root!.className).not.toContain('inner-block-content');
    });

    // Readability 主条件：body 噪声过大 + 真正容器链接多时，Readability 作为
    // 判断主条件应能稳定定位到真正的文章容器（.main-content），而非高密度碎片。
    it('locates the real article via Readability primary even with heavy body noise', () => {
      const articleText = 'We are excited to announce our new product. It brings powerful features to developers around the world. This article explains the motivation, design, and usage of the new release.';
      const denseFragment = 'To validate performance we ran comprehensive benchmarks across multiple configurations and observed significant improvements in latency and throughput metrics.';
      // 大量噪声脚本稀释真正容器的占比，验证 Readability 主条件仍能定位 .main-content
      const noise = 'noise '.repeat(20000);
      // 大量链接稀释真正容器的 density score
      const manyLinks = Array.from({ length: 40 }, (_, i) => `<a href="/ref-${i}">reference ${i}</a>`).join(' ');

      document.body.innerHTML = `
        <script>/* ${noise} */</script>
        <header><a href="/">Home</a><a href="/about">About</a></header>
        <div class="main-content">
          <h1>Product Announcement</h1>
          <p>${articleText}</p>
          <p>Developers can integrate the library using a simple npm install command and start building immediately.</p>
          <p>${manyLinks}</p>
          <div class="rich-content">
            <p>${denseFragment}</p>
          </div>
          <p>The release includes comprehensive documentation, examples, and community support channels.</p>
        </div>
        <footer><p>Terms & Privacy</p></footer>
      `;

      const root = detectArticleRoot(document)?.element ?? null;
      expect(root).not.toBeNull();
      expect(root!.className).toContain('main-content');
      expect(root!.className).not.toContain('rich-content');
    });

    // Readability 主条件契约：404media.co 类结构（<article class="... has-sidebar">
    // 含正文，h1 在兄弟 .post-hero）。手写评分在这种「语义标签 + 噪声类 has-sidebar」
    // 组合上容易误判，而 Readability 作为主条件应稳定返回包含正文的容器。
    // 此测试锁定 detectArticleRoot 必须优先采用 Readability 的结果，而非评分算法。

    // ContentRoot 契约（ADR-001 P0）：detectArticleRoot 返回 ContentRoot，
    // 携带 source / confidence / evidence，供调试与后续 Evidence Fusion 使用。
  });
});
