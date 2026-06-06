import { matchSiteRule, type SiteRule } from '../../rules';

export interface TextBlock {
  id: string;
  xpath: string;
  tag: string;
  text: string;
  context?: {
    headingPath: string[];
    position: number;
  };
}

const MIN_TEXT_LENGTH = 3;
const MAX_TEXT_LENGTH = 3072;
const XHTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';

const DIRECT_SET = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'li', 'dd', 'blockquote',
  'figcaption'
]);

const SKIP_SET = new Set([
  'html', 'body', 'script', 'style', 'noscript', 'iframe',
  'input', 'textarea', 'select', 'button', 'code', 'pre',
  'dt', 'td', 'th', 'caption'
]);

const SEMANTIC_SKIP_TAGS = new Set(['header', 'footer', 'aside', 'nav']);

const INLINE_SET = new Set([
  'a', 'b', 'strong', 'span', 'em', 'i', 'u', 'small', 'sub', 'sup',
  'font', 'mark', 'cite', 'q', 'abbr', 'time', 'ruby', 'bdi', 'bdo',
  'img', 'br', 'wbr', 'svg'
]);

const SKIP_CLASS_PATTERNS = [
  'sidebar', 'side-bar', 'sideBar',
  'nav-menu', 'main-menu', 'navigation-menu', 'mobile-nav',
  'channels-nav', 'topics-nav', 'nav-topics',
  'footer-wrap', 'post-footer', 'site-footer', 'footer', 'footnote', 'copyright',
  'content-column-post-footer', 'content-column-mobile-footer',
  'subscribe-widget', 'widget-area', 'subscribe-',
  'ad-container', 'ad-slot', 'ads-box', 'advertisement',
  'adsbygoogle', 'google-ad', 'google-ads',
  'dfp-ad', 'dfp-unit', 'gpt-ad', 'div-gpt-ad',
  'ad-wrapper', 'ad-panel', 'ad-frame', 'ad-box', 'ad-inner', 'ad-holder',
  'ad-banner', 'ad-placeholder', 'ad-label', 'ad-unit', 'ad-widget', 'ad-area',
  'ad-div', 'ad-code', 'ad-block', 'ad-content', 'ad-outer',
  'adslot', 'adunit', 'adbox', 'advert', 'advertorial', 'adv',
  'display-ad', 'display-ads', 'header-ad', 'footer-ad', 'sticky-ad',
  'in-article-ad', 'inline-ad', 'incontent-ad', 'incontent-ads',
  'ezoic-ad', 'ezoic-pub', 'freestar-ad',
  'leaderboard', 'skyscraper',
  'taboola', 'taboola-widget', 'trc',
  'outbrain', 'outbrain-widget', 'ob-widget',
  'mgid', 'mgbox', 'marketgid',
  'revcontent', 'rev-content',
  'zergnet', 'zergnet-widget',
  'rc-widget',
  'native-ad', 'nativead', 'native-ads',
  'content-recommendation', 'recommended-content',
  'sponsored', 'sponsored-content', 'sponsored-post', 'sponsored-link', 'sponsored-links',
  'promoted', 'promoted-content', 'promoted-post',
  'paid-content', 'paid-post',
  'affiliate', 'affiliate-link',
  'commercial', 'commercial-content',
  'cookie-consent', 'cookie-banner', 'cookie-notice', 'cookie-policy', 'cookie-table', 'cookie-settings',
  'cookie-bar', 'cookie-box', 'cookie-modal', 'cookie-container', 'cookie-popup', 'cookie-overlay', 'cookie-wrapper',
  'cookie-law', 'cookie-disclaimer', 'cookie-management', 'cookie-accept', 'cookie-compliance', 'cookie-control',
  'cookies-modal', 'cookies-wrapper', 'cookie__wrap', 'coockies',
  'modal-cookie', 'modal-cookies', 'cookie-div',
  'cc-window', 'cc-banner', 'cc-overlay', 'cc-container', 'cc-floating',
  'cmpbox', 'cmpwrapper', 'cmp',
  'klaro',
  'onetrust-banner', 'onetrust-pc', 'onetrust-overlay',
  'ot-sdk', 'ot-pc', 'onetrust', 'ot-cookie', 'ot-policy', 'ot-category', 'ot-floating',
  'borlabs-cookie', 'brlbs',
  'cmplz', 'cmplz-cookie', 'cmplz-manage',
  'moove-gdpr',
  'cli-modal', 'cli-popup', 'cli-bar', 'wt-cli',
  'cky-consent', 'cky-notice', 'cky-modal', 'cky-banner',
  'wpfront-notification-bar',
  'gdpr', 'gdpr-banner', 'gdpr-consent', 'gdpr-modal', 'gdpr-overlay', 'gdpr-mask',
  'privacy', 'privacy-policy', 'privacy-notice', 'privacy-pref', 'privacy-popup', 'privacy-modal', 'privacy-info',
  'data-protection', 'data-privacy', 'data-consent',
  'consent', 'consent-banner', 'consent-container', 'consent-modal', 'consent-overlay',
  'consent-popup', 'consent-wrapper', 'outer-consent',
  'opt-in', 'optin',
  'eucookie', 'euc', 'cnil', 'ccpa', 'lgpd', 'rodo',
  'hinweis', 'confidentialite',
  'disclaimer', 'disclamer', 'disclaimer-container',
  'cookieman', 'cookiemgmt', 'cookie-management',
  'cbar', 'cono', 'coo', 'cook',
  'lawdiv', 'cookie-law-info',
  'banner-ad',
  'popup-overlay', 'modal-dialog', 'modal-backdrop',
  'social-share', 'share-buttons',
  'breadcrumb', 'byline', 'post-meta', 'author-box',
  'trending-stories', 'tns-trending-stories-block', 'related-posts',
  'related-articles', 'related-content', 'more-stories', 'more-articles',
  'also-read', 'you-may-like', 'read-next',
  'comment-list', 'comment-section', 'comment-area', 'comment-module',
  'comment-wrapper', 'comment-body', 'comment-content', 'comment-form',
  'comment-reply', 'comment-thread', 'comment-holder', 'comment-entry',
  'comments-area', 'comments-section', 'comments-wrapper',
  'commentlist', 'discussion',
  'search-form', 'search-box', 'search-bar', 'searchbar', 'search-input',
  'search-wrapper', 'search-widget', 'search-container', 'search-results',
  'login-form', 'login-box', 'login-bar', 'loginbar',
  'signin-form', 'signup-form', 'register-form', 'registration',
  'auth-form', 'auth-box', 'user-area', 'user-menu', 'user-profile',
  'member-area', 'membership',
  'newsletter-signup', 'newsletter-form', 'newsletter-subscribe',
  'newsletter-popup', 'newsletter-overlay', 'newsletter-modal',
  'email-signup', 'email-subscribe', 'email-capture', 'signup-form',
  'pagination', 'pager', 'paging', 'page-nav', 'page-numbers',
  'nav-links', 'post-navigation',
  'toc', 'table-of-contents', 'toc-container', 'toc-widget',
  'lang-switcher', 'language-switcher', 'language-selector',
  'lang-select', 'lang-selector', 'locale-switcher', 'locale-selector',
  'tagcloud', 'tags-list', 'tag-list', 'categories-list', 'category-list',
  'taxonomy-list', 'meta-tags', 'entry-tags',
  'captcha', 'g-recaptcha', 'recaptcha', 'h-captcha', 'hcaptcha', 'turnstile',
  'post-date', 'entry-date', 'entry-time', 'published-date', 'published-time',
  'posted-on', 'updated-on',
  'print-only', 'print-version', 'printable',
  'site-header', 'site-top', 'top-bar', 'topbar', 'masthead',
  'site-branding', 'site-logo', 'header-top', 'header-main',
  'rating-widget', 'rating-box', 'rating-container', 'star-rating', 'user-rating',
  'review-widget', 'review-box', 'review-form', 'reviews-widget', 'reviews-list',
  'poll', 'voting', 'vote-widget', 'survey',
  'exit-popup', 'exit-intent', 'welcome-popup', 'welcome-mat',
  'notranslate'
];

