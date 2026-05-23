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
    // 检查元素本身是否匹配
    if (el.matches(selector)) return true;
    // 检查祖先元素是否匹配
    if (el.closest(selector)) return true;
  }
  return false;
}

function isInArticleContext(el: Element): boolean {
  let current: Element | null = el;
  while (current) {
    if (current.tagName.toLowerCase() === 'article') return true;
    const role = current.getAttribute('role');
    if (role === 'article') return true;
    current = current.parentElement;
  }
  return false;
}

const INLINE_SET = new Set([
  'a', 'b', 'strong', 'span', 'em', 'i', 'u', 'small', 'sub', 'sup',
  'font', 'mark', 'cite', 'q', 'abbr', 'time', 'ruby', 'bdi', 'bdo',
  'img', 'br', 'wbr', 'svg'
]);

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

function isInsideContentContainer(el: Element): boolean {
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

function grabNode(node: Node): Element | false {
  if (!node || node instanceof Text) return false;
  if (!(node instanceof Element)) return false;

  const tag = node.tagName.toLowerCase();

  if (SKIP_SET.has(tag)) return false;
  if (node.classList?.contains('notranslate')) return false;
  if (shouldSkipByClass(node) && !isInArticleContext(node)) return false;
  if (node.isContentEditable || node.getAttribute('contenteditable') === 'true') return false;
  if (tag === 'header' || tag === 'footer' || tag === 'aside' || tag === 'nav') return false;
  if (shouldSkipBySiteRules(node)) return false;

  if (DIRECT_SET.has(tag)) {
    const text = node.textContent?.trim();
    if (text && text.length >= 3 && text.length < 3072) {
      return node;
    }
    return false;
  }

  // 内联元素：只有当它不在 DIRECT_SET 父元素内部时才单独提取
  // 例如：<p><a>text</a></p> - <a> 不单独提取，因为 <p> 会提取完整文本
  // 例如：<article><div><span>text</span></div></article> - <span> 需要提取
  if (INLINE_SET.has(tag) && isInsideContentContainer(node)) {
    // 检查是否有 DIRECT_SET 的父元素
    if (!hasBlockLevelParent(node)) {
      const text = node.textContent?.trim();
      if (text && text.length >= 3 && text.length < 3072) {
        return node;
      }
    }
  }

  if (INLINE_SET.has(tag)) return false;

  let hasDirectText = false;
  let hasNonInlineChild = false;
  
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE && child.textContent?.trim()) {
      hasDirectText = true;
    }
    if (child.nodeType === Node.ELEMENT_NODE) {
      const childTag = (child as Element).tagName.toLowerCase();
      if (!INLINE_SET.has(childTag)) {
        hasNonInlineChild = true;
      }
    }
  }

  if (hasNonInlineChild) {
    console.log('[BlockExtractor] grabNode REJECT (hasNonInlineChild):', tag, 'children:', Array.from(node.childNodes).map(c => c instanceof Element ? c.tagName : '#text').join(', '));
    return false;
  }

  if (hasDirectText) {
    const text = node.textContent?.trim();
    if (text && text.length >= 3 && text.length < 3072) {
      console.log('[BlockExtractor] grabNode ACCEPT:', tag, 'text:', text.substring(0, 50));
      return node;
    }
  }

  console.log('[BlockExtractor] grabNode REJECT (no direct text):', tag, 'hasDirectText:', hasDirectText, 'hasNonInlineChild:', hasNonInlineChild);
  return false;
}

export function extractBlocks(rootNode: Node): TextBlock[] {
  const blocks: TextBlock[] = [];
  let blockId = 0;
  let skippedCount = 0;
  let rejectedCount = 0;
  let acceptedCount = 0;

  const startNode = rootNode instanceof Document ? (rootNode.body || rootNode.documentElement) : rootNode;
  if (!startNode) {
    console.warn('[BlockExtractor] No valid start node found');
    return [];
  }

  const walker = document.createTreeWalker(
    startNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node: Node): number => {
        if (node instanceof Text) {
          return NodeFilter.FILTER_ACCEPT;
        }

        if (!(node instanceof Element)) {
          return NodeFilter.FILTER_SKIP;
        }

        const el = node as Element;
        const tag = el.tagName.toLowerCase();

        // 添加日志追踪 p 标签
        if (tag === 'p') {
          console.log('[BlockExtractor] acceptNode - Found P tag:', el.textContent?.substring(0, 30), 'class:', el.className, 'has parent article:', isInArticleContext(el));
        }

        if (SKIP_SET.has(tag) || el.classList?.contains('notranslate') || el.classList?.contains('fanyi-bilingual-block') || el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
          rejectedCount++;
          return NodeFilter.FILTER_REJECT;
        }
        // 只在非 article 上下文中检查 class-based skipping
        // 在 article 内部，我们信任所有内容
        if (shouldSkipByClass(el) && !isInArticleContext(el)) {
          if (tag === 'p') {
            console.log('[BlockExtractor] acceptNode - P tag REJECTED by shouldSkipByClass');
          }
          rejectedCount++;
          return NodeFilter.FILTER_REJECT;
        }
        if (tag === 'header' || tag === 'footer' || tag === 'aside' || tag === 'nav') {
          skippedCount++;
          return NodeFilter.FILTER_REJECT;
        }

  // DIRECT_SET 标签直接接受，不检查子元素类型
        if (DIRECT_SET.has(tag)) {
          const text = el.textContent?.trim();
          if (text && text.length >= 3 && text.length < 3072) {
            acceptedCount++;
            return NodeFilter.FILTER_ACCEPT;
          }
          skippedCount++;
          return NodeFilter.FILTER_SKIP;
        }

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

        // 如果有块级子元素，跳过当前节点（让子元素被单独处理）
        if (!hasOnlyInlineChildren) {
          skippedCount++;
          return NodeFilter.FILTER_SKIP;
        }

        // 如果有内联子元素且有文本，接受当前节点（获取完整段落文本）
        if (hasDirectText || hasNonEmptyElement) {
          const text = el.textContent?.trim();
          if (text && text.length >= 3 && text.length < 3072) {
            acceptedCount++;
            return NodeFilter.FILTER_ACCEPT;
          }
        }

        skippedCount++;
        return NodeFilter.FILTER_SKIP;
      }
    }
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
      // 不要手动修改 walker.currentNode
      // TreeWalker 会自动处理遍历，我们只需要处理 acceptNode 返回值
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
