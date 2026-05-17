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

const DIRECT_SET = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'li', 'dd', 'blockquote',
  'figcaption'
]);

const SKIP_SET = new Set([
  'html', 'body', 'script', 'style', 'noscript', 'iframe',
  'input', 'textarea', 'select', 'button', 'code', 'pre'
]);

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

function grabNode(node: Node): Element | false {
  if (!node || node instanceof Text) return false;
  if (!(node instanceof Element)) return false;

  const tag = node.tagName.toLowerCase();

  if (SKIP_SET.has(tag)) return false;
  if (node.classList?.contains('notranslate')) return false;
  if (node.isContentEditable) return false;
  if (tag === 'header' || tag === 'footer') return false;

  if (DIRECT_SET.has(tag)) {
    const text = node.textContent?.trim();
    if (text && text.length >= 3 && text.length < 3072) {
      return node;
    }
    return false;
  }

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

  if (hasNonInlineChild) return false;

  if (hasDirectText) {
    const text = node.textContent?.trim();
    if (text && text.length >= 3 && text.length < 3072) {
      return node;
    }
  }

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

  console.log('[BlockExtractor] Starting extraction from:', startNode.nodeName);

  const walker = document.createTreeWalker(
    startNode,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node: Node): number => {
        if (node instanceof Text) {
          return NodeFilter.FILTER_ACCEPT;
        }

        if (!(node instanceof Element)) return NodeFilter.FILTER_SKIP;

        const el = node as Element;
        const tag = el.tagName.toLowerCase();

        if (SKIP_SET.has(tag) || el.classList?.contains('notranslate') || el.isContentEditable) {
          rejectedCount++;
          return NodeFilter.FILTER_REJECT;
        }
        if (tag === 'header' || tag === 'footer') {
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
      // 跳过已确定要翻译的节点的所有子节点
      walker.currentNode = currentNode.nextSibling || currentNode;
    }
  }

  console.log(`[BlockExtractor] Extraction complete: accepted=${acceptedCount}, skipped=${skippedCount}, rejected=${rejectedCount}, totalBlocks=${blocks.length}`);
  if (blocks.length > 0) {
    console.log('[BlockExtractor] First 3 blocks:', blocks.slice(0, 3).map(b => ({ id: b.id, tag: b.tag, text: b.text.substring(0, 50) })));
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