// 网站特定规则缓存
let cachedRule: SiteRule | null = null;
let cachedUrl: string | null = null;

function getSiteRule(): SiteRule | null {
  const currentUrl = window.location.href;
  if (cachedUrl === currentUrl) {
    return cachedRule;
  }
  const matched = matchSiteRule(currentUrl);
  cachedUrl = currentUrl;
  cachedRule = matched?.siteRule || null;
  return cachedRule;
}

function shouldSkipByClass(el: Element): boolean {
  if (!el.className || typeof el.className !== 'string') return false;
  const className = el.className.toLowerCase();
  const classList = className.split(/\s+/);
  const match = SKIP_CLASS_PATTERNS.some(pattern =>
    classList.some(cls =>
      cls === pattern ||
      cls.startsWith(pattern + '-') ||
      cls.startsWith(pattern + '_') ||
      cls.endsWith('-' + pattern) ||
      cls.endsWith('_' + pattern)
    )
  );
  return match;
}

function shouldSkipBySiteRules(el: Element): boolean {
  const rule = getSiteRule();
  if (!rule?.skipSelectors) return false;
  
  for (const selector of rule.skipSelectors) {
    if (el.closest(selector)) return true;
  }
  return false;
}

function isElementHidden(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    if (current.tagName === 'HTML' || current.tagName === 'BODY') return false;
    if (current.hasAttribute('hidden')) return true;
    if (current.getAttribute('aria-hidden') === 'true') return true;
    if (current instanceof HTMLElement) {
      const s = current.style;
      if (s.display === 'none' || s.visibility === 'hidden') return true;
    }
    current = current.parentElement;
  }
  return false;
}

