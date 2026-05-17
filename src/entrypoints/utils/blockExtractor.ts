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
    NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node: Node): number => {
        const el = node as Element;
        const tag = el.tagName.toLowerCase();

        if (SKIP_SET.has(tag)) { skippedCount++; return NodeFilter.FILTER_SKIP; }
        if (el.classList?.contains('notranslate')) { rejectedCount++; return NodeFilter.FILTER_REJECT; }
        if (el.isContentEditable) { rejectedCount++; return NodeFilter.FILTER_REJECT; }
        if (tag === 'header' || tag === 'footer') { skippedCount++; return NodeFilter.FILTER_SKIP; }

        let hasDirectText = false;
        let hasNonInlineChild = false;
        
        for (const child of Array.from(el.childNodes)) {
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

        if (hasNonInlineChild) { skippedCount++; return NodeFilter.FILTER_SKIP; }

        if (hasDirectText) {
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

  let currentNode: Element | null;
  while (currentNode = walker.nextNode() as Element) {
    const text = currentNode.textContent?.trim();
    if (text) {
      const id = `b${++blockId}`;
      blocks.push({
        id,
        xpath: getXPath(currentNode),
        tag: currentNode.tagName.toLowerCase(),
        text,
        context: {
          headingPath: getHeadingPath(currentNode),
          position: blockId,
        },
      });
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
