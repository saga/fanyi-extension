import { matchSiteRule, type SiteRule } from '../../rules';

export interface TextBlock {
  id: string;
  xpath: string;
  tag: string;
  text: string;
  element?: WeakRef<Element>;  // 直接保存节点引用，避免 XPath 查询
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
  'dt'
]);

const SEMANTIC_SKIP_TAGS = new Set(['header', 'footer', 'aside', 'nav']);

const INLINE_SET = new Set([
  'a', 'b', 'strong', 'span', 'em', 'i', 'u', 'small', 'sub', 'sup',
  'font', 'mark', 'cite', 'q', 'abbr', 'time', 'ruby', 'bdi', 'bdo',
  'img', 'br', 'wbr', 'svg'
]);

const SKIP_CLASS_PATTERNS = [
  'sidebar', 'side-bar', 'sideBar',
  'nav-menu', 'main-menu', 'navigation-menu',
  'footer-wrap', 'post-footer', 'site-footer', 'footnote', 'copyright',
  'subscribe-widget', 'widget-area',
  'ad-container', 'ad-slot', 'ads-box', 'advertisement',
  'cookie-consent', 'gdpr-banner', 'banner-ad',
  'popup-overlay', 'modal-dialog', 'modal-backdrop',
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
    classList.some(cls => cls === pattern || cls.startsWith(pattern + '-') || cls.startsWith(pattern + '_'))
  );
  return match;
}

function shouldSkipBySiteRules(el: Element): boolean {
  const rule = getSiteRule();
  if (!rule?.skipSelectors) return false;
  
  for (const selector of rule.skipSelectors) {
    if (el.matches(selector)) return true;
    if (el.closest(selector)) return true;
  }
  return false;
}

function isValidText(text: string | undefined | null): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return trimmed.length >= MIN_TEXT_LENGTH && trimmed.length < MAX_TEXT_LENGTH;
}

function isNonHTMLNamespace(el: Element): boolean {
  return el.namespaceURI !== null && el.namespaceURI !== XHTML_NAMESPACE;
}

function isInsideArticle(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'article') return true;
    const role = current.getAttribute('role');
    if (role === 'article' || role === 'main') return true;
    if (current.hasAttribute('lang')) return true;
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
  if (shouldSkipByClass(el) && !isInsideArticle(el)) return false;
  if (shouldSkipBySiteRules(el)) return false;

  if (DIRECT_SET.has(tag)) {
    const hasDirectSetChild = Array.from(el.children).some(
      (child) => DIRECT_SET.has(child.tagName.toLowerCase())
    );
    if (hasDirectSetChild) return false;
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

  if (shouldSkipByClass(el) && !isInsideArticle(el)) {
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

export function extractBlocks(rootNode: Node): TextBlock[] {
  const blocks: TextBlock[] = [];
  let blockId = 0;
  const counters = { rejected: 0, skipped: 0, accepted: 0 };

  const startNode = rootNode instanceof Document ? (rootNode.body || rootNode.documentElement) : rootNode;
  if (!startNode) {
    console.warn('[BlockExtractor] No valid start node found');
    return [];
  }

  const walker = document.createTreeWalker(
    startNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    { acceptNode: (node) => acceptWalkerNode(node, counters) }
  );

  let currentNode: Node | null;
  while (currentNode = walker.nextNode()) {
    const translateNode = grabNode(currentNode);
    if (translateNode) {
      const text = translateNode.textContent?.trim();
      if (text) {
        const id = `b${++blockId}`;
        blocks.push({
          id,
          xpath: getXPath(translateNode),
          tag: translateNode.tagName.toLowerCase(),
          text,
          context: {
            headingPath: getHeadingPath(translateNode),
            position: blockId,
          },
        });
      }
    }
  }

  return blocks;
}

export function findBlockNode(block: TextBlock, root: Document): Node | null {
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