function isValidText(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_TEXT_LENGTH || trimmed.length >= MAX_TEXT_LENGTH) {
    return false;
  }
  // Generic filters for non-user-readable noise that occasionally appears in
  // the DOM (Sentry/Webpack chunk tables, minified JS, base64 blobs, etc.).
  // These heuristic thresholds are deliberately loose to avoid false
  // positives on normal text.
  //   - ≥ 8 repeated ["x", 1234] tuples
  //   - 200+ chars of base64-ish characters with no whitespace
  const tupleMatches = trimmed.match(/\[\s*['"][^'"]+['"]\s*,\s*-?\d+(?:\.\d+)?\s*\]/g);
  if (tupleMatches && tupleMatches.length >= 8) return false;
  if (/^[A-Za-z0-9+/=_-]{200,}$/.test(trimmed)) return false;

  // Site-specific text patterns declared in the active SiteRule
  // (e.g. Reddit's Sentry SML.load chunk list).
  const rule = getSiteRule();
  if (rule?.skipTextPatterns) {
    for (const pattern of rule.skipTextPatterns) {
      try {
        if (new RegExp(pattern, 'i').test(trimmed)) return false;
      } catch {
        // Invalid regex — ignore rather than crash extraction.
      }
    }
  }
  return true;
}

function isNonHTMLNamespace(el: Element): boolean {
  return el.namespaceURI !== null && el.namespaceURI !== XHTML_NAMESPACE;
}

const ARTICLE_CONTAINER_CLASS_PATTERNS = [
  'article-content',
  'article-body',
  'article-text',
  'story-content',
  'story-body',
  'story-text',
  'main-content',
  'content-body',
  'content-area',
  'post-content',
  'entry-content',
  'page-content',
];

function isInsideArticle(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'article') return true;
    const role = current.getAttribute('role');
    if (role === 'article' || role === 'main') return true;
    if (current.hasAttribute('lang') && tag !== 'html' && tag !== 'body') return true;
    
    // 检查常见文章容器类名
    const className = current.className.toLowerCase();
    const classList = className.split(/\s+/);
    for (const pattern of ARTICLE_CONTAINER_CLASS_PATTERNS) {
      if (classList.some(cls => 
        cls === pattern || 
        cls.startsWith(pattern + '-') || 
        cls.startsWith(pattern + '_') ||
        cls.endsWith('-' + pattern) ||
        cls.endsWith('_' + pattern)
      )) {
        return true;
      }
    }
    
    current = current.parentElement;
  }
  return false;
}

interface ChildClassification {
  hasDirectText: boolean;
  hasNonInlineChild: boolean;
  hasNonEmptyElement: boolean;
  hasOnlyInlineChildren: boolean;
}

function classifyChildren(el: Element): ChildClassification {
  let hasDirectText = false;
  let hasNonEmptyElement = false;
  let hasOnlyInlineChildren = true;

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      hasDirectText = true;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const childTag = (child as Element).tagName.toLowerCase();
      if ((child as Element).textContent?.trim()) {
        hasNonEmptyElement = true;
      }
      if (!INLINE_SET.has(childTag)) {
        hasOnlyInlineChildren = false;
      }
    }
  }

  const hasNonInlineChild = !hasOnlyInlineChildren;

  return { hasDirectText, hasNonInlineChild, hasNonEmptyElement, hasOnlyInlineChildren };
}

function getXPath(node: Node): string {
  if (node.nodeType === Node.DOCUMENT_NODE) return '';
  if (!(node instanceof Element)) return '';

  const parts: string[] = [];
  let current: Element | null = node;

  while (current && current.nodeType === Node.ELEMENT_NODE) {
    let index = 1;
    let sibling = current.previousElementSibling;

    while (sibling) {
      if (sibling.tagName === current.tagName) index++;
      sibling = sibling.previousElementSibling;
    }

    parts.unshift(`${current.tagName.toLowerCase()}[${index}]`);
    current = current.parentElement;
  }

  return '/' + parts.join('/');
}

function getHeadingPath(block: Element): string[] {
  const headings: string[] = [];
  let current: Element | null = block;

  while (current) {
    const prevHeading = findPreviousHeading(current);
    if (prevHeading) {
      headings.unshift(prevHeading.textContent?.trim() || '');
      current = prevHeading;
    } else {
      break;
    }
  }

  return headings;
}

function findPreviousHeading(element: Element): Element | null {
  let current: Node | null = element;

  while (current) {
    while (current.previousSibling) {
      current = current.previousSibling;
      if (current.nodeType === Node.ELEMENT_NODE) {
        const el = current as Element;
        if (/^H[1-6]$/.test(el.tagName)) return el;
        const found = findLastHeading(el);
        if (found) return found;
      }
    }
    current = current.parentElement;
  }

  return null;
}

function findLastHeading(element: Element): Element | null {
  const children = Array.from(element.children).reverse();
  for (const child of children) {
    if (/^H[1-6]$/.test(child.tagName)) return child;
    const found = findLastHeading(child);
    if (found) return found;
  }
  return null;
}

function hasBlockLevelParent(el: Element): boolean {
  let current: Element | null = el.parentElement;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (DIRECT_SET.has(tag)) return true;
    if (tag === 'body' || tag === 'html') return false;
    current = current.parentElement;
  }
  return false;
}

function isContentEditable(el: Element): boolean {
  return !!(el as HTMLElement).isContentEditable || el.getAttribute('contenteditable') === 'true';
}

function hasTranslateBlockClass(el: Element): boolean {
  return el.classList?.contains('fanyi-bilingual-block') || el.classList?.contains('notranslate');
}

function grabNode(node: Node): Element | false {
  if (!node || node instanceof Text) return false;
  if (!(node instanceof Element)) return false;

  const el = node;
  const tag = el.tagName.toLowerCase();

  if (isNonHTMLNamespace(el)) return false;
  if (SKIP_SET.has(tag)) return false;
  if (SEMANTIC_SKIP_TAGS.has(tag)) return false;
  if (hasTranslateBlockClass(el)) return false;
  if (isContentEditable(el)) return false;
  if (isElementHidden(el)) return false;
  if (shouldSkipByClass(el)) return false;
  if (shouldSkipBySiteRules(el)) return false;

  if (DIRECT_SET.has(tag)) {
    const hasDirectSetDescendant = el.querySelector(
      Array.from(DIRECT_SET).join(',')
    ) !== null;
    if (hasDirectSetDescendant) return false;
    return isValidText(el.textContent) ? el : false;
  }

  if (INLINE_SET.has(tag) && isInsideArticle(el) && !hasBlockLevelParent(el)) {
    return isValidText(el.textContent) ? el : false;
  }

  if (INLINE_SET.has(tag)) return false;

  const { hasDirectText, hasNonInlineChild } = classifyChildren(el);

  if (hasNonInlineChild) return false;

  if (hasDirectText) {
    return isValidText(el.textContent) ? el : false;
  }

  return false;
}

function acceptWalkerNode(
  node: Node,
  counters: { rejected: number; skipped: number; accepted: number }
): number {
  if (node instanceof Text) {
    return NodeFilter.FILTER_ACCEPT;
  }

  if (!(node instanceof Element)) {
    return NodeFilter.FILTER_SKIP;
  }

  const el = node;
  const tag = el.tagName.toLowerCase();

  if (isNonHTMLNamespace(el)) {
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  if (SKIP_SET.has(tag) || hasTranslateBlockClass(el) || isContentEditable(el)) {
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  if (isElementHidden(el)) {
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  if (shouldSkipByClass(el)) {
    counters.rejected++;
    return NodeFilter.FILTER_REJECT;
  }

  if (SEMANTIC_SKIP_TAGS.has(tag)) {
    counters.skipped++;
    return NodeFilter.FILTER_REJECT;
  }

  if (DIRECT_SET.has(tag)) {
    if (isValidText(el.textContent)) {
      counters.accepted++;
      return NodeFilter.FILTER_ACCEPT;
    }
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;
  }

  const { hasDirectText, hasNonEmptyElement, hasOnlyInlineChildren } = classifyChildren(el);

  if (!hasOnlyInlineChildren) {
    counters.skipped++;
    return NodeFilter.FILTER_SKIP;
  }

  if (hasDirectText || hasNonEmptyElement) {
    if (isValidText(el.textContent)) {
      counters.accepted++;
      return NodeFilter.FILTER_ACCEPT;
    }
  }

  counters.skipped++;
  return NodeFilter.FILTER_SKIP;
}

function collectBlocksFromRoot(
  startNode: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number }
): { rejected: number; skipped: number; accepted: number } {
  const counters = { rejected: 0, skipped: 0, accepted: 0 };
  const walker = document.createTreeWalker(
    startNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    { acceptNode: (node) => acceptWalkerNode(node, counters) }
  );

  let currentNode: Node | null;
  while ((currentNode = walker.nextNode()) !== null) {
    const translateNode = grabNode(currentNode);
    if (translateNode) {
      const text = translateNode.textContent?.trim();
      if (text) {
        const id = `b${++blockIdRef.value}`;
        if (translateNode instanceof HTMLElement) {
          translateNode.dataset.fanyiBlockId = id;
        }
        blocks.push({
          id,
          xpath: getXPath(translateNode),
          tag: translateNode.tagName.toLowerCase(),
          text,
          context: {
            headingPath: getHeadingPath(translateNode),
            position: blockIdRef.value,
          },
        });
      }
    }
  }

  // TreeWalker doesn't cross shadow root boundaries. Walk open shadow roots
  // explicitly so we can pick up text inside web components like Reddit's
  // <shreddit-post>.
  collectFromShadowHosts(startNode, blocks, blockIdRef);

  return counters;
}

function collectFromShadowHosts(
  root: Node,
  blocks: TextBlock[],
  blockIdRef: { value: number }
): void {
  // jsdom's TreeWalker skips nodes whose acceptNode returns FILTER_SKIP
  // (it should still visit them per spec but does not). Use a permissive
  // filter (FILTER_ACCEPT for everything) so the host element itself is
  // returned and we can inspect its shadowRoot.
  const treeWalker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: () => NodeFilter.FILTER_ACCEPT,
    }
  );

  let currentNode: Node | null;
  while ((currentNode = treeWalker.nextNode()) !== null) {
    if (!(currentNode instanceof Element)) continue;
    const shadow = currentNode.shadowRoot;
    if (shadow && shadow.mode === 'open') {
      collectBlocksFromRoot(shadow, blocks, blockIdRef);
    }
  }
}

export function extractBlocks(rootNode: Node): TextBlock[] {
  const blocks: TextBlock[] = [];
  const blockIdRef = { value: 0 };

  const startNode = rootNode instanceof Document ? (rootNode.body || rootNode.documentElement) : rootNode;
  if (!startNode) {
    console.warn('[BlockExtractor] No valid start node found');
    return [];
  }

  collectBlocksFromRoot(startNode, blocks, blockIdRef);
  return blocks;
}

export function findBlockNode(block: TextBlock, root: Document): Node | null {
  // 优先通过临时的 data 属性查找，更健壮
  const el = root.querySelector(`[data-fanyi-block-id="${block.id}"]`);
  if (el) {
    return el;
  }
  // 回退到 XPath 查找
  try {
    const result = root.evaluate(
      block.xpath,
      root,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null
    );
    return result.singleNodeValue;
  } catch {
    return null;
  }
}

export function buildNodeMap(
  blocks: TextBlock[],
  root: Document
): Map<string, Node> {
  const map = new Map<string, Node>();

  for (const block of blocks) {
    const node = findBlockNode(block, root);
    if (node) {
      map.set(block.id, node);
    }
  }

  return map;
}
